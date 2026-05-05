package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	gitmanager "github.com/zilu-fuck/deepvibe/internal/git"
)

func TestRunUndoCommand(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(cwd, "src", "api.ts")
	before := "export const value = 1;\n"
	after := "export const value = 2;\n"
	if err := os.WriteFile(target, []byte(after), 0644); err != nil {
		t.Fatal(err)
	}
	record, err := gitmanager.RecordOperation(cwd, gitmanager.RepositoryState{
		CurrentHead:  "abc123",
		IsDirty:      true,
		IsRepository: true,
	}, []gitmanager.OperationSnapshot{
		{Path: "src/api.ts", BeforeContent: &before, AfterContent: &after},
	}, "Update API value")
	if err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), []string{"deepvibe", "undo"}, &stdout, &stderr, func() (string, error) {
		return cwd, nil
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Undo complete: kind=operation reference="+record.OperationID) {
		t.Fatalf("unexpected stdout: %s", stdout.String())
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != before {
		t.Fatalf("expected file restored to %q, got %q", before, string(data))
	}
}

func TestUsageIncludesChatAndUndo(t *testing.T) {
	var stdout bytes.Buffer
	code := Run(context.Background(), []string{"deepvibe", "--help"}, &stdout, &bytes.Buffer{}, func() (string, error) {
		return t.TempDir(), nil
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if !strings.Contains(stdout.String(), "deepvibe undo") {
		t.Fatalf("usage did not include undo:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "deepvibe chat") {
		t.Fatalf("usage did not include chat:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "deepvibe plugins") {
		t.Fatalf("usage did not include plugins:\n%s", stdout.String())
	}
}

func TestRunPluginsCommandJSON(t *testing.T) {
	cwd := t.TempDir()
	pluginDir := filepath.Join(cwd, ".deepvibe", "plugins", "alpha")
	if err := os.MkdirAll(pluginDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "index.js"), []byte("module.exports = {};"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(`{"name":"alpha","entry":"index.js"}`), 0644); err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), []string{"deepvibe", "plugins", "--json"}, &stdout, &stderr, func() (string, error) {
		return cwd, nil
	})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stderr=%s", code, stderr.String())
	}
	var payload struct {
		EnabledCount int `json:"enabledCount"`
		ErrorCount   int `json:"errorCount"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.EnabledCount != 1 || payload.ErrorCount != 0 {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}
