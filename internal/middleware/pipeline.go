package middleware

import (
	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/tools"
)

type Stage interface {
	Apply(*Scope)
	Name() string
}

type Scope struct {
	Context tools.ExecutionContext
	Tools   []tools.Tool
}

func Apply(execCtx tools.ExecutionContext, stages ...Stage) Scope {
	scope := Scope{Context: execCtx}
	for _, stage := range stages {
		if stage != nil {
			stage.Apply(&scope)
		}
	}
	return scope
}

type BackendStage struct {
	Backend backend.Backend
}

func (s BackendStage) Name() string {
	return "backend"
}

func (s BackendStage) Apply(scope *Scope) {
	if scope.Context.Backend == nil {
		scope.Context.Backend = s.Backend
	}
}

type FilesystemStage struct{}

func (s FilesystemStage) Name() string {
	return "filesystem"
}

func (s FilesystemStage) Apply(scope *Scope) {
	scope.Tools = append(scope.Tools, tools.CreateFilesystemTools()...)
}

type CommandStage struct{}

func (s CommandStage) Name() string {
	return "command"
}

func (s CommandStage) Apply(scope *Scope) {
	permissions := scope.Context.CommandPermissions
	if permissions != nil && permissions.Enabled && len(permissions.Policies) > 0 {
		scope.Tools = append(scope.Tools, tools.RunCommandTool{})
	}
}

type WebSearchStage struct{}

func (s WebSearchStage) Name() string {
	return "web_search"
}

func (s WebSearchStage) Apply(scope *Scope) {
	if tools.HasWebSearchTrigger(scope.Context.Instruction) {
		scope.Tools = append(scope.Tools, tools.WebSearchTool{})
	}
}

func DefaultStages(execCtx tools.ExecutionContext) []Stage {
	return []Stage{
		BackendStage{Backend: backend.NewLocal(resolveRoot(execCtx))},
		FilesystemStage{},
		CommandStage{},
		WebSearchStage{},
	}
}

func DefaultTools(execCtx tools.ExecutionContext) ([]tools.Tool, tools.ExecutionContext) {
	scope := Apply(execCtx, DefaultStages(execCtx)...)
	return scope.Tools, scope.Context
}

func resolveRoot(execCtx tools.ExecutionContext) string {
	if execCtx.RootDir != "" {
		return execCtx.RootDir
	}
	return execCtx.CWD
}
