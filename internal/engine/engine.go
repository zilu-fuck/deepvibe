package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	contextbuilder "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/config"
	gitmanager "github.com/zilu-fuck/deepvibe/internal/git"
	"github.com/zilu-fuck/deepvibe/internal/llm"
	"github.com/zilu-fuck/deepvibe/internal/middleware"
	"github.com/zilu-fuck/deepvibe/internal/model"
	"github.com/zilu-fuck/deepvibe/internal/patcher"
	"github.com/zilu-fuck/deepvibe/internal/scanner"
	"github.com/zilu-fuck/deepvibe/internal/tools"
)

type Engine interface {
	Run(ctx context.Context, opts RunOptions) (*Result, error)
	GeneratePlan(ctx context.Context, opts PlanOptions) (*Plan, error)
	ExecutePlan(ctx context.Context, plan *Plan, opts ExecuteOptions) (*PlanResult, error)
	PrepareExecution(ctx context.Context, opts RunOptions) (*PreparedExecution, error)
	ApplyPreparedExecution(ctx context.Context, prepared *PreparedExecution) (*Result, error)
}

type ExecutionProfile string

const (
	ProfileDefault ExecutionProfile = "default"
	ProfileFlash   ExecutionProfile = "flash"
	ProfileDeep    ExecutionProfile = "deep"
)

type RunOptions struct {
	CWD         string
	DryRun      bool
	Instruction string
	PlanMode    bool
	Profile     ExecutionProfile
	Force       bool
}

type PlanOptions = RunOptions

type ExecuteOptions struct {
	CWD     string
	DryRun  bool
	Force   bool
	Profile ExecutionProfile
}

type Result struct {
	Candidates    []string
	ChangeKind    string
	ChangeReference string
	Message       string
	FilesChanged  []string
	CommitHash    string
	ContextTokens  int
	MaxPromptTokens int
	ScannedFiles   int
	ToolCallsUsed  bool
	ToolMutations  []tools.AppliedFileChange
}

type PreparedExecution struct {
	ConfigProjectPath string
	Context           *contextbuilder.BuildResult
	CWD               string
	HasAPIKey         bool
	Instruction       string
	ParsedResponse    *llm.ParsedModelResponse
	Profile           model.Profile
	RepositoryState   gitmanager.RepositoryState
	ScanResult        *scanner.Result
	SearchResults     []tools.WebSearchResult
	ToolCallsUsed     bool
	ToolMutations     []tools.AppliedFileChange
}

type Plan struct {
	Overview string
	Steps    []PlanStep
	Notes    string
}

type PlanStep struct {
	Index            int
	Description      string
	Files            []string
	EstimatedChanges string
}

type PlanResult struct {
	Message string
	Steps   []PlanStepResult
}

type PlanStepResult struct {
	Index  int
	Status string
	Error  string
}

type Event struct {
	Payload map[string]any
	Type    string
}

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string {
	return e.Message
}

type Dependencies struct {
	ClientFactory func(apiKey string) llm.Client
	CommandApproval tools.CommandApprovalHandler
	CommandRunner   tools.CommandRunner
	CreateTools     func(tools.ExecutionContext) []tools.Tool
	EmitEvent       func(Event)
	ExecutionMode   string
	ParseResponse   func(llm.DeepSeekCompletionResult) llm.ParseOutcome
	RepairRetryLimit int
	SearchWeb       tools.SearchFunc
}

type Core struct {
	dependencies Dependencies
}

func New(dependencies Dependencies) *Core {
	return &Core{dependencies: dependencies}
}

func (e *Core) Run(ctx context.Context, opts RunOptions) (*Result, error) {
	var err error
	opts, err = normalizeRunOptions(opts)
	if err != nil {
		return nil, err
	}
	if opts.DryRun {
		prepared, err := e.prepareContext(ctx, opts)
		if err != nil {
			return nil, err
		}
		return &Result{
			Candidates: prepared.ScanResult.Candidates,
			Message: fmt.Sprintf(
				"Dry run ready: instruction=%q profile=%s/%s apiKeyConfigured=%s scannedFiles=%d candidates=%d searchResults=%d contextTokens=%d/%d projectConfig=%s",
				prepared.Instruction,
				prepared.Profile.Model,
				prepared.Profile.ReasoningEffort,
				yesNo(prepared.HasAPIKey),
				prepared.ScanResult.ScannedFiles,
				len(prepared.ScanResult.Candidates),
				len(prepared.SearchResults),
				prepared.Context.TokenEstimate,
				prepared.Context.MaxPromptTokens,
				noneIfEmpty(prepared.ConfigProjectPath),
			),
			ContextTokens: prepared.Context.TokenEstimate,
			MaxPromptTokens: prepared.Context.MaxPromptTokens,
			ScannedFiles:  prepared.ScanResult.ScannedFiles,
		}, nil
	}

	prepared, err := e.PrepareExecution(ctx, opts)
	if err != nil {
		return nil, err
	}
	return e.ApplyPreparedExecution(ctx, prepared)
}

