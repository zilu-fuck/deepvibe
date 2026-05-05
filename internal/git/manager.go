package git

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const deepvibeDir = ".deepvibe"
const commandApprovalsFile = "command-approvals.json"
const contextFile = "context.json"
const lastActionFile = "last-action.json"
const operationsDir = "operations"
const aiCommitPrefix = "DeepVibe:"

var internalMetadataPaths = map[string]bool{
	deepvibeDir + "/" + lastActionFile:       true,
	deepvibeDir + "/" + contextFile:          true,
	deepvibeDir + "/" + commandApprovalsFile: true,
}

type RepositoryState struct {
	CurrentHead  string `json:"currentHead,omitempty"`
	IsDirty      bool   `json:"isDirty"`
	IsRepository bool   `json:"isRepository"`
}

type OperationSnapshot struct {
	AfterContent  *string `json:"afterContent"`
	BeforeContent *string `json:"beforeContent"`
	Path          string  `json:"path"`
}

type OperationFileRecord struct {
	AfterContent  *string `json:"afterContent"`
	AfterExists   bool    `json:"afterExists"`
	BeforeContent *string `json:"beforeContent"`
	BeforeExists  bool    `json:"beforeExists"`
	Path          string  `json:"path"`
	PostImageHash string  `json:"postImageHash"`
	PreImageHash  string  `json:"preImageHash"`
}

type RecordedOperation struct {
	BaseHead    string                `json:"baseHead,omitempty"`
	CreatedAt   string                `json:"createdAt"`
	Files       []OperationFileRecord `json:"files"`
	OperationID string                `json:"operationId"`
}

type RecordedCommit struct {
	CommitHash string `json:"commitHash"`
	Summary    string `json:"summary"`
}

type LastActionRecord struct {
	CreatedAt string `json:"createdAt"`
	Kind      string `json:"kind"`
	Reference string `json:"reference"`
	Summary   string `json:"summary"`
}

type UndoResult struct {
	Kind      string `json:"kind"`
	Reference string `json:"reference"`
}

func InspectRepository(ctx context.Context, rootDir string) RepositoryState {
	if _, err := runGit(ctx, rootDir, "rev-parse", "--is-inside-work-tree"); err != nil {
		return RepositoryState{IsRepository: false, IsDirty: false}
	}

	head := ""
	if output, err := runGit(ctx, rootDir, "rev-parse", "HEAD"); err == nil {
		head = strings.TrimSpace(output)
	}
	status, err := runGit(ctx, rootDir, "status", "--porcelain")
	if err != nil {
		return RepositoryState{IsRepository: true, IsDirty: false, CurrentHead: head}
	}
	return RepositoryState{
		CurrentHead:  head,
		IsDirty:      hasUserVisibleGitChanges(status),
		IsRepository: true,
	}
}

func RecordOperation(rootDir string, repositoryState RepositoryState, snapshots []OperationSnapshot, summary string) (*RecordedOperation, error) {
	operationID := createOperationID()
	operationDir := filepath.Join(rootDir, deepvibeDir, operationsDir)
	files := make([]OperationFileRecord, 0, len(snapshots))
	for _, snapshot := range snapshots {
		files = append(files, OperationFileRecord{
			AfterContent:  snapshot.AfterContent,
			AfterExists:   snapshot.AfterContent != nil,
			BeforeContent: snapshot.BeforeContent,
			BeforeExists:  snapshot.BeforeContent != nil,
			Path:          normalizePath(snapshot.Path),
			PostImageHash: hashContent(snapshot.AfterContent),
			PreImageHash:  hashContent(snapshot.BeforeContent),
		})
	}
	record := &RecordedOperation{
		BaseHead:    repositoryState.CurrentHead,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Files:       files,
		OperationID: operationID,
	}
	if err := os.MkdirAll(operationDir, 0755); err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(operationDir, operationID+".json"), record); err != nil {
		return nil, err
	}
	if err := writeLastAction(rootDir, LastActionRecord{
		CreatedAt: record.CreatedAt,
		Kind:      "operation",
		Reference: operationID,
		Summary:   summary,
	}); err != nil {
		return nil, err
	}
	return record, nil
}

