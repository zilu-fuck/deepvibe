package intent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/llm"
	"github.com/zilu-fuck/deepvibe/internal/model"
)

type Intent string

const (
	IntentChat  Intent = "chat"
	IntentRead  Intent = "read"
	IntentWrite Intent = "write"
)

type Confidence string

const (
	ConfidenceLow    Confidence = "low"
	ConfidenceMedium Confidence = "medium"
	ConfidenceHigh   Confidence = "high"
)

type Source string

const (
	SourceHeuristic Source = "heuristic"
	SourceModel     Source = "model"
)

type Decision struct {
	Confidence       Confidence `json:"confidence"`
	EngineeringIntent bool       `json:"engineeringIntent"`
	Intent           Intent     `json:"intent"`
	Reason           string     `json:"reason"`
	RequiresWriteAccess bool     `json:"requiresWriteAccess"`
	Source           Source     `json:"source"`
}

type Options struct {
	ConversationMessages []llm.ChatMessage
	CWD                  string
	Instruction          string
	Profile              model.Profile
}

type Dependencies struct {
	CreateClient func(apiKey string) llm.Client
}

func Detect(ctx context.Context, options Options, dependencies Dependencies) Decision {
	heuristic := DetectHeuristically(options.Instruction)
	cfg, err := config.Load(config.LoadOptions{CWD: options.CWD})
	if err != nil || cfg.APIKey == "" {
		return heuristic
	}

	createClient := dependencies.CreateClient
	if createClient == nil {
		createClient = func(apiKey string) llm.Client {
			return llm.NewDeepSeekClient(llm.DeepSeekClientOptions{APIKey: apiKey})
		}
	}
	client := createClient(cfg.APIKey)
	profile := options.Profile
	if profile.Model == "" {
		profile = model.ResolveProfile(model.ProfileFlash)
	}
	result, err := client.CreateCompletion(ctx, []llm.ChatMessage{
		llm.RawJSONMessage("system", intentSystemPrompt),
		llm.RawJSONMessage("user", buildPrompt(options)),
	}, llm.CompletionOptions{
		Model:      string(profile.Model),
		MaxTokens: 512,
		ToolChoice: "none",
	})
	if err != nil || result == nil || result.Message.Content == nil {
		return heuristic
	}
	return parseDecision(*result.Message.Content, heuristic)
}

func DetectHeuristically(instruction string) Decision {
	normalized := strings.ToLower(strings.TrimSpace(instruction))
	if normalized == "" {
		return Decision{
			Confidence:          ConfidenceHigh,
			EngineeringIntent:   false,
			Intent:              IntentChat,
			Reason:              "Empty message.",
			RequiresWriteAccess: false,
			Source:              SourceHeuristic,
		}
	}

	discussionHit := hasAnyPrefix(normalized, discussionPrefixes) || hasAnyContains(normalized, discussionContains)
	actionHits := countContains(normalized, writeActionTerms)
	targetHits := countContains(normalized, engineeringTargetTerms)
	writelessEngineeringHit := hasAnyContains(normalized, writelessEngineeringTerms)

	if discussionHit && actionHits == 0 {
		return Decision{
			Confidence:          ConfidenceHigh,
			EngineeringIntent:   false,
			Intent:              IntentRead,
			Reason:              "Read-only discussion wording matched.",
			RequiresWriteAccess: false,
			Source:              SourceHeuristic,
		}
	}
	if actionHits > 0 && targetHits > 0 {
		return Decision{
			Confidence:          ConfidenceHigh,
			EngineeringIntent:   true,
			Intent:              IntentWrite,
			Reason:              "Explicit implementation and project-write wording matched.",
			RequiresWriteAccess: true,
			Source:              SourceHeuristic,
		}
	}
	if actionHits > 0 {
		if writelessEngineeringHit {
			return Decision{
				Confidence:          ConfidenceMedium,
				EngineeringIntent:   true,
				Intent:              IntentRead,
				Reason:              "Engineering request detected, but it may be discussion-first.",
				RequiresWriteAccess: false,
				Source:              SourceHeuristic,
			}
		}
		return Decision{
			Confidence:          ConfidenceHigh,
			EngineeringIntent:   true,
			Intent:              IntentWrite,
			Reason:              "Direct engineering action wording matched.",
			RequiresWriteAccess: true,
			Source:              SourceHeuristic,
		}
	}
	if targetHits > 0 || writelessEngineeringHit {
		return Decision{
			Confidence:          ConfidenceMedium,
			EngineeringIntent:   true,
			Intent:              IntentRead,
			Reason:              "Engineering context detected without an explicit write request.",
			RequiresWriteAccess: false,
			Source:              SourceHeuristic,
		}
	}
	return Decision{
		Confidence:          ConfidenceLow,
		EngineeringIntent:   false,
		Intent:              IntentChat,
		Reason:              "No strong engineering signal matched.",
		RequiresWriteAccess: false,
		Source:              SourceHeuristic,
	}
}