func (e *Core) GeneratePlan(ctx context.Context, opts PlanOptions) (*Plan, error) {
	var err error
	opts, err = normalizeRunOptions(opts)
	if err != nil {
		return nil, err
	}
	prepared, err := e.prepareContext(ctx, opts)
	if err != nil {
		return nil, err
	}

	cfg, err := config.Load(config.LoadOptions{CWD: opts.CWD})
	if err != nil {
		return nil, err
	}
	apiKey, err := config.RequireAPIKey(cfg)
	if err != nil {
		return nil, err
	}
	client := e.client(apiKey)
	result, err := client.CreateCompletion(ctx, toChatMessages(prepared.Context.Messages), llm.CompletionOptions{
		Model:      string(prepared.Profile.Model),
		MaxTokens: 4096,
		ToolChoice: "none",
	})
	if err != nil {
		return nil, err
	}
	planOutcome := llm.ParsePlan(toDeepSeekCompletion(result))
	if !planOutcome.OK {
		return nil, &Error{Code: string(planOutcome.Error.Code), Message: planOutcome.Error.Message}
	}
	return convertPlan(planOutcome.Value), nil
}

func (e *Core) ExecutePlan(ctx context.Context, plan *Plan, opts ExecuteOptions) (*PlanResult, error) {
	if plan == nil {
		return nil, &Error{Code: "PLAN_MISSING", Message: "plan is required"}
	}
	results := make([]PlanStepResult, 0, len(plan.Steps))
	for _, step := range plan.Steps {
		instruction := fmt.Sprintf("[Step %d/%d] %s\n%s", step.Index, len(plan.Steps), step.Description, formatFileRefs(step.Files))
		runResult, err := e.Run(ctx, RunOptions{
			CWD:         opts.CWD,
			DryRun:      opts.DryRun,
			Instruction: instruction,
			Profile:     opts.Profile,
			Force:       opts.Force,
		})
		if err != nil {
			results = append(results, PlanStepResult{Index: step.Index, Status: "failed", Error: err.Error()})
			break
		}
		results = append(results, PlanStepResult{Index: step.Index, Status: "completed", Error: runResult.Message})
	}
	return &PlanResult{Message: "Plan execution finished.", Steps: results}, nil
}

func (e *Core) PrepareExecution(ctx context.Context, opts RunOptions) (*PreparedExecution, error) {
	var err error
	opts, err = normalizeRunOptions(opts)
	if err != nil {
		return nil, err
	}
	prepared, err := e.prepareContext(ctx, opts)
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(config.LoadOptions{CWD: opts.CWD})
	if err != nil {
		return nil, err
	}
	apiKey, err := config.RequireAPIKey(cfg)
	if err != nil {
		return nil, err
	}

	mutationState := tools.NewMutationState()
	execCtx := e.toolExecutionContext(opts, cfg, mutationState)
	registeredTools, execCtx := e.createTools(execCtx)
	completion, toolCallsUsed, err := e.completeWithTools(ctx, apiKey, prepared, registeredTools, execCtx)
	if err != nil {
		_ = tools.RollbackToolMutations(mutationState, opts.CWD)
		return nil, err
	}

	parse := e.dependencies.ParseResponse
	if parse == nil {
		parse = llm.ParseResponse
	}
	parsed, err := e.parseWithRepairRetry(ctx, parse, apiKey, prepared, completion, registeredTools)
	if err != nil {
		_ = tools.RollbackToolMutations(mutationState, opts.CWD)
		return nil, err
	}

	prepared.ParsedResponse = parsed
	prepared.ToolCallsUsed = toolCallsUsed
	prepared.ToolMutations = tools.ListToolMutations(mutationState)
	return prepared, nil
}

