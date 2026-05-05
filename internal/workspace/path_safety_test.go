package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveProjectTargetPathRejectsTraversalAndReservedDirs(t *testing.T) {
	root := t.TempDir()

	cases := []struct {
		name string
		path string
		code string
	}{
		{name: "traversal", path: "../outside.txt", code: "PATH_INVALID"},
		{name: "reserved git", path: ".git/config", code: "PATH_RESERVED"},
		{name: "reserved deepvibe", path: ".deepvibe/config.json", code: "PATH_RESERVED"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ResolveProjectTargetPath(root, tc.path)
			var pathErr *PathSafetyError
			if !errors.As(err, &pathErr) {
				t.Fatalf("expected PathSafetyError, got %T %v", err, err)
			}
			if pathErr.Code != tc.code {
				t.Fatalf("expected code %s, got %s", tc.code, pathErr.Code)
			}
		})
	}
}

func TestResolveExistingProjectPath(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "src", "api.go")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("package src\n"), 0644); err != nil {
		t.Fatal(err)
	}

	resolved, err := ResolveExistingProjectPath(root, "src/api.go")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(resolved) != filepath.Clean(target) {
		t.Fatalf("expected %s, got %s", target, resolved)
	}
}
