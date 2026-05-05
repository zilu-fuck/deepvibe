package llm

import (
	"context"
	"encoding/json"
	"time"
)

type Client interface {
	CreateCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions) (*CompletionResult, error)
	CreateStreamingCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions, callbacks StreamingCallbacks) (*CompletionResult, error)
	CreateFimCompletion(ctx context.Context, opts FimOptions) (*FimResult, error)
}

type ChatMessage struct {
	Role             string     `json:"role"`
	Content          *string    `json:"content"`
	Name             string     `json:"name,omitempty"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

type CompletionOptions struct {
	Model       string        `json:"model"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Temperature float64       `json:"temperature,omitempty"`
	Tools       []Tool        `json:"tools,omitempty"`
	ToolChoice  any           `json:"tool_choice,omitempty"`
	Stream      bool          `json:"stream,omitempty"`
	Timeout     time.Duration `json:"-"`
}

type Tool struct {
	Type     string      `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters,omitempty"`
	Strict      bool           `json:"strict,omitempty"`
}

type CompletionResult struct {
	Message      ChatMessage `json:"message"`
	FinishReason string      `json:"finish_reason,omitempty"`
	Usage        Usage       `json:"usage,omitempty"`
}

type Usage struct {
	CompletionTokens      int `json:"completion_tokens,omitempty"`
	PromptCacheHitTokens  int `json:"prompt_cache_hit_tokens,omitempty"`
	PromptCacheMissTokens int `json:"prompt_cache_miss_tokens,omitempty"`
	PromptTokens          int `json:"prompt_tokens,omitempty"`
	ReasoningTokens       int `json:"reasoning_tokens,omitempty"`
	TotalTokens           int `json:"total_tokens,omitempty"`
}

type StreamingCallbacks struct {
	OnContent          func(chunk string)
	OnReasoningContent func(chunk string)
	OnDone             func(result *CompletionResult)
}

type FimOptions struct {
	Model       string
	Prefix      string
	Suffix      string
	MaxTokens   int
	Temperature float64
}

type FimResult struct {
	Content      string
	FinishReason string
	ID           string
	Logprobs     map[string]any
	Usage        Usage
}

type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolChoice struct {
	Type     string                 `json:"type,omitempty"`
	Function map[string]string      `json:"function,omitempty"`
	Raw      string                 `json:"-"`
	Object   map[string]interface{} `json:"-"`
}

func StringContent(value string) *string {
	return &value
}

func RawJSONMessage(role string, content string) ChatMessage {
	return ChatMessage{
		Role:    role,
		Content: StringContent(content),
	}
}

type jsonObject map[string]any

func marshalNullableString(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	data, _ := json.Marshal(*value)
	return data
}
