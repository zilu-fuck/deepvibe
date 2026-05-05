package context

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const defaultContextWindowTokens = 1000000
const defaultResponseReserveTokens = 64000
const defaultMaxFiles = 12

type BuildOptions struct {
	RootDir                string
	HistorySummary         string
	Instruction            string
	Candidates             []string
	ExplicitPaths          []string
	MaxWindowTokens        int
	MaxFiles               int
	ProjectPrompt          string
	ReservedResponseTokens int
	SearchResults          []SearchResult
	SystemPrompt           string
	TopLevelEntryLimit     int
}

type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

type ContextFile struct {
	Path          string `json:"path"`
	Content       string `json:"content"`
	Mode          string `json:"mode"`
	TokenEstimate int    `json:"tokenEstimate"`
}

type BuildResult struct {
	Messages        []Message      `json:"messages"`
	Files           []ContextFile  `json:"files"`
	ProjectMetadata string         `json:"projectMetadata"`
	TokenEstimate   int            `json:"tokenEstimate"`
	MaxPromptTokens int            `json:"maxPromptTokens"`
	Truncated       bool           `json:"truncated"`
}

type fileDraft struct {
	Path     string
	Explicit bool
	RawText  string
}

func Build(options BuildOptions) (*BuildResult, error) {
	rootDir, err := filepath.Abs(options.RootDir)
	if err != nil {
		return nil, err
	}

	maxFiles := options.MaxFiles
	if maxFiles <= 0 {
		maxFiles = defaultMaxFiles
	}

	explicitPaths := map[string]bool{}
	for _, path := range options.ExplicitPaths {
		explicitPaths[normalizeRelativePath(path)] = true
	}

	candidates := dedupe(normalizeRelativePaths(options.Candidates))
	if len(candidates) > maxFiles {
		candidates = candidates[:maxFiles]
	}

	drafts := make([]fileDraft, 0, len(candidates))
	for _, candidate := range candidates {
		draft, err := loadFileDraft(rootDir, candidate, explicitPaths[candidate])
		if err != nil {
			continue
		}
		drafts = append(drafts, draft)
	}

	entryLimit := options.TopLevelEntryLimit
	if entryLimit <= 0 {
		entryLimit = 12
	}
	projectMetadata := buildProjectMetadata(rootDir, entryLimit)

	window := options.MaxWindowTokens
	if window <= 0 {
		window = defaultContextWindowTokens
	}
	reserve := options.ReservedResponseTokens
	if reserve <= 0 {
		reserve = defaultResponseReserveTokens
	}
	maxPromptTokens := window - reserve

	systemPrompt := options.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = SystemPrompt
	}
	systemMessage := Message{
		Role:    "system",
		Content: ComposeSystemPrompt(systemPrompt, strings.TrimSpace(options.ProjectPrompt)),
	}
	metadataMessage := Message{
		Role:    "user",
		Content: projectMetadata,
	}
	baseTokens := EstimateMessagesTokens([]Message{systemMessage, metadataMessage})
	if baseTokens > maxPromptTokens {
		projectMetadata = buildMinimalProjectMetadata(rootDir)
		metadataMessage.Content = projectMetadata
		baseTokens = EstimateMessagesTokens([]Message{systemMessage, metadataMessage})
	}

	emptyTaskTokens := EstimateMessageTokens(Message{
		Role:    "user",
		Content: buildTaskMessage(options.Instruction, nil, options.SearchResults, options.HistorySummary),
	})
	availableFileTokens := maxPromptTokens - baseTokens - emptyTaskTokens
	if availableFileTokens < 0 {
		availableFileTokens = 0
	}

	files := renderFiles(drafts, "full")
	if availableFileTokens == 0 {
		files = nil
	} else if estimateRenderedFilesTokens(files, options) > availableFileTokens {
		files = renderFiles(drafts, "compact")
	}
	if estimateRenderedFilesTokens(files, options) > availableFileTokens {
		files = renderFiles(drafts, "outline")
	}
	if estimateRenderedFilesTokens(files, options) > availableFileTokens {
		files = dropNonExplicitFiles(files, explicitPaths)
	}
	if estimateRenderedFilesTokens(files, options) > availableFileTokens {
		files = truncateFilesToBudget(files, availableFileTokens, options.Instruction)
	}
	if estimateRenderedFilesTokens(files, options) > availableFileTokens {
		files = forceFitFilesToBudget(files, explicitPaths, availableFileTokens, options)
	}

	taskMessage := Message{
		Role:    "user",
		Content: buildTaskMessage(options.Instruction, files, options.SearchResults, options.HistorySummary),
	}
	messages := []Message{systemMessage, metadataMessage, taskMessage}
	truncated := false
	for _, file := range files {
		if file.Mode != "full" {
			truncated = true
			break
		}
	}

	return &BuildResult{
		Messages:        messages,
		Files:           files,
		ProjectMetadata: projectMetadata,
		TokenEstimate:   EstimateMessagesTokens(messages),
		MaxPromptTokens: maxPromptTokens,
		Truncated:       truncated,
	}, nil
}

