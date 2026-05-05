package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestResolveCommandPermissionsSupportsPoliciesAndLegacyPrefixes(t *testing.T) {
	enabled := true
	requireApproval := false
	timeout := 5000
	maxOutput := 4000

	permissions := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled:         &enabled,
		RequireApproval: &requireApproval,
		TimeoutMs:       &timeout,
		MaxOutputChars:  &maxOutput,
		CommandPolicies: []config.CommandPolicyEntry{
			{Prefix: "git status", Risk: config.CommandRiskLow},
		},
	})
	if permissions == nil || !permissions.Enabled || permissions.RequireApproval {
		t.Fatalf("unexpected permissions: %#v", permissions)
	}
	if permissions.TimeoutMs != 5000 || permissions.MaxOutputChars != 4000 {
		t.Fatalf("unexpected limits: %#v", permissions)
	}

	legacy := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled:         &enabled,
		RequireApproval: &requireApproval,
		AllowedPrefixes: []string{"git status", "go test"},
	})
	if legacy == nil || len(legacy.Policies) != 2 {
		t.Fatalf("expected two legacy policies, got %#v", legacy)
	}
}

func TestRunCommandUsesInjectedRunnerAndApproval(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{"src/api.go": "package src\n"})
	enabled := true
	permissions := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled: &enabled,
		CommandPolicies: []config.CommandPolicyEntry{
			{Prefix: "git status", Risk: config.CommandRiskLow},
		},
	})
	approvalCalls := 0
	runnerCalls := 0

	registry := CreateDefaultRegistry(ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
	})
	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "cmd",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "run_command",
				Arguments: `{"command":"git status --short"}`,
			},
		},
	}, registry, ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
		ApprovedCommands:   map[string]bool{},
		CommandApproval: func(ctx context.Context, request CommandApprovalRequest) (bool, error) {
			approvalCalls++
			if request.Risk != config.CommandRiskLow {
				t.Fatalf("unexpected risk: %s", request.Risk)
			}
			return true, nil
		},
		CommandRunner: func(ctx context.Context, request CommandExecutionRequest) (*CommandExecutionResult, error) {
			runnerCalls++
			if request.Command != "git status --short" {
				t.Fatalf("unexpected command: %s", request.Command)
			}
			return &CommandExecutionResult{ExitCode: 0, Stdout: " M src/api.go\n"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if approvalCalls != 1 || runnerCalls != 1 {
		t.Fatalf("expected approval and runner once, got approval=%d runner=%d", approvalCalls, runnerCalls)
	}
	if !strings.Contains(results[0].Content, "src/api.go") {
		t.Fatalf("unexpected command result: %s", results[0].Content)
	}
}

func TestRunCommandUsesBackendWhenRunnerIsNotInjected(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{"src/api.go": "package src\n"})
	enabled := true
	requireApproval := false
	permissions := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled:         &enabled,
		RequireApproval: &requireApproval,
		CommandPolicies: []config.CommandPolicyEntry{
			{Prefix: "git status", Risk: config.CommandRiskLow},
		},
	})
	fake := &fakeCommandBackend{root: root}
	registry := CreateDefaultRegistry(ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
	})

	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "cmd",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "run_command",
				Arguments: `{"command":"git status --short","cwd":"src"}`,
			},
		},
	}, registry, ExecutionContext{
		Backend:            fake,
		RootDir:            root,
		CommandPermissions: permissions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected backend execute once, got %d", fake.calls)
	}
	if fake.request.Command != "git status --short" || !strings.HasSuffix(fake.request.CWD, "src") {
		t.Fatalf("unexpected backend request: %#v", fake.request)
	}
	if !strings.Contains(results[0].Content, "backend result") {
		t.Fatalf("unexpected command result: %s", results[0].Content)
	}
}

