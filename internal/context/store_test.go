package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestAppendTurnAndBuildSessionHistorySummary(t *testing.T) {
	root := t.TempDir()
	if _, err := AppendTurn(AppendTurnOptions{
		RootDir:     root,
		Instruction: "summarize the project",
		Files:       []string{"src/api.ts"},
		Summary:     "Scanned the API module.",
		Result:      TurnResult{OK: true, Kind: "dry-run", AppliedFiles: 0, ToolCallsUsed: false},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := AppendTurn(AppendTurnOptions{
		RootDir:     root,
		Instruction: "update api timeout",
		Files:       []string{"src/api.ts", "src/request.ts"},
		Summary:     "Updated timeout handling.",
		Result:      TurnResult{OK: true, Kind: "operation", AppliedFiles: 2, ToolCallsUsed: true, Reference: "op_123"},
		Tools:       &TurnTools{Names: []string{"tool_calls", "write_tool"}},
	}); err != nil {
		t.Fatal(err)
	}

	store := LoadStore(root)
	summary := BuildSessionHistorySummary(store, 5)
	if len(store.Sessions[0].Turns) != 2 {
		t.Fatalf("expected 2 turns, got %#v", store.Sessions[0].Turns)
	}
	if !strings.Contains(summary, "summarize the project") ||
		!strings.Contains(summary, "update api timeout") ||
		!strings.Contains(summary, "tool_calls") {
		t.Fatalf("unexpected summary:\n%s", summary)
	}
	data, err := os.ReadFile(filepath.Join(root, ".deepvibe", "context.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "Updated timeout handling.") {
		t.Fatalf("context store did not persist turn: %s", string(data))
	}
}

func TestSessionLifecycleAndChatHistory(t *testing.T) {
	root := t.TempDir()
	store := LoadStore(root)
	firstID := store.CurrentSessionID

	store, err := StartNewSession(root)
	if err != nil {
		t.Fatal(err)
	}
	if store.CurrentSessionID == firstID || len(store.Sessions) != 2 {
		t.Fatalf("expected new active session, got %#v", store)
	}
	secondID := store.CurrentSessionID

	switched, err := SwitchSession(root, firstID)
	if err != nil {
		t.Fatal(err)
	}
	if switched == nil || switched.CurrentSessionID != firstID {
		t.Fatalf("expected switch to %s, got %#v", firstID, switched)
	}
	missing, err := SwitchSession(root, "missing")
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Fatalf("expected missing session nil, got %#v", missing)
	}

	content := "hello"
	if err := UpdateChatHistory(root, secondID, []llm.ChatMessage{{Role: "user", Content: &content}}); err != nil {
		t.Fatal(err)
	}
	store = LoadStore(root)
	history := LoadChatHistory(store, secondID)
	if len(history) != 1 || history[0].Content == nil || *history[0].Content != "hello" {
		t.Fatalf("unexpected chat history: %#v", history)
	}
}

func TestEnsureStorePersistsDefaultSession(t *testing.T) {
	root := t.TempDir()
	store, err := EnsureStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if store.CurrentSessionID == "" {
		t.Fatalf("expected current session ID")
	}
	if _, err := os.Stat(filepath.Join(root, ".deepvibe", "context.json")); err != nil {
		t.Fatal(err)
	}
}
