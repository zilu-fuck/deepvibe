package patcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/zilu-fuck/deepvibe/internal/llm"
	"github.com/zilu-fuck/deepvibe/internal/workspace"
)

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string {
	return e.Message
}

type AppliedFileChange struct {
	Action        llm.FileAction `json:"action"`
	AfterContent *string        `json:"afterContent"`
	BeforeContent *string       `json:"beforeContent"`
	Path          string        `json:"path"`
}

func ApplyFileChanges(rootDir string, changes []llm.ParsedFileChange) ([]AppliedFileChange, error) {
	rootPath, err := filepath.Abs(rootDir)
	if err != nil {
		return nil, err
	}
	rootPath, err = filepath.EvalSymlinks(rootPath)
	if err != nil {
		return nil, err
	}

	backups := map[string]*string{}
	applied := make([]AppliedFileChange, 0, len(changes))
	for _, change := range changes {
		targetPath, err := validateTargetPath(rootPath, change.Path)
		if err != nil {
			rollbackErr := rollbackChanges(backups)
			return nil, wrapRollback(err, rollbackErr)
		}

		var originalContent *string
		if data, err := os.ReadFile(targetPath); err == nil {
			value := string(data)
			originalContent = &value
		} else if !errors.Is(err, os.ErrNotExist) {
			rollbackErr := rollbackChanges(backups)
			return nil, wrapRollback(err, rollbackErr)
		}
		if _, exists := backups[targetPath]; !exists {
			backups[targetPath] = originalContent
		}

		nextContent, err := computeNextContent(originalContent, change)
		if err != nil {
			rollbackErr := rollbackChanges(backups)
			return nil, wrapRollback(err, rollbackErr)
		}

		var afterContent *string
		if change.Action == llm.FileActionDelete {
			if nextContent != "" {
				rollbackErr := rollbackChanges(backups)
				return nil, wrapRollback(&Error{Code: "DELETE_DIFF_INVALID", Message: fmt.Sprintf("Delete action for %s did not resolve to an empty file.", change.Path)}, rollbackErr)
			}
			if err := os.Remove(targetPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				rollbackErr := rollbackChanges(backups)
				return nil, wrapRollback(err, rollbackErr)
			}
		} else {
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				rollbackErr := rollbackChanges(backups)
				return nil, wrapRollback(err, rollbackErr)
			}
			if err := os.WriteFile(targetPath, []byte(nextContent), 0644); err != nil {
				rollbackErr := rollbackChanges(backups)
				return nil, wrapRollback(err, rollbackErr)
			}
			afterContent = &nextContent
		}

		applied = append(applied, AppliedFileChange{
			Action:        change.Action,
			AfterContent: afterContent,
			BeforeContent: originalContent,
			Path:          workspace.NormalizeRelativePath(change.Path),
		})
	}

	return applied, nil
}

func validateTargetPath(rootPath string, relativePath string) (string, error) {
	targetPath, err := workspace.ResolveProjectTargetPath(rootPath, relativePath)
	if err != nil {
		var pathErr *workspace.PathSafetyError
		if errors.As(err, &pathErr) {
			return "", &Error{Code: pathErr.Code, Message: pathErr.Message}
		}
		return "", err
	}
	return targetPath, nil
}

func computeNextContent(originalContent *string, change llm.ParsedFileChange) (string, error) {
	source := ""
	if originalContent != nil {
		source = *originalContent
	}
	next, err := applyUnifiedDiff(source, change.Diff)
	if err != nil {
		return "", &Error{Code: "PATCH_FAILED", Message: fmt.Sprintf("Failed to apply diff for %s: %v", change.Path, err)}
	}
	return next, nil
}