func (e *Core) ApplyPreparedExecution(ctx context.Context, prepared *PreparedExecution) (*Result, error) {
	if prepared == nil {
		return nil, &Error{Code: "PREPARED_MISSING", Message: "prepared execution is required"}
	}
	hasDiffWrites := prepared.ParsedResponse != nil && len(prepared.ParsedResponse.Files) > 0
	hasToolWrites := len(prepared.ToolMutations) > 0
	if hasDiffWrites && hasToolWrites {
		return nil, &Error{Code: "MIXED_WRITE_CHANNELS", Message: "Final model response included diff writes even though tool calls already modified files."}
	}

	applied := prepared.ToolMutations
	summary := "No changes were applied."
	if prepared.ParsedResponse != nil && strings.TrimSpace(prepared.ParsedResponse.Summary) != "" {
		summary = prepared.ParsedResponse.Summary
	}
	if hasDiffWrites {
		diffApplied, err := patcher.ApplyFileChanges(prepared.CWD, prepared.ParsedResponse.Files)
		if err != nil {
			return nil, err
		}
		applied = patcherToToolChanges(diffApplied)
	}
	if hasToolWrites {
		summary = fmt.Sprintf("Applied %d tool file change%s.", len(applied), plural(len(applied)))
	}
	changeKind, changeReference, err := e.recordAppliedChanges(ctx, prepared, applied, summary)
	if err != nil {
		return nil, err
	}

	return &Result{
		Candidates: prepared.ScanResult.Candidates,
		ChangeKind: changeKind,
		ChangeReference: changeReference,
		Message: fmt.Sprintf(
			"Scaffold ready: instruction=%q profile=%s/%s apiKeyConfigured=%s scannedFiles=%d candidates=%d searchResults=%d toolCallsUsed=%s contextTokens=%d/%d appliedFiles=%d change=%s summary=%q projectConfig=%s",
			prepared.Instruction,
			prepared.Profile.Model,
			prepared.Profile.ReasoningEffort,
			yesNo(prepared.HasAPIKey),
			prepared.ScanResult.ScannedFiles,
			len(prepared.ScanResult.Candidates),
			len(prepared.SearchResults),
			yesNo(prepared.ToolCallsUsed),
			prepared.Context.TokenEstimate,
			prepared.Context.MaxPromptTokens,
			len(applied),
			formatChange(changeKind, changeReference),
			summary,
			noneIfEmpty(prepared.ConfigProjectPath),
		),
		CommitHash: changeReferenceIfCommit(changeKind, changeReference),
		ContextTokens: prepared.Context.TokenEstimate,
		MaxPromptTokens: prepared.Context.MaxPromptTokens,
		FilesChanged: mutationPaths(applied),
		ScannedFiles: prepared.ScanResult.ScannedFiles,
		ToolCallsUsed: prepared.ToolCallsUsed,
		ToolMutations: applied,
	}, nil
}

func (e *Core) prepareContext(ctx context.Context, opts RunOptions) (*PreparedExecution, error) {
	var err error
	opts, err = normalizeRunOptions(opts)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(opts.Instruction) == "" {
		return nil, &Error{Code: "INSTRUCTION_MISSING", Message: "instruction is required"}
	}
	profile := model.ResolveProfile(model.ExecutionProfile(profileOrDefault(opts.Profile)))
	normalizedInstruction := tools.StripWebSearchTrigger(opts.Instruction)
	cfg, err := config.Load(config.LoadOptions{CWD: opts.CWD})
	if err != nil {
		return nil, err
	}

	e.emit("scan.started", map[string]any{"cwd": opts.CWD})
	searchResults, err := e.search(ctx, cfg, opts.Instruction, normalizedInstruction)
	if err != nil {
		return nil, err
	}
	scanResult, err := scanner.ScanProject(ctx, scanner.Options{
		RootDir:        opts.CWD,
		Instruction:    normalizedInstruction,
		MaxCandidates:  profile.DefaultScanCandidates,
		IgnorePatterns: cfg.Ignore,
	})
	if err != nil {
		return nil, err
	}
	e.emit("scan.completed", map[string]any{"scannedFiles": scanResult.ScannedFiles, "candidates": len(scanResult.Candidates)})

	projectPrompt, err := config.LoadProjectPrompt(opts.CWD)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	buildResult, err := contextbuilder.Build(contextbuilder.BuildOptions{
		RootDir:                filepath.Clean(opts.CWD),
		Instruction:            normalizedInstruction,
		Candidates:             scanResult.Candidates,
		ExplicitPaths:          scanResult.ExplicitPaths,
		MaxFiles:               profile.MaxContextFiles,
		MaxWindowTokens:        profile.ContextLengthTokens,
		ProjectPrompt:          projectPrompt,
		ReservedResponseTokens: profile.ReservedResponseTokens,
		SearchResults:          toContextSearchResults(searchResults),
	})
	if err != nil {
		return nil, err
	}
	e.emit("context.built", map[string]any{"contextTokens": buildResult.TokenEstimate, "maxPromptTokens": buildResult.MaxPromptTokens})

	return &PreparedExecution{
		ConfigProjectPath: cfg.ProjectConfigPath,
		Context:           buildResult,
		CWD:               opts.CWD,
		HasAPIKey:         cfg.APIKey != "",
		Instruction:       normalizedInstruction,
		Profile:           profile,
		RepositoryState:   gitmanager.InspectRepository(ctx, opts.CWD),
		ScanResult:        scanResult,
		SearchResults:     searchResults,
	}, nil
}

