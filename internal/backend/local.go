package backend

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/zilu-fuck/deepvibe/internal/workspace"
)

const defaultListLimit = 20
const defaultReadCharLimit = 12000
const defaultExecuteTimeoutMs = 15000
const defaultExecuteMaxOutputChars = 16000

type LocalBackend struct {
	rootDir string
}

func NewLocal(rootDir string) *LocalBackend {
	return &LocalBackend{rootDir: filepath.Clean(rootDir)}
}

func (b *LocalBackend) Root() string {
	return b.rootDir
}

func (b *LocalBackend) ListFiles(ctx context.Context, request ListFilesRequest) (*ListFilesResult, error) {
	directory := strings.TrimSpace(request.Directory)
	if directory == "" {
		directory = "."
	}
	limit := request.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > 100 {
		limit = 100
	}
	pattern := request.Pattern
	if pattern == "" {
		pattern = "*"
	}

	absoluteDir, err := workspace.ResolveExistingProjectPath(b.rootDir, directory)
	if err != nil {
		return nil, err
	}

	files := []string{}
	if err := filepath.WalkDir(absoluteDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == ".deepvibe" || name == "node_modules" || name == "dist" || name == "build" {
				if path != absoluteDir {
					return filepath.SkipDir
				}
			}
			return nil
		}

		matched := true
		if pattern != "*" && pattern != "**/*" {
			matched, _ = filepath.Match(pattern, entry.Name())
		}
		if !matched {
			return nil
		}

		rel, err := filepath.Rel(b.rootDir, path)
		if err != nil {
			return err
		}
		files = append(files, workspace.NormalizeRelativePath(rel))
		return nil
	}); err != nil {
		return nil, err
	}

	sort.Strings(files)
	if len(files) > limit {
		files = files[:limit]
	}

	relDir, _ := filepath.Rel(b.rootDir, absoluteDir)
	return &ListFilesResult{
		Directory: workspace.NormalizeRelativePath(relDir),
		Files:     files,
	}, nil
}

func (b *LocalBackend) ReadFile(ctx context.Context, request ReadFileRequest) (*ReadFileResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	absolutePath, err := workspace.ResolveExistingProjectPath(b.rootDir, request.Path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(absolutePath)
	if err != nil {
		return nil, err
	}
	content := string(data)
	maxChars := request.MaxChars
	if maxChars <= 0 {
		maxChars = defaultReadCharLimit
	}
	if maxChars < 64 {
		maxChars = 64
	}
	if maxChars > 50000 {
		maxChars = 50000
	}
	truncated := len(content) > maxChars
	if truncated {
		content = content[:maxChars] + "\n... [truncated by tool] ..."
	}

	rel, _ := filepath.Rel(b.rootDir, absolutePath)
	return &ReadFileResult{
		Content:   content,
		Path:      workspace.NormalizeRelativePath(rel),
		Truncated: truncated,
	}, nil
}

func (b *LocalBackend) WriteFile(ctx context.Context, request WriteFileRequest) (*WriteFileResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	relativePath := workspace.NormalizeRelativePath(request.Path)
	absolutePath, err := workspace.ResolveProjectTargetPath(b.rootDir, relativePath)
	if err != nil {
		return nil, err
	}

	var beforeContent *string
	if data, err := os.ReadFile(absolutePath); err == nil {
		value := string(data)
		beforeContent = &value
	}

	if err := os.MkdirAll(filepath.Dir(absolutePath), 0755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(absolutePath, []byte(request.Content), 0644); err != nil {
		return nil, err
	}

	action := "modify"
	if beforeContent == nil {
		action = "create"
	}
	afterContent := request.Content
	return &WriteFileResult{
		Action:        action,
		AfterContent: &afterContent,
		BeforeContent: beforeContent,
		Bytes:         len([]byte(request.Content)),
		Path:          relativePath,
	}, nil
}

func (b *LocalBackend) DeleteFile(ctx context.Context, request DeleteFileRequest) (*DeleteFileResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	relativePath := workspace.NormalizeRelativePath(request.Path)
	absolutePath, err := workspace.ResolveProjectTargetPath(b.rootDir, relativePath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(absolutePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("file does not exist: %s", relativePath)
		}
		return nil, err
	}
	beforeContent := string(data)

	if err := os.Remove(absolutePath); err != nil {
		return nil, err
	}
	return &DeleteFileResult{
		BeforeContent: &beforeContent,
		Path:          relativePath,
	}, nil
}

func (b *LocalBackend) Execute(ctx context.Context, request ExecuteRequest) (*ExecuteResult, error) {
	timeoutMs := request.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultExecuteTimeoutMs
	}
	maxOutputChars := request.MaxOutputChars
	if maxOutputChars <= 0 {
		maxOutputChars = defaultExecuteMaxOutputChars
	}
	workingDirectory := request.CWD
	if workingDirectory == "" {
		workingDirectory = b.rootDir
	}

	commandCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(commandCtx, "powershell.exe", "-NoProfile", "-Command", request.Command)
	} else {
		cmd = exec.CommandContext(commandCtx, "sh", "-lc", request.Command)
	}
	cmd.Dir = workingDirectory

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result := &ExecuteResult{
		ExitCode: 0,
		Stdout:   truncateOutput(stdout.String(), maxOutputChars),
		Stderr:   truncateOutput(stderr.String(), maxOutputChars),
	}
	if err == nil {
		return result, nil
	}
	if commandCtx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("command timed out after %dms", timeoutMs)
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	}
	return nil, err
}

func truncateOutput(value string, maxChars int) string {
	if len(value) <= maxChars {
		return value
	}
	return value[:maxChars] + "\n... [truncated by backend] ..."
}
