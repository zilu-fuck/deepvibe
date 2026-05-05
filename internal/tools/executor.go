package tools

import (
	"context"
	"encoding/json"

	"github.com/zilu-fuck/deepvibe/internal/backend"
	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func CreateDefaultTools(context ExecutionContext) []Tool {
	context = EnsureBackend(context)
	tools := []Tool{
		ListFilesTool{},
		ReadFileTool{},
		WriteFileTool{},
		DeleteFileTool{},
	}
	if context.CommandPermissions != nil && context.CommandPermissions.Enabled && len(context.CommandPermissions.Policies) > 0 {
		tools = append(tools, RunCommandTool{})
	}
	if HasWebSearchTrigger(context.Instruction) {
		tools = append(tools, WebSearchTool{})
	}
	return tools
}

func CreateFilesystemTools() []Tool {
	return []Tool{
		ListFilesTool{},
		ReadFileTool{},
		WriteFileTool{},
		DeleteFileTool{},
	}
}

func EnsureBackend(context ExecutionContext) ExecutionContext {
	if context.Backend == nil {
		context.Backend = backend.NewLocal(resolveToolRoot(context))
	}
	return context
}

func CreateDefaultRegistry(context ExecutionContext) *Registry {
	context = EnsureBackend(context)
	registry := NewRegistry()
	for _, tool := range CreateDefaultTools(context) {
		registry.Register(tool)
	}
	return registry
}

func ExecuteToolCalls(ctx context.Context, toolCalls []llm.ToolCall, registry *Registry, execCtx ExecutionContext) ([]ToolResult, error) {
	results := make([]ToolResult, 0, len(toolCalls))
	for _, toolCall := range toolCalls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		tool, ok := registry.Get(toolCall.Function.Name)
		if !ok {
			content, _ := encodeToolJSON(map[string]any{
				"ok":    false,
				"error": "Unknown tool: " + toolCall.Function.Name,
			})
			results = append(results, ToolResult{
				Content:    content,
				ToolCallID: toolCall.ID,
			})
			continue
		}

		content, err := tool.Execute(ctx, json.RawMessage(toolCall.Function.Arguments), execCtx)
		if err != nil {
			content, _ = encodeToolJSON(map[string]any{
				"ok":    false,
				"error": err.Error(),
			})
		}
		results = append(results, ToolResult{
			Content:    content,
			ToolCallID: toolCall.ID,
		})
	}
	return results, nil
}