func (e *Core) completeWithTools(ctx context.Context, apiKey string, prepared *PreparedExecution, registeredTools []tools.Tool, execCtx tools.ExecutionContext) (llm.DeepSeekCompletionResult, bool, error) {
	client := e.client(apiKey)
	conversation := toChatMessages(prepared.Context.Messages)
	toolDefinitions := toLLMTools(registeredTools)
	toolRegistry := tools.NewRegistry()
	for _, tool := range registeredTools {
		toolRegistry.Register(tool)
	}

	toolCallsUsed := false
	var completion *llm.CompletionResult
	var err error
	for round := 0; round < 5; round++ {
		e.emit("model.requested", map[string]any{"round": round})
		completion, err = client.CreateCompletion(ctx, conversation, llm.CompletionOptions{
			Model: string(prepared.Profile.Model),
			Tools: toolDefinitions,
			ToolChoice: "auto",
		})
		if err != nil {
			return llm.DeepSeekCompletionResult{}, toolCallsUsed, err
		}
		toolCalls := completion.Message.ToolCalls
		if len(toolCalls) == 0 {
			e.emit("model.completed", map[string]any{"round": round, "toolCalls": 0})
			break
		}

		toolCallsUsed = true
		e.emit("tool_calls.requested", map[string]any{"round": round, "count": len(toolCalls)})
		conversation = append(conversation, completion.Message)
		toolResults, err := tools.ExecuteToolCalls(ctx, toolCalls, toolRegistry, execCtx)
		if err != nil {
			return llm.DeepSeekCompletionResult{}, toolCallsUsed, err
		}
		e.emit("tool_calls.completed", map[string]any{"round": round, "count": len(toolResults)})
		for _, result := range toolResults {
			content := result.Content
			conversation = append(conversation, llm.ChatMessage{
				Role:       "tool",
				Content:    &content,
				ToolCallID: result.ToolCallID,
			})
		}
	}
	if completion == nil {
		return llm.DeepSeekCompletionResult{}, toolCallsUsed, &Error{Code: "MODEL_EMPTY", Message: "Model did not return a completion."}
	}
	return toDeepSeekCompletion(completion), toolCallsUsed, nil
}

func (e *Core) parseWithRepairRetry(ctx context.Context, parse func(llm.DeepSeekCompletionResult) llm.ParseOutcome, apiKey string, prepared *PreparedExecution, completion llm.DeepSeekCompletionResult, registeredTools []tools.Tool) (*llm.ParsedModelResponse, error) {
	outcome := parse(completion)
	limit := e.dependencies.RepairRetryLimit
	if limit == 0 {
		limit = 1
	}
	client := e.client(apiKey)
	for attempt := 0; !outcome.OK && outcome.Error != nil && outcome.Error.CanRetry && attempt < limit; attempt++ {
		e.emit("repair.retry", map[string]any{"attempt": attempt + 1, "code": outcome.Error.Code})
		messages := toChatMessages(prepared.Context.Messages)
		assistantContent := completion.Content
		messages = append(messages, llm.ChatMessage{Role: "assistant", Content: &assistantContent})
		repairPrompt := buildRepairPrompt(string(outcome.Error.Code), outcome.Error.Message)
		messages = append(messages, llm.RawJSONMessage("user", repairPrompt))
		result, err := client.CreateCompletion(ctx, messages, llm.CompletionOptions{
			Model: string(prepared.Profile.Model),
			Tools: toLLMTools(registeredTools),
			ToolChoice: "none",
		})
		if err != nil {
			return nil, err
		}
		completion = toDeepSeekCompletion(result)
		outcome = parse(completion)
	}
	if !outcome.OK {
		if outcome.Error == nil {
			return nil, &Error{Code: "PARSE_FAILED", Message: "model response could not be parsed"}
		}
		return nil, &Error{Code: string(outcome.Error.Code), Message: outcome.Error.Message}
	}
	return outcome.Value, nil
}

