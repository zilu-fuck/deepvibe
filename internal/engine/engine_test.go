package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	contextbuilder "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/llm"
	"github.com/zilu-fuck/deepvibe/internal/model"
	"github.com/zilu-fuck/deepvibe/internal/scanner"
)

type fakeClient struct {
	calls     int
	responses []*llm.CompletionResult
}

func (c *fakeClient) CreateCompletion(ctx context.Context, messages []llm.ChatMessage, opts llm.CompletionOptions) (*llm.CompletionResult, error) {
	if c.calls >= len(c.responses) {
		content := `{"files":[],"summary":"default"}`
		return &llm.CompletionResult{Message: llm.ChatMessage{Role: "assistant", Content: &content}}, nil
	}
	response := c.responses[c.calls]
	c.calls++
	return response, nil
}

func (c *fakeClient) CreateStreamingCompletion(ctx context.Context, messages []llm.ChatMessage, opts llm.CompletionOptions, callbacks llm.StreamingCallbacks) (*llm.CompletionResult, error) {
	return c.CreateCompletion(ctx, messages, opts)
}

func (c *fakeClient) CreateFimCompletion(ctx context.Context, opts llm.FimOptions) (*llm.FimResult, error) {
	return &llm.FimResult{}, nil
}

func TestCoreDryRunBuildsPreview(t *testing.T) {
	cwd := createEngineWorkspace(t, false)
	core := New(Dependencies{})
	result, err := core.Run(context.Background(), RunOptions{
		CWD:         cwd,
		DryRun:      true,
		Instruction: "summarize @src/app.ts",
		Profile:     ProfileFlash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Message, "Dry run ready") {
		t.Fatalf("unexpected message: %s", result.Message)
	}
	if result.ScannedFiles == 0 || result.ContextTokens == 0 {
		t.Fatalf("expected scan/context metrics, got %#v", result)
	}
}

func TestCorePrepareExecutionUsesToolCalls(t *testing.T) {
	cwd := createEngineWorkspace(t, true)
	toolCallArgs := `{"path":"generated.txt","content":"hello from tool"}`
	first := completionWithToolCall("call_1", "write_file", toolCallArgs)
	finalContent := `{"files":[],"summary":"tool wrote file"}`
	client := &fakeClient{responses: []*llm.CompletionResult{first, assistantCompletion(finalContent)}}
	core := New(Dependencies{
		ClientFactory: func(apiKey string) llm.Client {
			if apiKey != "test-key" {
				t.Fatalf("unexpected api key %q", apiKey)
			}
			return client
		},
	})

	result, err := core.Run(context.Background(), RunOptions{
		CWD:         cwd,
		Instruction: "create a generated file",
		Profile:     ProfileDefault,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.ToolCallsUsed {
		t.Fatal("expected tool calls to be used")
	}
	if len(result.FilesChanged) != 1 || result.FilesChanged[0] != "generated.txt" {
		t.Fatalf("unexpected changed files: %#v", result.FilesChanged)
	}
	data, err := os.ReadFile(filepath.Join(cwd, "generated.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello from tool" {
		t.Fatalf("unexpected generated content %q", string(data))
	}
}

func TestCoreRepairRetry(t *testing.T) {
	cwd := createEngineWorkspace(t, true)
	client := &fakeClient{responses: []*llm.CompletionResult{
		assistantCompletion(`not json`),
		assistantCompletion(`{"files":[],"summary":"repaired"}`),
	}}
	var events []string
	core := New(Dependencies{
		ClientFactory: func(apiKey string) llm.Client { return client },
		EmitEvent: func(event Event) {
			events = append(events, event.Type)
		},
	})

	prepared, err := core.PrepareExecution(context.Background(), RunOptions{
		CWD:         cwd,
		Instruction: "return malformed once",
	})
	if err != nil {
		t.Fatal(err)
	}
	if prepared.ParsedResponse.Summary != "repaired" {
		t.Fatalf("unexpected parsed response: %#v", prepared.ParsedResponse)
	}
	if !containsEvent(events, "repair.retry") {
		t.Fatalf("expected repair retry event, got %#v", events)
	}
}

func TestCoreApplyPreparedExecutionAppliesDiffAndRecordsOperation(t *testing.T) {
	cwd := createEngineWorkspace(t, true)
	core := New(Dependencies{})
	result, err := core.ApplyPreparedExecution(context.Background(), &PreparedExecution{
		Context: buildResultForTest(),
		CWD: cwd,
		HasAPIKey: true,
		Instruction: "modify",
		ParsedResponse: &llm.ParsedModelResponse{
			Files: []llm.ParsedFileChange{
				{
					Path:   "src/app.ts",
					Action: llm.FileActionModify,
					Diff:   "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-export const app = 1;\n+export const app = 2;",
				},
			},
			Summary: "change",
		},
		Profile: modelProfileForTest(),
		ScanResult: scannerResultForTest(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ChangeKind != "operation" || result.ChangeReference == "" {
		t.Fatalf("expected operation record, got %#v", result)
	}
	assertEngineFile(t, cwd, "src/app.ts", "export const app = 2;\n")
	if _, err := os.Stat(filepath.Join(cwd, ".deepvibe", "last-action.json")); err != nil {
		t.Fatalf("expected last action record: %v", err)
	}
}

func createEngineWorkspace(t *testing.T, withConfig bool) string {
	t.Helper()
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, "src", "app.ts"), []byte("export const app = 1;\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if withConfig {
		if err := os.MkdirAll(filepath.Join(cwd, ".deepvibe"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cwd, ".deepvibe", "config.json"), []byte(`{"apiKey":"test-key"}`), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return cwd
}

func assistantCompletion(content string) *llm.CompletionResult {
	return &llm.CompletionResult{
		Message: llm.ChatMessage{
			Role:    "assistant",
			Content: &content,
		},
		FinishReason: "stop",
	}
}

func completionWithToolCall(id string, name string, args string) *llm.CompletionResult {
	content := ""
	return &llm.CompletionResult{
		Message: llm.ChatMessage{
			Role:    "assistant",
			Content: &content,
			ToolCalls: []llm.ToolCall{
				{
					ID:   id,
					Type: "function",
					Function: llm.ToolCallFunction{
						Name:      name,
						Arguments: args,
					},
				},
			},
		},
		FinishReason: "tool_calls",
	}
}

func containsEvent(events []string, target string) bool {
	for _, event := range events {
		if event == target {
			return true
		}
	}
	return false
}

func structBuildResult() contextbuilder.BuildResult {
	return contextbuilder.BuildResult{TokenEstimate: 1, MaxPromptTokens: 10}
}

func buildResultForTest() *contextbuilder.BuildResult {
	value := structBuildResult()
	return &value
}

func modelProfileForTest() model.Profile {
	return model.ResolveProfile(model.ProfileDefault)
}

func scannerResultForTest() *scanner.Result {
	return &scanner.Result{Candidates: []string{"src/app.ts"}, ScannedFiles: 1}
}

func assertEngineFile(t *testing.T, root string, relativePath string, expected string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != expected {
		t.Fatalf("expected %q, got %q", expected, string(data))
	}
}
