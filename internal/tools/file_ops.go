package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/workspace"
)

type ListFilesTool struct{}
type ReadFileTool struct{}
type WriteFileTool struct{}
type DeleteFileTool struct{}

func (t ListFilesTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "list_files",
			Description: "List project files under a directory.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"directory": map[string]any{"type": "string"},
					"limit":     map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
					"pattern":   map[string]any{"type": "string"},
				},
			},
		},
	}
}

func (t ListFilesTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Directory string `json:"directory"`
		Limit     int    `json:"limit"`
		Pattern   string `json:"pattern"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}

	result, err := resolveToolBackend(execCtx).ListFiles(ctx, backend.ListFilesRequest{
		Directory: parsed.Directory,
		Limit:     parsed.Limit,
		Pattern:   parsed.Pattern,
	})
	if err != nil {
		return "", err
	}
	return encodeToolJSON(map[string]any{
		"ok":        true,
		"directory": result.Directory,
		"files":     result.Files,
	})
}

func (t ReadFileTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "read_file",
			Description: "Read a text file from the project root.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"path"},
				"properties": map[string]any{
					"path":      map[string]any{"type": "string"},
					"max_chars": map[string]any{"type": "integer", "minimum": 64, "maximum": 50000},
				},
			},
		},
	}
}

func (t ReadFileTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Path     string `json:"path"`
		MaxChars int    `json:"max_chars"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.Path) == "" {
		return "", fmt.Errorf(`read_file requires a non-empty "path" argument`)
	}

	result, err := resolveToolBackend(execCtx).ReadFile(ctx, backend.ReadFileRequest{
		MaxChars: parsed.MaxChars,
		Path:     parsed.Path,
	})
	if err != nil {
		return "", err
	}
	return encodeToolJSON(map[string]any{
		"ok":        true,
		"path":      result.Path,
		"truncated": result.Truncated,
		"content":   result.Content,
	})
}

func (t WriteFileTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "write_file",
			Description: "Write UTF-8 text to a file inside the project root.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"path", "content"},
				"properties": map[string]any{
					"path":    map[string]any{"type": "string"},
					"content": map[string]any{"type": "string"},
				},
			},
		},
	}
}

func (t WriteFileTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.Path) == "" {
		return "", fmt.Errorf(`write_file requires a non-empty "path" argument`)
	}
	if execCtx.Mutations == nil {
		return "", fmt.Errorf("write_file is unavailable because mutation tracking is not enabled")
	}

	relativePath := workspace.NormalizeRelativePath(parsed.Path)
	result, err := resolveToolBackend(execCtx).WriteFile(ctx, backend.WriteFileRequest{
		Content: parsed.Content,
		Path:    relativePath,
	})
	if err != nil {
		return "", err
	}
	recordMutation(execCtx.Mutations, AppliedFileChange{
		Action:        result.Action,
		AfterContent: result.AfterContent,
		BeforeContent: result.BeforeContent,
		Path:          result.Path,
	})

	return encodeToolJSON(map[string]any{
		"ok":    true,
		"path":  result.Path,
		"bytes": result.Bytes,
	})
}

func (t DeleteFileTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "delete_file",
			Description: "Delete a file inside the project root.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"path"},
				"properties": map[string]any{
					"path": map[string]any{"type": "string"},
				},
			},
		},
	}
}

func (t DeleteFileTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Path string `json:"path"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.Path) == "" {
		return "", fmt.Errorf(`delete_file requires a non-empty "path" argument`)
	}
	if execCtx.Mutations == nil {
		return "", fmt.Errorf("delete_file is unavailable because mutation tracking is not enabled")
	}

	relativePath := workspace.NormalizeRelativePath(parsed.Path)
	result, err := resolveToolBackend(execCtx).DeleteFile(ctx, backend.DeleteFileRequest{Path: relativePath})
	if err != nil {
		return "", err
	}
	recordMutation(execCtx.Mutations, AppliedFileChange{
		Action:        "delete",
		AfterContent: nil,
		BeforeContent: result.BeforeContent,
		Path:          result.Path,
	})

	return encodeToolJSON(map[string]any{
		"ok":   true,
		"path": result.Path,
	})
}

func ListToolMutations(state *MutationState) []AppliedFileChange {
	if state == nil {
		return nil
	}
	mutations := make([]AppliedFileChange, 0, len(state.Applied))
	for _, mutation := range state.Applied {
		mutations = append(mutations, mutation)
	}
	sort.Slice(mutations, func(i, j int) bool {
		return mutations[i].Path < mutations[j].Path
	})
	return mutations
}

func RollbackToolMutations(state *MutationState, rootDir string) error {
	mutations := ListToolMutations(state)
	for i := len(mutations) - 1; i >= 0; i-- {
		mutation := mutations[i]
		targetPath, err := workspace.ResolveProjectTargetPath(rootDir, mutation.Path)
		if err != nil {
			return err
		}
		if mutation.BeforeContent == nil {
			if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, []byte(*mutation.BeforeContent), 0644); err != nil {
			return err
		}
	}
	return nil
}

func recordMutation(state *MutationState, mutation AppliedFileChange) {
	if state.Applied == nil {
		state.Applied = map[string]AppliedFileChange{}
	}
	existing, exists := state.Applied[mutation.Path]
	if !exists {
		state.Applied[mutation.Path] = mutation
		return
	}

	merged := AppliedFileChange{
		Action:        "modify",
		AfterContent: mutation.AfterContent,
		BeforeContent: existing.BeforeContent,
		Path:          mutation.Path,
	}
	if mutation.AfterContent == nil {
		merged.Action = "delete"
	}
	if existing.BeforeContent == nil && mutation.AfterContent != nil {
		merged.Action = "create"
	}
	if existing.BeforeContent == nil && mutation.AfterContent == nil {
		delete(state.Applied, mutation.Path)
		return
	}
	state.Applied[mutation.Path] = merged
}

func parseToolArgs(args json.RawMessage, target any) error {
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if err := json.Unmarshal(args, target); err != nil {
		return fmt.Errorf("failed to parse tool arguments: %w", err)
	}
	return nil
}

func resolveToolRoot(execCtx ExecutionContext) string {
	if execCtx.RootDir != "" {
		return execCtx.RootDir
	}
	return execCtx.CWD
}

func resolveToolBackend(execCtx ExecutionContext) backend.Backend {
	if execCtx.Backend != nil {
		return execCtx.Backend
	}
	return backend.NewLocal(resolveToolRoot(execCtx))
}

func encodeToolJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
