package repl

import (
	"bytes"
	"context"
	"strings"
	"testing"

	contextstore "github.com/zilu-fuck/deepvibe/internal/context"
	"github.com/zilu-fuck/deepvibe/internal/engine"
)

type fakeRunner struct {
	calls []engine.RunOptions
	err   error
}

func (f *fakeRunner) Run(ctx context.Context, opts engine.RunOptions) (*engine.Result, error) {
	f.calls = append(f.calls, opts)
	if f.err != nil {
		return nil, f.err
	}
	return &engine.Result{
		Candidates:     []string{"src/app.ts"},
		ContextTokens:  12,
		FilesChanged:   []string{"src/app.ts"},
		Message:        "assistant reply",
		ScannedFiles:   3,
		ToolCallsUsed:  true,
		ChangeKind:     "operation",
		ChangeReference: "op_123",
	}, nil
}

func TestREPLRunsInstructionAndPersistsHistory(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	var output bytes.Buffer

	repl := New(Options{
		CWD:    root,
		Engine: runner,
		Input:  strings.NewReader("hello project\n/history\n/quit\n"),
		Mode:   ModeProject,
		Output: &output,
	})
	if err := repl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("expected 1 engine call, got %d", len(runner.calls))
	}
	if runner.calls[0].DryRun {
		t.Fatalf("project mode should not force dry run")
	}
	if runner.calls[0].Instruction != "hello project" {
		t.Fatalf("unexpected instruction: %#v", runner.calls[0])
	}
	text := output.String()
	if !strings.Contains(text, "assistant reply") ||
		!strings.Contains(text, "user: hello project") ||
		!strings.Contains(text, "assistant: assistant reply") {
		t.Fatalf("unexpected output:\n%s", text)
	}

	store := contextstore.LoadStore(root)
	history := contextstore.LoadChatHistory(store, store.CurrentSessionID)
	if len(history) != 2 {
		t.Fatalf("expected 2 history messages, got %#v", history)
	}
	if len(store.Sessions[0].Turns) != 1 {
		t.Fatalf("expected 1 stored turn, got %#v", store.Sessions[0].Turns)
	}
	if store.Sessions[0].Turns[0].Result.Reference != "op_123" {
		t.Fatalf("unexpected turn: %#v", store.Sessions[0].Turns[0])
	}
}

func TestREPLAutoModeUsesIntentForDryRun(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	repl := New(Options{
		CWD:    root,
		Engine: runner,
		Input:  strings.NewReader("explain the architecture\nimplement a new api endpoint\n/quit\n"),
		Output: &bytes.Buffer{},
	})
	if err := repl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("expected 2 engine calls, got %#v", runner.calls)
	}
	if !runner.calls[0].DryRun {
		t.Fatalf("expected discussion request to use dry run, got %#v", runner.calls[0])
	}
	if runner.calls[1].DryRun {
		t.Fatalf("expected write request to use project execution, got %#v", runner.calls[1])
	}
}

func TestREPLSlashCommands(t *testing.T) {
	root := t.TempDir()
	var output bytes.Buffer
	repl := New(Options{
		CWD:    root,
		Engine: &fakeRunner{},
		Input: strings.NewReader(strings.Join([]string{
			"/help",
			"/sessions",
			"/new",
			"/sessions",
			"/mode auto",
			"/mode chat",
			"hello chat",
			"/mode",
			"/quit",
			"",
		}, "\n")),
		Output: &output,
	})
	if err := repl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, want := range []string{"Commands:", "Started session", "mode=auto", "mode=chat", "Goodbye."} {
		if !strings.Contains(text, want) {
			t.Fatalf("expected output to contain %q:\n%s", want, text)
		}
	}
	store := contextstore.LoadStore(root)
	if len(store.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %#v", store.Sessions)
	}
}

func TestREPLChatModeUsesDryRun(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	repl := New(Options{
		CWD:    root,
		Engine: runner,
		Input:  strings.NewReader("/mode chat\nhello\n/quit\n"),
		Output: &bytes.Buffer{},
	})
	if err := repl.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || !runner.calls[0].DryRun {
		t.Fatalf("expected chat mode dry run, got %#v", runner.calls)
	}
}
