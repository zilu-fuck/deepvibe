package patcher

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestApplyFileChangesModify(t *testing.T) {
	root := createPatchWorkspace(t, map[string]string{
		"src/api.ts": "export const value = 1;\n",
	})

	applied, err := ApplyFileChanges(root, []llm.ParsedFileChange{
		{
			Path:   "src/api.ts",
			Action: llm.FileActionModify,
			Diff:   "--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0].BeforeContent == nil || applied[0].AfterContent == nil {
		t.Fatalf("unexpected applied changes: %#v", applied)
	}
	assertFile(t, root, "src/api.ts", "export const value = 2;\n")
}

func TestApplyFileChangesCreateAndDelete(t *testing.T) {
	root := createPatchWorkspace(t, map[string]string{
		"src/remove.ts": "remove me\n",
	})

	_, err := ApplyFileChanges(root, []llm.ParsedFileChange{
		{
			Path:   "src/new.ts",
			Action: llm.FileActionCreate,
			Diff:   "--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+created",
		},
		{
			Path:   "src/remove.ts",
			Action: llm.FileActionDelete,
			Diff:   "--- a/src/remove.ts\n+++ b/src/remove.ts\n@@ -1,1 +0,0 @@\n-remove me",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertFile(t, root, "src/new.ts", "created\n")
	if _, err := os.Stat(filepath.Join(root, "src", "remove.ts")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected deleted file, got %v", err)
	}
}

func TestApplyFileChangesRollsBackOnFailure(t *testing.T) {
	root := createPatchWorkspace(t, map[string]string{
		"src/first.ts":  "export const first = 1;\n",
		"src/second.ts": "export const second = 2;\n",
	})

	err := applyExpectError(root, []llm.ParsedFileChange{
		{
			Path:   "src/first.ts",
			Action: llm.FileActionModify,
			Diff:   "--- a/src/first.ts\n+++ b/src/first.ts\n@@ -1,1 +1,1 @@\n-export const first = 1;\n+export const first = 3;",
		},
		{
			Path:   "src/second.ts",
			Action: llm.FileActionModify,
			Diff:   "--- a/src/second.ts\n+++ b/src/second.ts\n@@ -1,1 +1,1 @@\n-export const second = 999;\n+export const second = 4;",
		},
	})
	var patchErr *Error
	if !errors.As(err, &patchErr) || patchErr.Code != "PATCH_FAILED" {
		t.Fatalf("expected PATCH_FAILED, got %T %v", err, err)
	}
	assertFile(t, root, "src/first.ts", "export const first = 1;\n")
	assertFile(t, root, "src/second.ts", "export const second = 2;\n")
}

func TestApplyFileChangesRejectsUnsafeTargets(t *testing.T) {
	root := createPatchWorkspace(t, map[string]string{})
	err := applyExpectError(root, []llm.ParsedFileChange{
		{
			Path:   "../outside.ts",
			Action: llm.FileActionCreate,
			Diff:   "--- a/../outside.ts\n+++ b/../outside.ts\n@@ -0,0 +1,1 @@\n+bad",
		},
	})
	var patchErr *Error
	if !errors.As(err, &patchErr) || patchErr.Code != "PATH_INVALID" {
		t.Fatalf("expected PATH_INVALID, got %T %v", err, err)
	}
}

func createPatchWorkspace(t *testing.T, files map[string]string) string {
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

func assertFile(t *testing.T, root string, relativePath string, expected string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != expected {
		t.Fatalf("expected %q, got %q", expected, string(data))
	}
}

func applyExpectError(root string, changes []llm.ParsedFileChange) error {
	_, err := ApplyFileChanges(root, changes)
	return err
}
