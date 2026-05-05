package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectRepositoryNonGit(t *testing.T) {
	state := InspectRepository(context.Background(), t.TempDir())
	if state.IsRepository || state.IsDirty || state.CurrentHead != "" {
		t.Fatalf("unexpected repository state: %#v", state)
	}
}

func TestRecordOperationAndUndo(t *testing.T) {
	root := createGitWorkspace(t, map[string]string{
		"src/api.ts": "export const value = 2;\n",
	})
	before := "export const value = 1;\n"
	after := "export const value = 2;\n"
	record, err := RecordOperation(root, RepositoryState{
		CurrentHead:  "abc123",
		IsDirty:      true,
		IsRepository: true,
	}, []OperationSnapshot{
		{Path: "src/api.ts", BeforeContent: &before, AfterContent: &after},
	}, "Update API value")
	if err != nil {
		t.Fatal(err)
	}
	if record.OperationID == "" || record.BaseHead != "abc123" {
		t.Fatalf("unexpected operation record: %#v", record)
	}

	operationPath := filepath.Join(root, ".deepvibe", "operations", record.OperationID+".json")
	data, err := os.ReadFile(operationPath)
	if err != nil {
		t.Fatal(err)
	}
	var persisted RecordedOperation
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Files[0].Path != "src/api.ts" || persisted.Files[0].BeforeContent == nil {
		t.Fatalf("unexpected persisted operation: %#v", persisted)
	}

	result, err := UndoLastAIChange(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "operation" || result.Reference != record.OperationID {
		t.Fatalf("unexpected undo result: %#v", result)
	}
	assertGitFile(t, root, "src/api.ts", before)
	if _, err := os.Stat(filepath.Join(root, ".deepvibe", "last-action.json")); !os.IsNotExist(err) {
		t.Fatalf("expected last action to be removed, got %v", err)
	}
}

func TestUndoOperationRejectsChangedTarget(t *testing.T) {
	root := createGitWorkspace(t, map[string]string{
		"src/api.ts": "export const value = 2;\n",
	})
	before := "export const value = 1;\n"
	after := "export const value = 2;\n"
	if _, err := RecordOperation(root, RepositoryState{IsRepository: true, IsDirty: true}, []OperationSnapshot{
		{Path: "src/api.ts", BeforeContent: &before, AfterContent: &after},
	}, "Update API value"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "api.ts"), []byte("export const value = 3;\n"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := UndoLastAIChange(context.Background(), root)
	if err == nil || !strings.Contains(err.Error(), "has changed since the AI operation") {
		t.Fatalf("expected changed target error, got %v", err)
	}
}

func createGitWorkspace(t *testing.T, files map[string]string) string {
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

func assertGitFile(t *testing.T, root string, relativePath string, expected string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != expected {
		t.Fatalf("expected %q, got %q", expected, string(data))
	}
}