func (e *Core) toolExecutionContext(opts RunOptions, cfg *config.Config, mutations *tools.MutationState) tools.ExecutionContext {
	executionMode := e.dependencies.ExecutionMode
	if executionMode == "" {
		executionMode = "cli"
	}
	var commandPermissions *tools.CommandPermissions
	if cfg.ToolPermissions != nil {
		commandPermissions = tools.ResolveCommandPermissions(cfg.ToolPermissions.Command)
	}
	return tools.ExecutionContext{
		ApprovedCommands:  map[string]bool{},
		CommandApproval:   e.dependencies.CommandApproval,
		CommandPermissions: commandPermissions,
		CommandRunner:     e.dependencies.CommandRunner,
		CWD:               opts.CWD,
		ExecutionMode:     executionMode,
		Instruction:       opts.Instruction,
		Mutations:         mutations,
		RepositoryState:   &tools.RepositoryState{IsDirty: true},
		RootDir:           opts.CWD,
		SearchWeb:         e.dependencies.SearchWeb,
	}
}

func (e *Core) createTools(execCtx tools.ExecutionContext) ([]tools.Tool, tools.ExecutionContext) {
	if e.dependencies.CreateTools != nil {
		return e.dependencies.CreateTools(execCtx), execCtx
	}
	return middleware.DefaultTools(execCtx)
}

func (e *Core) search(ctx context.Context, cfg *config.Config, originalInstruction string, query string) ([]tools.WebSearchResult, error) {
	if !tools.HasWebSearchTrigger(originalInstruction) {
		return nil, nil
	}
	search := e.dependencies.SearchWeb
	if search == nil {
		search = tools.SearchWeb
	}
	apiKey := ""
	if cfg.SearchProvider == config.SearchProviderTavily {
		apiKey = cfg.TavilyAPIKey
	} else if cfg.SearchProvider == config.SearchProviderBing {
		apiKey = cfg.BingAPIKey
	}
	return search(ctx, tools.SearchOptions{
		MaxResults:    5,
		Provider:      cfg.SearchProvider,
		Query:         query,
		SearchAPIKey: apiKey,
	})
}

func (e *Core) client(apiKey string) llm.Client {
	if e.dependencies.ClientFactory != nil {
		return e.dependencies.ClientFactory(apiKey)
	}
	return llm.NewDeepSeekClient(llm.DeepSeekClientOptions{APIKey: apiKey})
}

func (e *Core) recordAppliedChanges(ctx context.Context, prepared *PreparedExecution, applied []tools.AppliedFileChange, summary string) (string, string, error) {
	if len(applied) == 0 {
		return "none", "none", nil
	}
	if prepared.RepositoryState.IsRepository && !prepared.RepositoryState.IsDirty {
		commit, err := gitmanager.CreateAICommit(ctx, prepared.CWD, mutationPaths(applied), summary)
		if err != nil {
			return "", "", err
		}
		return "commit", commit.CommitHash, nil
	}
	operation, err := gitmanager.RecordOperation(prepared.CWD, prepared.RepositoryState, toolChangesToOperationSnapshots(applied), summary)
	if err != nil {
		return "", "", err
	}
	return "operation", operation.OperationID, nil
}

func (e *Core) emit(eventType string, payload map[string]any) {
	if e.dependencies.EmitEvent != nil {
		e.dependencies.EmitEvent(Event{Type: eventType, Payload: payload})
	}
}

func toChatMessages(messages []contextbuilder.Message) []llm.ChatMessage {
	result := make([]llm.ChatMessage, 0, len(messages))
	for _, message := range messages {
		content := message.Content
		result = append(result, llm.ChatMessage{Role: message.Role, Content: &content})
	}
	return result
}

