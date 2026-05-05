package tools

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/config"
)

type Tool interface {
	Definition() Definition
	Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error)
}

type ExecutionContext struct {
	ApprovedCommands  map[string]bool
	Backend           backend.Backend
	CommandApproval   CommandApprovalHandler
	CommandPermissions *CommandPermissions
	CommandRunner     CommandRunner
	CWD               string
	ExecutionMode     string
	Instruction       string
	Mutations         *MutationState
	RepositoryState   *RepositoryState
	RootDir           string
	SearchWeb         SearchFunc
}

type Definition struct {
	Type     string          `json:"type"`
	Function FunctionDef    `json:"function"`
}

type FunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters,omitempty"`
	Strict      bool           `json:"strict,omitempty"`
}

type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}}
}

func (r *Registry) Register(tool Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[tool.Definition().Function.Name] = tool
}

func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	tool, ok := r.tools[name]
	return tool, ok
}

func (r *Registry) List() []Definition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	definitions := make([]Definition, 0, len(r.tools))
	for _, tool := range r.tools {
		definitions = append(definitions, tool.Definition())
	}
	return definitions
}

type ToolResult struct {
	Content    string
	ToolCallID string
}

type MutationState struct {
	Applied map[string]AppliedFileChange
}

type AppliedFileChange struct {
	Action        string  `json:"action"`
	AfterContent *string `json:"afterContent"`
	BeforeContent *string `json:"beforeContent"`
	Path          string  `json:"path"`
}

type RepositoryState struct {
	IsDirty bool
}

type CommandPermissions struct {
	Enabled        bool
	MaxOutputChars int
	Policies       []CommandPolicy
	RequireApproval bool
	TimeoutMs      int
}

type CommandPolicy struct {
	AllowInService          bool
	AllowPersistentApproval bool
	AllowedDirectories      []string
	MaxOutputChars          int
	Prefix                  string
	RequireCleanGit         bool
	Risk                    config.CommandRiskLevel
	TimeoutMs               int
}

type CommandExecutionRequest struct {
	Command        string
	CWD            string
	MaxOutputChars int
	TimeoutMs      int
}

type CommandExecutionResult struct {
	ExitCode int
	Stderr   string
	Stdout   string
}

type CommandRunner func(ctx context.Context, request CommandExecutionRequest) (*CommandExecutionResult, error)

type CommandApprovalRequest struct {
	AllowPersistentApproval bool
	Command                 string
	CWD                     string
	Risk                    config.CommandRiskLevel
}

type CommandApprovalHandler func(ctx context.Context, request CommandApprovalRequest) (bool, error)

type SearchOptions struct {
	MaxResults int
	Provider   config.SearchProviderID
	Query      string
	SearchAPIKey string
}

type WebSearchResult struct {
	Snippet string `json:"snippet"`
	Title   string `json:"title"`
	URL     string `json:"url"`
}

type SearchFunc func(ctx context.Context, options SearchOptions) ([]WebSearchResult, error)

func NewMutationState() *MutationState {
	return &MutationState{Applied: map[string]AppliedFileChange{}}
}
