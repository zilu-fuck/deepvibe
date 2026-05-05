package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var reservedDirectories = map[string]bool{
	".git":      true,
	".deepvibe": true,
}

type PathSafetyError struct {
	Code    string
	Message string
}

func (e *PathSafetyError) Error() string {
	return e.Message
}

func ResolveProjectTargetPath(rootDir string, relativePath string) (string, error) {
	rootPath, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}
	rootPath, err = filepath.EvalSymlinks(rootPath)
	if err != nil {
		return "", err
	}

	normalizedRelativePath := NormalizeRelativePath(relativePath)
	if normalizedRelativePath == "" {
		return "", &PathSafetyError{Code: "PATH_INVALID", Message: "Target path must not be empty."}
	}
	if filepath.IsAbs(normalizedRelativePath) || strings.HasPrefix(normalizedRelativePath, "//") {
		return "", &PathSafetyError{Code: "PATH_INVALID", Message: fmt.Sprintf("Absolute paths are not allowed: %s", relativePath)}
	}

	segments := strings.Split(normalizedRelativePath, "/")
	for _, segment := range segments {
		if segment == ".." {
			return "", &PathSafetyError{Code: "PATH_INVALID", Message: fmt.Sprintf("Path traversal is not allowed: %s", relativePath)}
		}
		if reservedDirectories[segment] {
			return "", &PathSafetyError{Code: "PATH_RESERVED", Message: fmt.Sprintf("Reserved directories cannot be modified: %s", relativePath)}
		}
	}

	targetPath := filepath.Join(rootPath, filepath.FromSlash(normalizedRelativePath))
	boundaryPath, err := findBoundaryPath(rootPath, targetPath)
	if err != nil {
		return "", err
	}

	normalizedBoundary := normalizeForComparison(boundaryPath)
	normalizedRoot := normalizeForComparison(rootPath)
	if normalizedBoundary != normalizedRoot && !strings.HasPrefix(normalizedBoundary, normalizedRoot+string(filepath.Separator)) {
		return "", &PathSafetyError{Code: "PATH_ESCAPE", Message: fmt.Sprintf("Resolved path escapes the project root: %s", relativePath)}
	}

	return targetPath, nil
}

func ResolveExistingProjectPath(rootDir string, relativePath string) (string, error) {
	targetPath, err := ResolveProjectTargetPath(rootDir, relativePath)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(targetPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", &PathSafetyError{Code: "PATH_MISSING", Message: fmt.Sprintf("Path does not exist: %s", relativePath)}
		}
		return "", err
	}
	return filepath.EvalSymlinks(targetPath)
}

func NormalizeRelativePath(filePath string) string {
	path := filepath.ToSlash(filePath)
	return strings.TrimPrefix(path, "./")
}

func findBoundaryPath(rootPath string, targetPath string) (string, error) {
	if _, err := os.Stat(targetPath); err == nil {
		return filepath.EvalSymlinks(targetPath)
	}

	currentPath := filepath.Dir(targetPath)
	for normalizeForComparison(currentPath) != normalizeForComparison(rootPath) {
		if _, err := os.Stat(currentPath); err == nil {
			return filepath.EvalSymlinks(currentPath)
		}
		parentPath := filepath.Dir(currentPath)
		if parentPath == currentPath {
			break
		}
		currentPath = parentPath
	}

	return rootPath, nil
}

func normalizeForComparison(targetPath string) string {
	return strings.ToLower(filepath.Clean(targetPath))
}