func toLLMTools(localTools []tools.Tool) []llm.Tool {
	result := make([]llm.Tool, 0, len(localTools))
	for _, tool := range localTools {
		definition := tool.Definition()
		result = append(result, llm.Tool{
			Type: definition.Type,
			Function: llm.ToolFunction{
				Name:        definition.Function.Name,
				Description: definition.Function.Description,
				Parameters:  definition.Function.Parameters,
				Strict:      definition.Function.Strict,
			},
		})
	}
	return result
}

func toDeepSeekCompletion(result *llm.CompletionResult) llm.DeepSeekCompletionResult {
	content := ""
	if result.Message.Content != nil {
		content = *result.Message.Content
	}
	return llm.DeepSeekCompletionResult{
		Content:          content,
		FinishReason:    result.FinishReason,
		ReasoningContent: result.Message.ReasoningContent,
		ToolCalls:       result.Message.ToolCalls,
		Usage:           &result.Usage,
	}
}

func toContextSearchResults(results []tools.WebSearchResult) []contextbuilder.SearchResult {
	converted := make([]contextbuilder.SearchResult, 0, len(results))
	for _, result := range results {
		converted = append(converted, contextbuilder.SearchResult{
			Title:   result.Title,
			URL:     result.URL,
			Snippet: result.Snippet,
		})
	}
	return converted
}

func convertPlan(parsed *llm.ParsedPlan) *Plan {
	steps := make([]PlanStep, 0, len(parsed.Steps))
	for _, step := range parsed.Steps {
		steps = append(steps, PlanStep{
			Index:            step.Index,
			Description:      step.Description,
			Files:            step.Files,
			EstimatedChanges: step.EstimatedChanges,
		})
	}
	return &Plan{Overview: parsed.Overview, Steps: steps, Notes: parsed.Notes}
}

func buildRepairPrompt(code string, message string) string {
	return strings.Join([]string{
		"Your previous response could not be applied.",
		"Failure code: " + code,
		"Reason: " + message,
		"Return only a valid JSON object matching the required schema.",
		"Do not call tools in this repair response.",
		`The JSON must have the shape: {"files":[{"path":"relative/path","action":"modify|create|delete","diff":"unified diff"}],"summary":"..."}`,
	}, "\n")
}

func profileOrDefault(profile ExecutionProfile) ExecutionProfile {
	if profile == "" {
		return ProfileDefault
	}
	return profile
}

func normalizeRunOptions(opts RunOptions) (RunOptions, error) {
	if opts.CWD == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return RunOptions{}, err
		}
		opts.CWD = cwd
	}
	opts.Profile = profileOrDefault(opts.Profile)
	return opts, nil
}

func formatFileRefs(files []string) string {
	refs := make([]string, 0, len(files))
	for _, file := range files {
		refs = append(refs, "@"+file)
	}
	return strings.Join(refs, " ")
}

func mutationPaths(mutations []tools.AppliedFileChange) []string {
	paths := make([]string, 0, len(mutations))
	for _, mutation := range mutations {
		paths = append(paths, mutation.Path)
	}
	return paths
}

func patcherToToolChanges(changes []patcher.AppliedFileChange) []tools.AppliedFileChange {
	result := make([]tools.AppliedFileChange, 0, len(changes))
	for _, change := range changes {
		result = append(result, tools.AppliedFileChange{
			Action:        string(change.Action),
			AfterContent: change.AfterContent,
			BeforeContent: change.BeforeContent,
			Path:          change.Path,
		})
	}
	return result
}

func toolChangesToOperationSnapshots(changes []tools.AppliedFileChange) []gitmanager.OperationSnapshot {
	snapshots := make([]gitmanager.OperationSnapshot, 0, len(changes))
	for _, change := range changes {
		snapshots = append(snapshots, gitmanager.OperationSnapshot{
			AfterContent:  change.AfterContent,
			BeforeContent: change.BeforeContent,
			Path:          change.Path,
		})
	}
	return snapshots
}

func formatChange(kind string, reference string) string {
	if kind == "" || kind == "none" {
		return "none"
	}
	return kind + "=" + reference
}

func changeReferenceIfCommit(kind string, reference string) string {
	if kind == "commit" {
		return reference
	}
	return ""
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func noneIfEmpty(value string) string {
	if strings.TrimSpace(value) == "" {
		return "none"
	}
	return value
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