func loadFileDraft(rootDir string, filePath string, explicit bool) (fileDraft, error) {
	absolutePath := filepath.Join(rootDir, filepath.FromSlash(filePath))
	data, err := os.ReadFile(absolutePath)
	if err != nil {
		return fileDraft{}, err
	}
	return fileDraft{
		Path:     filePath,
		Explicit: explicit,
		RawText:  string(data),
	}, nil
}

func buildProjectMetadata(rootDir string, topLevelEntryLimit int) string {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		return buildMinimalProjectMetadata(rootDir)
	}

	filtered := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "dist" || entry.Name() == "build" {
			continue
		}
		filtered = append(filtered, entry)
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Name() < filtered[j].Name()
	})
	if len(filtered) > topLevelEntryLimit {
		filtered = filtered[:topLevelEntryLimit]
	}

	lines := []string{
		"Project metadata:",
		"- Root directory: " + filepath.Base(rootDir),
		"- Top-level structure:",
	}
	for _, entry := range filtered {
		kind := "file"
		if entry.IsDir() {
			kind = "dir"
		}
		lines = append(lines, "  - "+kind+": "+entry.Name())
	}
	return strings.Join(lines, "\n")
}

func buildMinimalProjectMetadata(rootDir string) string {
	return "Project metadata:\n- Root directory: " + filepath.Base(rootDir)
}

func renderFiles(drafts []fileDraft, mode string) []ContextFile {
	files := make([]ContextFile, 0, len(drafts))
	for _, draft := range drafts {
		content := draft.RawText
		switch mode {
		case "compact":
			content = compactText(draft.RawText)
		case "outline":
			content = outlineText(draft.RawText)
		}
		files = append(files, ContextFile{
			Path:          draft.Path,
			Content:       content,
			Mode:          mode,
			TokenEstimate: EstimateTextTokens(content),
		})
	}
	return files
}

func compactText(text string) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r\t ")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" ||
			strings.HasPrefix(trimmed, "//") ||
			trimmed == "/*" ||
			trimmed == "*/" ||
			strings.HasPrefix(trimmed, "*") {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func outlineText(text string) string {
	lines := strings.Split(compactText(text), "\n")
	var structural []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "import ") ||
			strings.HasPrefix(trimmed, "export ") ||
			strings.HasPrefix(trimmed, "type ") ||
			strings.HasPrefix(trimmed, "interface ") ||
			strings.HasPrefix(trimmed, "class ") ||
			strings.HasPrefix(trimmed, "func ") ||
			strings.HasPrefix(trimmed, "function ") ||
			strings.HasPrefix(trimmed, "const ") ||
			strings.Contains(trimmed, "=>") ||
			strings.HasSuffix(trimmed, "{") {
			structural = append(structural, line)
		}
	}
	if len(structural) > 0 {
		return strings.Join(structural, "\n")
	}
	if len(lines) > 20 {
		lines = lines[:20]
	}
	return strings.Join(lines, "\n")
}

func dropNonExplicitFiles(files []ContextFile, explicitPaths map[string]bool) []ContextFile {
	var kept []ContextFile
	for _, file := range files {
		if explicitPaths[file.Path] {
			kept = append(kept, file)
		}
	}
	if len(kept) > 0 {
		return kept
	}
	if len(files) > 1 {
		return files[:1]
	}
	return files
}

