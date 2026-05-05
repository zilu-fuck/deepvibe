package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildIncludesCandidateFiles(t *testing.T) {
	root := t.TempDir()
	writeContextFile(t, filepath.Join(root, "src", "config.ts"), "export const config = true\n")

	result, err := Build(BuildOptions{
		RootDir:     root,
		Instruction: "summarize config",
		Candidates:  []string{"src/config.ts"},
	})
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}

	if len(result.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(result.Messages))
	}
	if len(result.Files) != 1 || result.Files[0].Path != "src/config.ts" {
		t.Fatalf("expected config file, got %#v", result.Files)
	}
	if !strings.Contains(result.Messages[2].Content, "--- FILE: src/config.ts") {
		t.Fatalf("expected task message to contain rendered file, got %q", result.Messages[2].Content)
	}
}

func TestBuildTruncatesWhenBudgetIsSmall(t *testing.T) {
	root := t.TempDir()
	writeContextFile(t, filepath.Join(root, "large.ts"), strings.Repeat("export const value = 1\n", 200))

	result, err := Build(BuildOptions{
		RootDir:                root,
		Instruction:            "read large",
		Candidates:             []string{"large.ts"},
		MaxWindowTokens:        200,
		ReservedResponseTokens: 50,
	})
	if err != nil {
		t.Fatalf("Build returned error: %v", err)
	}
	if !result.Truncated {
		t.Fatal("expected truncation with small budget")
	}
}

func writeContextFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
}
