package scanner

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var defaultIgnores = []string{
	"node_modules/**",
	".git/**",
	".gitignore",
	".deepvibeignore",
	"dist/**",
	"build/**",
}

var explicitPathPattern = regexp.MustCompile(`@([^\s"'` + "`" + `]+\.[a-zA-Z0-9]+)`)
var keywordPattern = regexp.MustCompile(`[a-z0-9_-]{2,}`)

type Options struct {
	RootDir        string
	Instruction    string
	MaxCandidates  int
	IgnorePatterns []string
	RecentGitFiles []string
}

type Result struct {
	Candidates    []string `json:"candidates"`
	ExplicitPaths []string `json:"explicitPaths"`
	ScannedFiles  int      `json:"scannedFiles"`
}

func ScanProject(ctx context.Context, options Options) (*Result, error) {
	rootDir, err := filepath.Abs(options.RootDir)
	if err != nil {
		return nil, err
	}

	maxCandidates := options.MaxCandidates
	if maxCandidates <= 0 {
		maxCandidates = 5
	}

	files, err := listFiles(rootDir)
	if err != nil {
		return nil, err
	}

	ignoreMatcher, err := buildIgnoreMatcher(rootDir, options.IgnorePatterns)
	if err != nil {
		return nil, err
	}

	fileSet := map[string]bool{}
	filtered := make([]string, 0, len(files))
	for _, file := range files {
		normalized := normalizeRelativePath(file)
		fileSet[normalized] = true
		if !ignoreMatcher.Ignores(normalized) {
			filtered = append(filtered, normalized)
		}
	}

	explicitPaths := extractExplicitPaths(options.Instruction)
	recentFiles := options.RecentGitFiles
	if recentFiles == nil {
		recentFiles = listRecentGitFiles(ctx, rootDir)
	}
	recentSet := map[string]bool{}
	for _, file := range recentFiles {
		recentSet[normalizeRelativePath(file)] = true
	}

	keywords := extractKeywords(options.Instruction)
	explicitSet := map[string]bool{}
	for _, file := range explicitPaths {
		explicitSet[file] = true
	}

	scored := make([]scoredFile, 0, len(filtered))
	for _, file := range filtered {
		if explicitSet[file] {
			continue
		}
		scored = append(scored, scoredFile{
			Path:  file,
			Score: scoreFile(file, keywords, recentSet, fileSet),
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		return scored[i].Path < scored[j].Path
	})

	forced := make([]string, 0, len(explicitPaths))
	for _, file := range explicitPaths {
		if fileSet[file] {
			forced = append(forced, file)
		}
	}

	candidates := append([]string(nil), forced...)
	for _, item := range scored {
		if len(candidates) >= len(forced)+maxCandidates {
			break
		}
		candidates = append(candidates, item.Path)
	}

	return &Result{
		Candidates:    candidates,
		ExplicitPaths: forced,
		ScannedFiles:  len(filtered),
	}, nil
}

type scoredFile struct {
	Path  string
	Score int
}

func listFiles(rootDir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(rootDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == "node_modules" || name == "dist" || name == "build" {
				if path != rootDir {
					return filepath.SkipDir
				}
			}
			return nil
		}

		rel, err := filepath.Rel(rootDir, path)
		if err != nil {
			return err
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func listRecentGitFiles(ctx context.Context, rootDir string) []string {
	cmd := exec.CommandContext(ctx, "git", "-C", rootDir, "status", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return nil
	}

	var files []string
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 4 {
			continue
		}
		pathPart := strings.TrimSpace(line[3:])
		if strings.Contains(pathPart, " -> ") {
			parts := strings.Split(pathPart, " -> ")
			pathPart = parts[len(parts)-1]
		}
		if pathPart != "" {
			files = append(files, pathPart)
		}
	}
	return files
}

func extractExplicitPaths(instruction string) []string {
	seen := map[string]bool{}
	var paths []string
	for _, match := range explicitPathPattern.FindAllStringSubmatch(instruction, -1) {
		if len(match) < 2 {
			continue
		}
		path := strings.TrimRight(match[1], "),.;:!?")
		path = normalizeRelativePath(path)
		if path != "" && !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	return paths
}

func extractKeywords(instruction string) []string {
	lower := strings.ToLower(instruction)
	matches := keywordPattern.FindAllString(lower, -1)
	seen := map[string]bool{}
	var keywords []string
	for _, match := range matches {
		if !seen[match] {
			seen[match] = true
			keywords = append(keywords, match)
		}
	}
	return keywords
}

func scoreFile(filePath string, keywords []string, recentFiles map[string]bool, allFiles map[string]bool) int {
	score := 0
	normalized := strings.ToLower(filePath)
	if recentFiles[filePath] {
		score += 10
	}
	for _, keyword := range keywords {
		if strings.Contains(normalized, keyword) {
			score += 8
			break
		}
	}
	if hasCompanionTest(filePath, allFiles) {
		score += 3
	}
	return score
}

func hasCompanionTest(filePath string, allFiles map[string]bool) bool {
	ext := filepath.Ext(filePath)
	withoutExt := strings.TrimSuffix(filePath, ext)
	normalized := normalizeRelativePath(filePath)

	if isTestFile(normalized) {
		sourceCandidate := strings.TrimSuffix(withoutExt, ".test")
		sourceCandidate = strings.TrimSuffix(sourceCandidate, ".spec")
		sourceCandidate = strings.TrimPrefix(sourceCandidate, "tests/")
		return ext != "" && (allFiles[sourceCandidate+ext] || allFiles["src/"+sourceCandidate+ext])
	}

	dir, name := filepath.Split(normalized)
	base := strings.TrimSuffix(name, ext)
	candidates := []string{
		normalizeRelativePath(filepath.Join(dir, base+".test"+ext)),
		normalizeRelativePath(filepath.Join(dir, base+".spec"+ext)),
		normalizeRelativePath(filepath.Join("tests", dir, base+".test"+ext)),
		normalizeRelativePath(filepath.Join("tests", dir, base+".spec"+ext)),
	}
	for _, candidate := range candidates {
		if allFiles[candidate] {
			return true
		}
	}
	return false
}

func isTestFile(filePath string) bool {
	return strings.HasPrefix(filePath, "tests/") ||
		strings.Contains(filePath, ".test.") ||
		strings.Contains(filePath, ".spec.")
}

func normalizeRelativePath(filePath string) string {
	path := filepath.ToSlash(filePath)
	path = strings.TrimPrefix(path, "./")
	return path
}

type ignoreMatcher struct {
	patterns []string
}

func buildIgnoreMatcher(rootDir string, extraPatterns []string) (*ignoreMatcher, error) {
	patterns := append([]string(nil), defaultIgnores...)
	for _, name := range []string{".gitignore", ".deepvibeignore"} {
		lines, err := readIgnoreLines(filepath.Join(rootDir, name))
		if err != nil {
			return nil, err
		}
		patterns = append(patterns, lines...)
	}
	patterns = append(patterns, extraPatterns...)
	return &ignoreMatcher{patterns: cleanPatterns(patterns)}, nil
}

func readIgnoreLines(filePath string) ([]string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" && !strings.HasPrefix(line, "#") {
			lines = append(lines, line)
		}
	}
	return lines, scanner.Err()
}

func cleanPatterns(patterns []string) []string {
	var cleaned []string
	for _, pattern := range patterns {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" || strings.HasPrefix(pattern, "!") {
			continue
		}
		cleaned = append(cleaned, normalizeRelativePath(pattern))
	}
	return cleaned
}

func (m *ignoreMatcher) Ignores(path string) bool {
	path = normalizeRelativePath(path)
	base := filepath.Base(path)
	for _, pattern := range m.patterns {
		if pattern == path {
			return true
		}
		if strings.HasSuffix(pattern, "/**") {
			prefix := strings.TrimSuffix(pattern, "/**")
			if path == prefix || strings.HasPrefix(path, prefix+"/") {
				return true
			}
		}
		if strings.HasSuffix(pattern, "/") && strings.HasPrefix(path, strings.TrimSuffix(pattern, "/")+"/") {
			return true
		}
		if !strings.Contains(pattern, "/") {
			matched, _ := filepath.Match(pattern, base)
			if matched {
				return true
			}
			continue
		}
		matched, _ := filepath.Match(pattern, path)
		if matched {
			return true
		}
	}
	return false
}