func truncateFilesToBudget(files []ContextFile, availableFileTokens int, instruction string) []ContextFile {
	if len(files) == 0 {
		return files
	}

	instructionTokens := EstimateTextTokens(instruction)
	perFileBudget := (availableFileTokens - instructionTokens) / len(files)
	if perFileBudget < 0 {
		perFileBudget = 0
	}

	next := make([]ContextFile, 0, len(files))
	for _, file := range files {
		if file.TokenEstimate <= perFileBudget {
			next = append(next, file)
		} else {
			next = append(next, truncateFile(file, perFileBudget))
		}
	}
	return next
}

func forceFitFilesToBudget(files []ContextFile, explicitPaths map[string]bool, availableFileTokens int, options BuildOptions) []ContextFile {
	fitted := append([]ContextFile(nil), files...)
	maxIterations := len(fitted)*2 + 5
	for len(fitted) > 0 && estimateRenderedFilesTokens(fitted, options) > availableFileTokens {
		if maxIterations <= 0 {
			break
		}
		maxIterations--

		dropIndex := findLastNonExplicitIndex(fitted, explicitPaths)
		if dropIndex >= 0 && len(fitted) > 1 {
			fitted = append(fitted[:dropIndex], fitted[dropIndex+1:]...)
			continue
		}

		largest := findLargestFileIndex(fitted)
		nextFile := truncateFile(fitted[largest], fitted[largest].TokenEstimate/2)
		if nextFile.TokenEstimate >= fitted[largest].TokenEstimate {
			break
		}
		fitted[largest] = nextFile
	}
	return fitted
}

func truncateFile(file ContextFile, targetTokens int) ContextFile {
	if targetTokens <= 16 {
		content := "[omitted by context builder due to prompt budget]"
		file.Content = content
		file.Mode = "truncated"
		file.TokenEstimate = EstimateTextTokens(content)
		return file
	}

	targetChars := targetTokens * 4
	if targetChars < 32 {
		targetChars = 32
	}
	if len(file.Content) <= targetChars {
		return file
	}

	headLength := targetChars * 6 / 10
	tailLength := targetChars * 3 / 10
	content := file.Content[:headLength] + "\n... [truncated by context builder] ...\n" + file.Content[len(file.Content)-tailLength:]
	file.Content = content
	file.Mode = "truncated"
	file.TokenEstimate = EstimateTextTokens(content)
	return file
}

func findLastNonExplicitIndex(files []ContextFile, explicitPaths map[string]bool) int {
	for i := len(files) - 1; i >= 0; i-- {
		if !explicitPaths[files[i].Path] {
			return i
		}
	}
	return -1
}

func findLargestFileIndex(files []ContextFile) int {
	largest := 0
	for i := 1; i < len(files); i++ {
		if files[i].TokenEstimate > files[largest].TokenEstimate {
			largest = i
		}
	}
	return largest
}

func estimateRenderedFilesTokens(files []ContextFile, options BuildOptions) int {
	return EstimateMessageTokens(Message{
		Role:    "user",
		Content: buildTaskMessage(options.Instruction, files, options.SearchResults, options.HistorySummary),
	})
}

func buildTaskMessage(instruction string, files []ContextFile, searchResults []SearchResult, historySummary string) string {
	sections := []string{
		"Current task:",
		instruction,
		"",
		"Relevant files:",
	}

	if historySummary != "" {
		sections = append(sections, historySummary, "")
	}

	for _, file := range files {
		sections = append(sections, "--- FILE: "+file.Path+" [mode="+file.Mode+"] ---")
		sections = append(sections, file.Content)
		sections = append(sections, "--- END FILE: "+file.Path+" ---", "")
	}

	if len(searchResults) > 0 {
		sections = append(sections, "Web search results:")
		for _, result := range searchResults {
			sections = append(sections, "- "+result.Title+" "+result.URL+"\n  "+result.Snippet)
		}
	}

	return strings.Join(sections, "\n")
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	var result []string
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func normalizeRelativePaths(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, normalizeRelativePath(value))
	}
	return result
}

func normalizeRelativePath(filePath string) string {
	path := filepath.ToSlash(filePath)
	return strings.TrimPrefix(path, "./")
}