func rollbackChanges(backups map[string]*string) error {
	for targetPath, originalContent := range backups {
		if originalContent == nil {
			if err := os.Remove(targetPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, []byte(*originalContent), 0644); err != nil {
			return err
		}
	}
	return nil
}

func wrapRollback(original error, rollback error) error {
	if rollback == nil {
		return original
	}
	return &Error{
		Code:    "ROLLBACK_FAILED",
		Message: fmt.Sprintf("Failed to apply changes and rollback also failed. Original: %v. Rollback: %v", original, rollback),
	}
}

type hunkHeader struct {
	OldStart int
	OldCount int
	NewStart int
	NewCount int
}

var hunkPattern = regexp.MustCompile(`^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@`)

func applyUnifiedDiff(source string, diff string) (string, error) {
	source = normalizeLineEndings(source)
	sourceLines := splitPatchLines(source)
	diffLines := strings.Split(normalizeLineEndings(diff), "\n")
	output := make([]string, 0, len(sourceLines))
	sourceIndex := 0
	sawHunk := false

	for i := 0; i < len(diffLines); i++ {
		line := diffLines[i]
		if strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") || strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, "@@") {
			continue
		}

		header, err := parseHunkHeader(line)
		if err != nil {
			return "", err
		}
		sawHunk = true
		targetIndex := header.OldStart - 1
		if header.OldStart == 0 {
			targetIndex = 0
		}
		if targetIndex < sourceIndex || targetIndex > len(sourceLines) {
			return "", fmt.Errorf("hunk starts at invalid source line %d", header.OldStart)
		}
		output = append(output, sourceLines[sourceIndex:targetIndex]...)
		sourceIndex = targetIndex

		i++
		oldSeen := 0
		newSeen := 0
		for ; i < len(diffLines); i++ {
			line = diffLines[i]
			if strings.HasPrefix(line, "@@") {
				i--
				break
			}
			if line == `\ No newline at end of file` {
				continue
			}
			if line == "" {
				line = " "
			}
			prefix := line[0]
			text := line[1:]
			switch prefix {
			case ' ':
				if sourceIndex >= len(sourceLines) || sourceLines[sourceIndex] != text {
					return "", fmt.Errorf("context mismatch at source line %d", sourceIndex+1)
				}
				output = append(output, text)
				sourceIndex++
				oldSeen++
				newSeen++
			case '-':
				if sourceIndex >= len(sourceLines) || sourceLines[sourceIndex] != text {
					return "", fmt.Errorf("delete mismatch at source line %d", sourceIndex+1)
				}
				sourceIndex++
				oldSeen++
			case '+':
				output = append(output, text)
				newSeen++
			default:
				return "", fmt.Errorf("unsupported hunk line %q", line)
			}
		}
		if oldSeen != header.OldCount {
			return "", fmt.Errorf("hunk old line count mismatch: expected %d got %d", header.OldCount, oldSeen)
		}
		if newSeen != header.NewCount {
			return "", fmt.Errorf("hunk new line count mismatch: expected %d got %d", header.NewCount, newSeen)
		}
	}

	if !sawHunk {
		return "", fmt.Errorf("diff contained no hunks")
	}
	output = append(output, sourceLines[sourceIndex:]...)
	if len(output) == 0 {
		return "", nil
	}
	return strings.Join(output, "\n") + "\n", nil
}

func parseHunkHeader(line string) (hunkHeader, error) {
	match := hunkPattern.FindStringSubmatch(line)
	if len(match) == 0 {
		return hunkHeader{}, fmt.Errorf("invalid hunk header %q", line)
	}
	oldStart, _ := strconv.Atoi(match[1])
	oldCount := parseOptionalCount(match[2])
	newStart, _ := strconv.Atoi(match[3])
	newCount := parseOptionalCount(match[4])
	return hunkHeader{
		OldStart: oldStart,
		OldCount: oldCount,
		NewStart: newStart,
		NewCount: newCount,
	}, nil
}

func parseOptionalCount(value string) int {
	if value == "" {
		return 1
	}
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func splitPatchLines(content string) []string {
	if content == "" {
		return nil
	}
	trimmed := strings.TrimSuffix(content, "\n")
	if trimmed == "" {
		return []string{""}
	}
	return strings.Split(trimmed, "\n")
}

func normalizeLineEndings(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}
