package backend

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLocalBackendListReadWriteDelete(t *testing.T) {
	root := createBackendWorkspace(t, map[string]string{
		"src/api.go":   "package src\nconst Value = 1\n",
		"src/other.go": "package src\n",
	})
	b := NewLocal(root)

	listed, err := b.ListFiles(context.Background(), ListFilesRequest{Directory: "src", Limit: 10, Pattern: "*.go"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(listed.Files, ",") != "src/api.go,src/other.go" {
		t.Fatalf("unexpected files: %#v", listed.Files)
	}

	read, err := b.ReadFile(context.Background(), ReadFileRequest{Path: "src/api.go"})
	if err != nil {
		t.Fatal(err)
	}
	if read.Path != "src/api.go" || !strings.Contains(read.Content, "const Value = 1") {
		t.Fatalf("unexpected read result: %#v", read)
	}

	written, err := b.WriteFile(context.Background(), WriteFileRequest{
		Path:    "src/api.go",
		Content: "package src\nconst Value = 2\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	if written.Action != "modify" || written.BeforeContent == nil || *written.BeforeContent != "package src\nconst Value = 1\n" {
		t.Fatalf("unexpected write result: %#v", written)
	}

	deleted, err := b.DeleteFile(context.Background(), DeleteFileRequest{Path: "src/api.go"})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.BeforeContent == nil || !strings.Contains(*deleted.BeforeContent, "Value = 2") {
		t.Fatalf("unexpected delete result: %#v", deleted)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "api.go")); !os.IsNotExist(err) {
		t.Fatalf("expected file deleted, stat err=%v", err)
	}
}

func TestLocalBackendRejectsPathEscape(t *testing.T) {
	root := createBackendWorkspace(t, map[string]string{"src/api.go": "package src\n"})
	b := NewLocal(root)

	if _, err := b.ReadFile(context.Background(), ReadFileRequest{Path: "../outside.go"}); err == nil {
		t.Fatalf("expected path escape error")
	}
	if _, err := b.WriteFile(context.Background(), WriteFileRequest{Path: ".deepvibe/context.json", Content: "{}"}); err == nil {
		t.Fatalf("expected reserved path error")
	}
}

func TestLocalBackendExecute(t *testing.T) {
	root := t.TempDir()
	b := NewLocal(root)
	command := "printf hello"
	if runtime.GOOS == "windows" {
		command = "Write-Output hello"
	}

	result, err := b.Execute(context.Background(), ExecuteRequest{
		Command:        command,
		CWD:            root,
		MaxOutputChars: 100,
		TimeoutMs:      5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "hello") {
		t.Fatalf("unexpected execute result: %#v", result)
	}
}

func createBackendWorkspace(t *testing.T, files map[string]string) string {
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
