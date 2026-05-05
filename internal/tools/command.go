package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/workspace"
)

const defaultCommandTimeoutMs = 15000
const defaultCommandMaxOutputChars = 16000

type RunCommandTool struct{}

func (t RunCommandTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "run_command",
			Description: "Run an allowed command inside the project root.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"command"},
				"properties": map[string]any{
					"command": map[string]any{"type": "string"},
					"cwd":     map[string]any{"type": "string"},
				},
			},
		},
	}
}

func (t RunCommandTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Command string `json:"command"`
		CWD     string `json:"cwd"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.Command) == "" {
		return "", fmt.Errorf(`run_command requires a non-empty "command" argument`)
	}

	permissions := execCtx.CommandPermissions
	if permissions == nil || !permissions.Enabled || len(permissions.Policies) == 0 {
		return "", fmt.Errorf(`detected a potentially dangerous command request: %q. run_command is currently disabled by configuration`, parsed.Command)
	}

	command := strings.TrimSpace(parsed.Command)
	policy := matchCommandPolicy(command, permissions.Policies)
	if policy == nil {
		return "", errors.New(formatCommandHookMessage(commandHookMessageOptions{
			Reason:          "unmatched",
			Command:         command,
			AllowedPrefixes: commandPolicyPrefixes(permissions.Policies),
		}))
	}

	rootDir := resolveToolRoot(execCtx)
	workingDirectory := rootDir
	if strings.TrimSpace(parsed.CWD) != "" {
		var err error
		workingDirectory, err = workspace.ResolveExistingProjectPath(rootDir, parsed.CWD)
		if err != nil {
			return "", err
		}
	}
	relativeWorkingDirectory, _ := filepath.Rel(rootDir, workingDirectory)
	relativeWorkingDirectory = workspace.NormalizeRelativePath(relativeWorkingDirectory)
	if relativeWorkingDirectory == "" {
		relativeWorkingDirectory = "."
	}

	if execCtx.ExecutionMode == "service" && !policy.AllowInService {
		return "", errors.New(formatCommandHookMessage(commandHookMessageOptions{
			Reason:  "service",
			Command: command,
			Policy:  policy,
		}))
	}
	if policy.RequireCleanGit && execCtx.RepositoryState != nil && execCtx.RepositoryState.IsDirty {
		return "", errors.New(formatCommandHookMessage(commandHookMessageOptions{
			Reason:  "dirty",
			Command: command,
			Policy:  policy,
		}))
	}
	if len(policy.AllowedDirectories) > 0 && !matchesAllowedDirectory(relativeWorkingDirectory, policy.AllowedDirectories) {
		return "", errors.New(formatCommandHookMessage(commandHookMessageOptions{
			Reason:                   "directory",
			Command:                  command,
			Policy:                   policy,
			RelativeWorkingDirectory: relativeWorkingDirectory,
		}))
	}

	approvalKey := relativeWorkingDirectory + "::" + command
	if permissions.RequireApproval && !execCtx.ApprovedCommands[approvalKey] {
		if execCtx.CommandApproval == nil {
			return "", fmt.Errorf(`detected a command that requires explicit approval: %q. no approval handler is configured for this session`, command)
		}
		approved, err := execCtx.CommandApproval(ctx, CommandApprovalRequest{
			AllowPersistentApproval: policy.AllowPersistentApproval,
			Command:                 command,
			CWD:                     relativeWorkingDirectory,
			Risk:                    policy.Risk,
		})
		if err != nil {
			return "", err
		}
		if !approved {
			return "", errors.New(formatCommandHookMessage(commandHookMessageOptions{
				Reason:  "denied",
				Command: command,
				Policy:  policy,
			}))
		}
		if execCtx.ApprovedCommands != nil {
			execCtx.ApprovedCommands[approvalKey] = true
		}
	}

	maxOutputChars := permissions.MaxOutputChars
	if policy.MaxOutputChars > 0 {
		maxOutputChars = policy.MaxOutputChars
	}
	timeoutMs := permissions.TimeoutMs
	if policy.TimeoutMs > 0 {
		timeoutMs = policy.TimeoutMs
	}
	request := CommandExecutionRequest{
		Command:        command,
		CWD:            workingDirectory,
		MaxOutputChars: maxOutputChars,
		TimeoutMs:      timeoutMs,
	}
	result, err := runCommandWithContext(ctx, execCtx, request)
	if err != nil {
		return "", err
	}

	return encodeToolJSON(map[string]any{
		"ok":       true,
		"command":  command,
		"cwd":      relativeWorkingDirectory,
		"risk":     policy.Risk,
		"exitCode": result.ExitCode,
		"stdout":   result.Stdout,
		"stderr":   result.Stderr,
	})
}

func ResolveCommandPermissions(cfg *config.CommandToolPermissionConfig) *CommandPermissions {
	if cfg == nil || cfg.Enabled == nil || !*cfg.Enabled {
		return nil
	}

	policies := normalizeCommandPolicies(cfg.CommandPolicies, cfg.AllowedPrefixes)
	if len(policies) == 0 {
		return nil
	}

	requireApproval := true
	if cfg.RequireApproval != nil {
		requireApproval = *cfg.RequireApproval
	}

	timeoutMs := defaultCommandTimeoutMs
	if cfg.TimeoutMs != nil && *cfg.TimeoutMs > 0 {
		timeoutMs = maxInt(1000, *cfg.TimeoutMs)
	}

	maxOutputChars := defaultCommandMaxOutputChars
	if cfg.MaxOutputChars != nil && *cfg.MaxOutputChars > 0 {
		maxOutputChars = maxInt(256, *cfg.MaxOutputChars)
	}

	return &CommandPermissions{
		Enabled:         true,
		Policies:        policies,
		RequireApproval: requireApproval,
		TimeoutMs:       timeoutMs,
		MaxOutputChars:  maxOutputChars,
	}
}

func normalizeCommandPolicies(entries []config.CommandPolicyEntry, allowedPrefixes []string) []CommandPolicy {
	if len(entries) > 0 {
		policies := make([]CommandPolicy, 0, len(entries))
		for _, entry := range entries {
			prefix := strings.TrimSpace(entry.Prefix)
			if prefix == "" {
				continue
			}
			risk := entry.Risk
			if risk == "" {
				risk = inferRiskFromPrefix(prefix)
			}
			allowInService := false
			if entry.AllowInService != nil {
				allowInService = *entry.AllowInService
			}
			allowPersistentApproval := risk == config.CommandRiskLow
			if entry.AllowPersistentApproval != nil {
				allowPersistentApproval = *entry.AllowPersistentApproval
			}
			requireCleanGit := false
			if entry.RequireCleanGit != nil {
				requireCleanGit = *entry.RequireCleanGit
			}
			timeoutMs := 0
			if entry.TimeoutMs != nil && *entry.TimeoutMs > 0 {
				timeoutMs = maxInt(1000, *entry.TimeoutMs)
			}
			maxOutputChars := 0
			if entry.MaxOutputChars != nil && *entry.MaxOutputChars > 0 {
				maxOutputChars = maxInt(256, *entry.MaxOutputChars)
			}
			allowedDirectories := make([]string, 0, len(entry.AllowedDirectories))
			for _, directory := range entry.AllowedDirectories {
				if strings.TrimSpace(directory) != "" {
					allowedDirectories = append(allowedDirectories, workspace.NormalizeRelativePath(directory))
				}
			}
			policies = append(policies, CommandPolicy{
				AllowInService:          allowInService,
				AllowPersistentApproval: allowPersistentApproval,
				AllowedDirectories:      allowedDirectories,
				MaxOutputChars:          maxOutputChars,
				Prefix:                  prefix,
				RequireCleanGit:         requireCleanGit,
				Risk:                    risk,
				TimeoutMs:               timeoutMs,
			})
		}
		return policies
	}

	policies := make([]CommandPolicy, 0, len(allowedPrefixes))
	for _, prefix := range allowedPrefixes {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		risk := inferRiskFromPrefix(prefix)
		policies = append(policies, CommandPolicy{
			AllowPersistentApproval: risk == config.CommandRiskLow,
			Prefix:                  prefix,
			Risk:                    risk,
		})
	}
	return policies
}

func matchCommandPolicy(command string, policies []CommandPolicy) *CommandPolicy {
	normalizedCommand := normalizeCommandText(command)
	var best *CommandPolicy
	bestLength := -1

	for i := range policies {
		normalizedPrefix := normalizeCommandText(policies[i].Prefix)
		if normalizedCommand == normalizedPrefix || strings.HasPrefix(normalizedCommand, normalizedPrefix+" ") {
			if len(normalizedPrefix) > bestLength {
				best = &policies[i]
				bestLength = len(normalizedPrefix)
			}
		}
	}
	return best
}

func RunCommand(ctx context.Context, request CommandExecutionRequest) (*CommandExecutionResult, error) {
	result, err := backend.NewLocal(request.CWD).Execute(ctx, backend.ExecuteRequest{
		Command:        request.Command,
		CWD:            request.CWD,
		MaxOutputChars: request.MaxOutputChars,
		TimeoutMs:      request.TimeoutMs,
	})
	if err != nil {
		return nil, err
	}
	return &CommandExecutionResult{
		ExitCode: result.ExitCode,
		Stderr:   result.Stderr,
		Stdout:   result.Stdout,
	}, nil
}

func runCommandWithContext(ctx context.Context, execCtx ExecutionContext, request CommandExecutionRequest) (*CommandExecutionResult, error) {
	if execCtx.CommandRunner != nil {
		return execCtx.CommandRunner(ctx, request)
	}
	result, err := resolveToolBackend(execCtx).Execute(ctx, backend.ExecuteRequest{
		Command:        request.Command,
		CWD:            request.CWD,
		MaxOutputChars: request.MaxOutputChars,
		TimeoutMs:      request.TimeoutMs,
	})
	if err != nil {
		return nil, err
	}
	return &CommandExecutionResult{
		ExitCode: result.ExitCode,
		Stderr:   result.Stderr,
		Stdout:   result.Stdout,
	}, nil
}

func inferRiskFromPrefix(prefix string) config.CommandRiskLevel {
	normalized := normalizeCommandText(prefix)
	if strings.HasPrefix(normalized, "git status") ||
		strings.HasPrefix(normalized, "git diff") ||
		strings.HasPrefix(normalized, "go test") ||
		strings.HasPrefix(normalized, "pnpm test") ||
		strings.HasPrefix(normalized, "npm test") ||
		strings.HasPrefix(normalized, "pytest") ||
		strings.HasPrefix(normalized, "ls") ||
		strings.HasPrefix(normalized, "dir") {
		return config.CommandRiskLow
	}
	if strings.HasPrefix(normalized, "git add") ||
		strings.HasPrefix(normalized, "git commit") ||
		strings.HasPrefix(normalized, "go build") ||
		strings.HasPrefix(normalized, "pnpm build") ||
		strings.HasPrefix(normalized, "npm run build") {
		return config.CommandRiskMedium
	}
	return config.CommandRiskHigh
}

func matchesAllowedDirectory(cwd string, allowedDirectories []string) bool {
	for _, directory := range allowedDirectories {
		directory = workspace.NormalizeRelativePath(directory)
		if directory == "." || cwd == directory || strings.HasPrefix(cwd, directory+"/") {
			return true
		}
	}
	return false
}

type commandHookMessageOptions struct {
	AllowedPrefixes          []string
	Command                  string
	Policy                   *CommandPolicy
	Reason                   string
	RelativeWorkingDirectory string
}

func formatCommandHookMessage(options commandHookMessageOptions) string {
	base := fmt.Sprintf("detected a potentially dangerous command: %q.", options.Command)
	safer := suggestSaferAlternatives(options.Command)
	switch options.Reason {
	case "unmatched":
		sort.Strings(options.AllowedPrefixes)
		return strings.Join(nonEmptyStrings(
			base,
			"it does not match any configured command policy prefix.",
			"allowed prefixes: "+strings.Join(options.AllowedPrefixes, ", ")+".",
			safer,
		), " ")
	case "service":
		return strings.Join(nonEmptyStrings(
			base,
			fmt.Sprintf("the matched policy %q is not allowed in service mode.", options.Policy.Prefix),
			"run it from an interactive local session instead.",
			safer,
		), " ")
	case "dirty":
		return strings.Join(nonEmptyStrings(
			base,
			fmt.Sprintf("the matched policy %q requires a clean Git working tree.", options.Policy.Prefix),
			"review the current changes with git status or git diff, then commit/stash before retrying.",
			safer,
		), " ")
	case "directory":
		return strings.Join(nonEmptyStrings(
			base,
			fmt.Sprintf("the matched policy %q is not allowed in working directory %q.", options.Policy.Prefix, options.RelativeWorkingDirectory),
			"allowed directories: "+strings.Join(options.Policy.AllowedDirectories, ", ")+".",
			safer,
		), " ")
	case "denied":
		return strings.Join(nonEmptyStrings(
			base,
			fmt.Sprintf("approval was denied for the matched policy %q.", options.Policy.Prefix),
			safer,
		), " ")
	default:
		return base + " " + safer
	}
}

func suggestSaferAlternatives(command string) string {
	normalized := normalizeCommandText(command)
	if strings.Contains(normalized, "rm ") ||
		strings.Contains(normalized, "del ") ||
		strings.Contains(normalized, "remove-") ||
		strings.Contains(normalized, "reset --hard") ||
		strings.Contains(normalized, "git clean") {
		return "suggested safer path: inspect changes with git status or git diff first, or reproduce the command in a temporary directory before touching the project workspace."
	}
	return "suggested safer path: start with read-only inspection commands such as git status or git diff, or test the workflow in a temporary directory before executing it here."
}

func commandPolicyPrefixes(policies []CommandPolicy) []string {
	prefixes := make([]string, 0, len(policies))
	for _, policy := range policies {
		prefixes = append(prefixes, policy.Prefix)
	}
	return prefixes
}

func normalizeCommandText(command string) string {
	return strings.ToLower(strings.Join(strings.Fields(command), " "))
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