func TestRunCommandRejectsUnsafeAndDeniedCommands(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{"src/api.go": "package src\n"})
	enabled := true
	permissions := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled: &enabled,
		CommandPolicies: []config.CommandPolicyEntry{
			{Prefix: "git status", Risk: config.CommandRiskLow},
		},
	})
	registry := CreateDefaultRegistry(ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
	})

	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "unsafe",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "run_command",
				Arguments: `{"command":"git reset --hard"}`,
			},
		},
	}, registry, ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(results[0].Content, "allowed prefixes") {
		t.Fatalf("expected allowlist error, got %s", results[0].Content)
	}

	denied, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "denied",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "run_command",
				Arguments: `{"command":"git status --short"}`,
			},
		},
	}, registry, ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
		CommandApproval: func(ctx context.Context, request CommandApprovalRequest) (bool, error) {
			return false, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(denied[0].Content, "approval was denied") {
		t.Fatalf("expected denied approval error, got %s", denied[0].Content)
	}
}

func TestRunCommandEnforcesServiceModeDirtyTreeAndDirectory(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{
		"src/api.go":       "package src\n",
		"tests/api_test.go": "package tests\n",
	})
	enabled := true
	requireClean := true
	allowInService := false
	permissions := ResolveCommandPermissions(&config.CommandToolPermissionConfig{
		Enabled: &enabled,
		CommandPolicies: []config.CommandPolicyEntry{
			{
				Prefix:             "git add",
				Risk:               config.CommandRiskMedium,
				AllowedDirectories: []string{"src"},
				RequireCleanGit:    &requireClean,
				AllowInService:     &allowInService,
			},
		},
	})
	registry := CreateDefaultRegistry(ExecutionContext{
		RootDir:            root,
		CommandPermissions: permissions,
	})

	cases := []struct {
		name     string
		ctx      ExecutionContext
		argument string
		want     string
	}{
		{
			name: "service",
			ctx: ExecutionContext{
				RootDir:            root,
				CommandPermissions: permissions,
				ExecutionMode:      "service",
			},
			argument: `{"command":"git add api.go","cwd":"src"}`,
			want:     "not allowed in service mode",
		},
		{
			name: "dirty",
			ctx: ExecutionContext{
				RootDir:            root,
				CommandPermissions: permissions,
				RepositoryState:    &RepositoryState{IsDirty: true},
			},
			argument: `{"command":"git add api.go","cwd":"src"}`,
			want:     "requires a clean Git working tree",
		},
		{
			name: "directory",
			ctx: ExecutionContext{
				RootDir:            root,
				CommandPermissions: permissions,
				RepositoryState:    &RepositoryState{IsDirty: false},
			},
			argument: `{"command":"git add api_test.go","cwd":"tests"}`,
			want:     "not allowed in working directory",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
				{
					ID:   tc.name,
					Type: "function",
					Function: llm.ToolCallFunction{
						Name:      "run_command",
						Arguments: tc.argument,
					},
				},
			}, registry, tc.ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(results[0].Content, tc.want) {
				t.Fatalf("expected %q, got %s", tc.want, results[0].Content)
			}
		})
	}
}

type fakeCommandBackend struct {
	calls   int
	request backend.ExecuteRequest
	root    string
}

func (b *fakeCommandBackend) Root() string {
	return b.root
}

func (b *fakeCommandBackend) ListFiles(ctx context.Context, request backend.ListFilesRequest) (*backend.ListFilesResult, error) {
	return nil, nil
}

func (b *fakeCommandBackend) ReadFile(ctx context.Context, request backend.ReadFileRequest) (*backend.ReadFileResult, error) {
	return nil, nil
}

func (b *fakeCommandBackend) WriteFile(ctx context.Context, request backend.WriteFileRequest) (*backend.WriteFileResult, error) {
	return nil, nil
}

func (b *fakeCommandBackend) DeleteFile(ctx context.Context, request backend.DeleteFileRequest) (*backend.DeleteFileResult, error) {
	return nil, nil
}

func (b *fakeCommandBackend) Execute(ctx context.Context, request backend.ExecuteRequest) (*backend.ExecuteResult, error) {
	b.calls++
	b.request = request
	return &backend.ExecuteResult{ExitCode: 0, Stdout: "backend result\n"}, nil
}
