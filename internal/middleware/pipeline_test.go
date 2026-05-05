package middleware

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/config"
	"github.com/zilu-fuck/deepvibe/internal/tools"
)

func TestDefaultToolsIncludesFilesystemAndBackend(t *testing.T) {
	toolList, execCtx := DefaultTools(tools.ExecutionContext{RootDir: t.TempDir(), Instruction: "inspect project"})
	if execCtx.Backend == nil {
		t.Fatalf("expected backend to be injected")
	}
	if names := toolNames(toolList); names != "list_files,read_file,write_file,delete_file" {
		t.Fatalf("unexpected tools: %s", names)
	}
}

func TestApplyCanUseCustomStages(t *testing.T) {
	scope := Apply(tools.ExecutionContext{}, customStage{})
	if len(scope.Tools) != 1 || scope.Tools[0].Definition().Function.Name != "custom_tool" {
		t.Fatalf("unexpected custom tools: %#v", scope.Tools)
	}
}

func TestDefaultToolsAddsCommandAndWebSearchConditionally(t *testing.T) {
	permissions := &tools.CommandPermissions{
		Enabled: true,
		Policies: []tools.CommandPolicy{
			{Prefix: "git status", Risk: config.CommandRiskLow},
		},
	}
	toolList, _ := DefaultTools(tools.ExecutionContext{
		CommandPermissions: permissions,
		Instruction:        "inspect project @web",
		RootDir:            t.TempDir(),
	})
	names := toolNames(toolList)
	for _, want := range []string{"run_command", "web_search"} {
		if !containsName(names, want) {
			t.Fatalf("expected %s in tools: %s", want, names)
		}
	}
}

func TestApplyPreservesInjectedBackend(t *testing.T) {
	original := &stubBackend{}
	_, execCtx := DefaultTools(tools.ExecutionContext{
		Backend: original,
		RootDir: t.TempDir(),
	})
	if execCtx.Backend != original {
		t.Fatalf("expected injected backend to be preserved")
	}
}

func toolNames(toolList []tools.Tool) string {
	result := ""
	for i, tool := range toolList {
		if i > 0 {
			result += ","
		}
		result += tool.Definition().Function.Name
	}
	return result
}

func containsName(names string, want string) bool {
	for _, name := range splitComma(names) {
		if name == want {
			return true
		}
	}
	return false
}

func splitComma(value string) []string {
	if value == "" {
		return nil
	}
	var result []string
	start := 0
	for i, r := range value {
		if r == ',' {
			result = append(result, value[start:i])
			start = i + 1
		}
	}
	result = append(result, value[start:])
	return result
}

type stubBackend struct{}

func (b *stubBackend) Root() string { return "" }

func (b *stubBackend) ListFiles(ctx context.Context, request backend.ListFilesRequest) (*backend.ListFilesResult, error) {
	return nil, nil
}

func (b *stubBackend) ReadFile(ctx context.Context, request backend.ReadFileRequest) (*backend.ReadFileResult, error) {
	return nil, nil
}

func (b *stubBackend) WriteFile(ctx context.Context, request backend.WriteFileRequest) (*backend.WriteFileResult, error) {
	return nil, nil
}

func (b *stubBackend) DeleteFile(ctx context.Context, request backend.DeleteFileRequest) (*backend.DeleteFileResult, error) {
	return nil, nil
}

func (b *stubBackend) Execute(ctx context.Context, request backend.ExecuteRequest) (*backend.ExecuteResult, error) {
	return nil, nil
}

type customStage struct{}

func (s customStage) Name() string {
	return "custom"
}

func (s customStage) Apply(scope *Scope) {
	scope.Tools = append(scope.Tools, customTool{})
}

type customTool struct{}

func (t customTool) Definition() tools.Definition {
	return tools.Definition{
		Type:     "function",
		Function: tools.FunctionDef{Name: "custom_tool"},
	}
}

func (t customTool) Execute(ctx context.Context, args json.RawMessage, execCtx tools.ExecutionContext) (string, error) {
	return "", nil
}
