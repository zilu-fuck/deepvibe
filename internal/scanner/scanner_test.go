package scanner

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestScanProjectFindsExplicitPathsAndIgnoresFiles(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "src", "config.ts"), "export const value = 1\n")
	writeTestFile(t, filepath.Join(root, "src", "engine.ts"), "export const engine = 1\n")
	writeTestFile(t, filepath.Join(root, "tests", "engine.test.ts"), "test('engine')\n")
	writeTestFile(t, filepath.Join(root, "dist", "bundle.js"), "ignored\n")
	writeTestFile(t, filepath.Join(root, ".deepvibeignore"), "ignored/**\n")
	writeTestFile(t, filepath.Join(root, "ignored", "secret.ts"), "ignored\n")

	result, err := ScanProject(context.Background(), Options{
		RootDir:       root,
		Instruction:   "update @src/config.ts and engine behavior",
		MaxCandidates: 2,
	})
	if err != nil {
		t.Fatalf("ScanProject returned error: %v", err)
	}

	if len(result.ExplicitPaths) != 1 || result.ExplicitPaths[0] != "src/config.ts" {
		t.Fatalf("expected explicit src/config.ts, got %#v", result.ExplicitPaths)
	}
	if result.ScannedFiles != 3 {
		t.Fatalf("expected 3 scanned files, got %d", result.ScannedFiles)
	}
	if len(result.Candidates) == 0 || result.Candidates[0] != "src/config.ts" {
		t.Fatalf("expected explicit path first, got %#v", result.Candidates)
	}
}

func writeTestFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
}
