package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestCreateDefaultToolsAddsCommandAndWebSearchConditionally(t *testing.T) {
	basic := CreateDefaultTools(ExecutionContext{Instruction: "inspect project"})
	withWeb := CreateDefaultTools(ExecutionContext{Instruction: "inspect project @web"})
	withCommand := CreateDefaultTools(ExecutionContext{
		Instruction: "inspect project",
		CommandPermissions: &CommandPermissions{
			Enabled: true,
			Policies: []CommandPolicy{
				{Prefix: "git status", Risk: "low"},
			},
		},
	})

	if toolNames(basic) != "list_files,read_file,write_file,delete_file" {
		t.Fatalf("unexpected basic tools: %s", toolNames(basic))
	}
	if !strings.Contains(toolNames(withWeb), "web_search") {
		t.Fatalf("expected web_search tool, got %s", toolNames(withWeb))
	}
	if !strings.Contains(toolNames(withCommand), "run_command") {
		t.Fatalf("expected run_command tool, got %s", toolNames(withCommand))
	}
}

func TestExecuteListAndReadFileTools(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{
		"src/api.go":   "package src\nconst Value = 1\n",
		"src/other.go": "package src\n",
	})
	registry := CreateDefaultRegistry(ExecutionContext{RootDir: root})
	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "call_1",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "list_files",
				Arguments: `{"directory":"src","limit":10}`,
			},
		},
		{
			ID:   "call_2",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "read_file",
				Arguments: `{"path":"src/api.go"}`,
			},
		},
	}, registry, ExecutionContext{RootDir: root})
	if err != nil {
		t.Fatal(err)
	}

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if !strings.Contains(results[0].Content, "src/api.go") {
		t.Fatalf("expected list result to include src/api.go: %s", results[0].Content)
	}
	if !strings.Contains(results[1].Content, "const Value = 1") {
		t.Fatalf("expected read result content: %s", results[1].Content)
	}
}

func TestWriteDeleteMutationRollback(t *testing.T) {
	root := createToolWorkspace(t, map[string]string{
		"src/api.go": "package src\nconst Value = 1\n",
	})
	mutations := NewMutationState()
	registry := CreateDefaultRegistry(ExecutionContext{RootDir: root, Mutations: mutations})
	_, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "write",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "write_file",
				Arguments: `{"path":"src/api.go","content":"package src\nconst Value = 2\n"}`,
			},
		},
		{
			ID:   "delete",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "delete_file",
				Arguments: `{"path":"src/api.go"}`,
			},
		},
	}, registry, ExecutionContext{RootDir: root, Mutations: mutations})
	if err != nil {
		t.Fatal(err)
	}

	recorded := ListToolMutations(mutations)
	if len(recorded) != 1 {
		t.Fatalf("expected one merged mutation, got %#v", recorded)
	}
	if recorded[0].Action != "delete" || recorded[0].BeforeContent == nil || *recorded[0].BeforeContent != "package src\nconst Value = 1\n" {
		t.Fatalf("unexpected mutation: %#v", recorded[0])
	}
	if err := RollbackToolMutations(mutations, root); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "src", "api.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "package src\nconst Value = 1\n" {
		t.Fatalf("rollback did not restore original file: %q", string(data))
	}
}

func TestUnknownToolReturnsStructuredError(t *testing.T) {
	registry := CreateDefaultRegistry(ExecutionContext{})
	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "missing",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "missing_tool",
				Arguments: `{}`,
			},
		},
	}, registry, ExecutionContext{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(results[0].Content, "Unknown tool") {
		t.Fatalf("expected unknown tool error, got %s", results[0].Content)
	}
}

func toolNames(tools []Tool) string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Definition().Function.Name)
	}
	return strings.Join(names, ",")
}

func createToolWorkspace(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for relativePath, content := range files {
		target := filepath.Join(root, filepath.FromSlash(relativePath))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func decodeContent(t *testing.T, content string) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