const intentSystemPrompt = `You classify whether the latest user message is asking an AI coding assistant to enter active engineering execution.
Return only JSON with this exact shape:
{"engineeringIntent":true,"requiresWriteAccess":true,"confidence":"high","reason":"short reason"}
Set engineeringIntent=true when the user is asking for code changes, project setup, scaffolding, repository actions, or hands-on implementation work.
Set requiresWriteAccess=true only when fulfilling the request now would normally require creating, editing, deleting, or running project code/files.
Set both fields false for explanation, discussion, brainstorming, architecture review, or read-only analysis requests.
Prefer conservative false only when the latest message is clearly discussion-only.`

var writeActionTerms = []string{
	"implement", "build", "create", "scaffold", "generate", "write", "edit", "modify", "refactor", "fix", "patch", "add", "remove", "rename", "delete",
	"\u5b9e\u73b0", "\u7f16\u5199", "\u4fee\u6539", "\u91cd\u6784", "\u4fee\u590d", "\u521b\u5efa", "\u65b0\u5efa", "\u642d\u5efa", "\u751f\u6210", "\u6dfb\u52a0", "\u5220\u9664", "\u91cd\u547d\u540d",
}

var engineeringTargetTerms = []string{
	"api", "endpoint", "project", "app", "feature", "module", "component", "test", "tests", "bug", "code", "file", "files", "repository", "repo", "cli", "package",
	"\u63a5\u53e3", "\u9879\u76ee", "\u529f\u80fd", "\u6a21\u5757", "\u7ec4\u4ef6", "\u6d4b\u8bd5", "\u4ee3\u7801", "\u6587\u4ef6", "\u4ed3\u5e93",
}

var discussionPrefixes = []string{
	"explain", "compare", "review", "describe", "brainstorm", "discuss", "analyze", "summarize", "what", "why", "how",
	"\u89e3\u91ca", "\u5206\u6790", "\u8ba8\u8bba", "\u603b\u7ed3", "\u4e3a\u4ec0\u4e48", "\u600e\u4e48",
}

var discussionContains = []string{
	"?", "\uff1f",
}

var writelessEngineeringTerms = []string{
	"plan", "design", "approach", "architecture", "debug", "investigate",
	"\u65b9\u6848", "\u8bbe\u8ba1", "\u601d\u8def", "\u8c03\u8bd5", "\u6392\u67e5",
}

func buildPrompt(options Options) string {
	lines := []string{"Recent conversation:"}
	messages := options.ConversationMessages
	if len(messages) > 6 {
		messages = messages[len(messages)-6:]
	}
	added := false
	for _, message := range messages {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		content := ""
		if message.Content != nil {
			content = strings.TrimSpace(*message.Content)
		}
		if content == "" {
			continue
		}
		lines = append(lines, message.Role+": "+content)
		added = true
	}
	if !added {
		lines = append(lines, "(none)")
	}
	lines = append(lines, "", "Latest user message:", options.Instruction)
	return strings.Join(lines, "\n")
}

func parseDecision(raw string, fallback Decision) Decision {
	var parsed struct {
		Confidence          Confidence `json:"confidence"`
		EngineeringIntent   *bool      `json:"engineeringIntent"`
		Reason              string     `json:"reason"`
		RequiresWriteAccess *bool      `json:"requiresWriteAccess"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &parsed); err != nil {
		return fallback
	}
	if parsed.EngineeringIntent == nil || parsed.RequiresWriteAccess == nil {
		return fallback
	}
	if parsed.Confidence != ConfidenceLow && parsed.Confidence != ConfidenceMedium && parsed.Confidence != ConfidenceHigh {
		return fallback
	}
	reason := strings.TrimSpace(parsed.Reason)
	if reason == "" {
		reason = "Model classified the request."
	}
	nextIntent := IntentChat
	if *parsed.RequiresWriteAccess {
		nextIntent = IntentWrite
	} else if *parsed.EngineeringIntent {
		nextIntent = IntentRead
	}
	return Decision{
		Confidence:          parsed.Confidence,
		EngineeringIntent:   *parsed.EngineeringIntent,
		Intent:              nextIntent,
		Reason:              reason,
		RequiresWriteAccess: *parsed.RequiresWriteAccess,
		Source:              SourceModel,
	}
}

func countContains(value string, terms []string) int {
	count := 0
	for _, term := range terms {
		if strings.Contains(value, term) {
			count++
		}
	}
	return count
}

func hasAnyContains(value string, terms []string) bool {
	return countContains(value, terms) > 0
}

func hasAnyPrefix(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}