func CreateAICommit(ctx context.Context, rootDir string, changedPaths []string, summary string) (*RecordedCommit, error) {
	uniquePaths := dedupePaths(changedPaths)
	if len(uniquePaths) == 0 {
		return nil, errors.New("no changed paths to commit")
	}
	args := append([]string{"add", "--"}, uniquePaths...)
	if _, err := runGit(ctx, rootDir, args...); err != nil {
		return nil, err
	}
	message := "DeepVibe: " + strings.TrimSpace(summary)
	if strings.TrimSpace(summary) == "" {
		message = "DeepVibe: AI change"
	}
	if _, err := runGit(ctx, rootDir, "commit", "-m", message); err != nil {
		return nil, err
	}
	commitHash, err := runGit(ctx, rootDir, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	record := &RecordedCommit{CommitHash: strings.TrimSpace(commitHash), Summary: summary}
	if err := writeLastAction(rootDir, LastActionRecord{
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Kind:      "commit",
		Reference: record.CommitHash,
		Summary:   summary,
	}); err != nil {
		return nil, err
	}
	return record, nil
}

func UndoLastAIChange(ctx context.Context, rootDir string) (*UndoResult, error) {
	lastAction, err := readLastAction(rootDir)
	if err != nil {
		return nil, err
	}
	if lastAction == nil {
		return nil, errors.New("No recorded AI change is available to undo.")
	}
	if lastAction.Kind == "commit" {
		return undoCommit(ctx, rootDir, *lastAction)
	}
	return undoOperation(rootDir, *lastAction)
}

func undoCommit(ctx context.Context, rootDir string, lastAction LastActionRecord) (*UndoResult, error) {
	status, err := runGit(ctx, rootDir, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	if hasUserVisibleGitChanges(status) {
		return nil, errors.New("Cannot undo an AI commit while the working tree has uncommitted changes.")
	}
	currentHead, err := runGit(ctx, rootDir, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(currentHead) != lastAction.Reference {
		return nil, errors.New("The latest AI commit is no longer at HEAD, so automatic undo is unsafe.")
	}
	headMessage, err := runGit(ctx, rootDir, "show", "-s", "--format=%s", "HEAD")
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.TrimSpace(headMessage), aiCommitPrefix) {
		return nil, errors.New("HEAD is not an AI commit, so automatic undo is unsafe.")
	}
	if _, err := runGit(ctx, rootDir, "revert", "--no-edit", lastAction.Reference); err != nil {
		return nil, err
	}
	if err := clearLastAction(rootDir); err != nil {
		return nil, err
	}
	return &UndoResult{Kind: "commit", Reference: lastAction.Reference}, nil
}

func undoOperation(rootDir string, lastAction LastActionRecord) (*UndoResult, error) {
	operationPath := filepath.Join(rootDir, deepvibeDir, operationsDir, lastAction.Reference+".json")
	data, err := os.ReadFile(operationPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("The recorded AI operation file could not be found.")
		}
		return nil, err
	}
	var operation RecordedOperation
	if err := json.Unmarshal(data, &operation); err != nil {
		return nil, err
	}

	for _, file := range operation.Files {
		absolutePath := filepath.Join(rootDir, filepath.FromSlash(file.Path))
		currentContent, err := readNullableFile(absolutePath)
		if err != nil {
			return nil, err
		}
		if hashContent(currentContent) != file.PostImageHash {
			return nil, fmt.Errorf("Cannot undo %s because it has changed since the AI operation was applied.", file.Path)
		}
	}

	for _, file := range operation.Files {
		absolutePath := filepath.Join(rootDir, filepath.FromSlash(file.Path))
		if !file.BeforeExists {
			if err := os.Remove(absolutePath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(absolutePath), 0755); err != nil {
			return nil, err
		}
		content := ""
		if file.BeforeContent != nil {
			content = *file.BeforeContent
		}
		if err := os.WriteFile(absolutePath, []byte(content), 0644); err != nil {
			return nil, err
		}
	}
	if err := clearLastAction(rootDir); err != nil {
		return nil, err
	}
	return &UndoResult{Kind: "operation", Reference: lastAction.Reference}, nil
}

func runGit(ctx context.Context, rootDir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = rootDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

func writeLastAction(rootDir string, record LastActionRecord) error {
	return writeJSON(filepath.Join(rootDir, deepvibeDir, lastActionFile), record)
}

func readLastAction(rootDir string) (*LastActionRecord, error) {
	data, err := os.ReadFile(filepath.Join(rootDir, deepvibeDir, lastActionFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var record LastActionRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

func clearLastAction(rootDir string) error {
	err := os.Remove(filepath.Join(rootDir, deepvibeDir, lastActionFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0644)
}

func readNullableFile(path string) (*string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	content := string(data)
	return &content, nil
}

func hasUserVisibleGitChanges(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		pathPart := strings.TrimSpace(line[3:])
		if strings.Contains(pathPart, " -> ") {
			parts := strings.Split(pathPart, " -> ")
			pathPart = parts[len(parts)-1]
		}
		if !isInternalMetadataPath(pathPart) {
			return true
		}
	}
	return false
}

func isInternalMetadataPath(path string) bool {
	normalized := normalizePath(path)
	if internalMetadataPaths[normalized] {
		return true
	}
	return strings.HasPrefix(normalized, deepvibeDir+"/"+operationsDir+"/")
}

func normalizePath(path string) string {
	return strings.TrimPrefix(filepath.ToSlash(path), "./")
}

func dedupePaths(paths []string) []string {
	seen := map[string]bool{}
	var result []string
	for _, path := range paths {
		path = normalizePath(path)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		result = append(result, path)
	}
	return result
}

func createOperationID() string {
	var bytes [6]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return "op_" + strconv36(time.Now().UnixMilli()) + "_" + hex.EncodeToString(bytes[:])
	}
	return "op_" + strconv36(time.Now().UnixNano())
}

func strconv36(value int64) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	if value == 0 {
		return "0"
	}
	var out []byte
	for value > 0 {
		out = append([]byte{alphabet[value%36]}, out...)
		value /= 36
	}
	return string(out)
}

func hashContent(text *string) string {
	if text == nil {
		return "missing"
	}
	var hash uint32
	for _, r := range *text {
		hash = hash*31 + uint32(r)
	}
	return fmt.Sprintf("%08x", hash)
}
