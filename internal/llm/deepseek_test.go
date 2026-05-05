package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var testMessages = []ChatMessage{
	RawJSONMessage("system", "Return JSON."),
	RawJSONMessage("user", "Summarize this file."),
}

func TestBuildChatCompletionBodyDefaults(t *testing.T) {
	body, err := BuildChatCompletionBody(testMessages, CreateCompletionOptions{
		Model:           "deepseek-v4-pro",
		ReasoningEffort: ReasoningHigh,
	})
	if err != nil {
		t.Fatal(err)
	}

	if body["model"] != "deepseek-v4-pro" {
		t.Fatalf("unexpected model: %#v", body["model"])
	}
	if nested(body, "thinking", "type") != string(ThinkingEnabled) {
		t.Fatalf("expected enabled thinking, got %#v", body["thinking"])
	}
	if nested(body, "response_format", "type") != string(ResponseFormatJSONObject) {
		t.Fatalf("expected json response format, got %#v", body["response_format"])
	}
	if body["reasoning_effort"] != string(ReasoningHigh) {
		t.Fatalf("unexpected reasoning effort: %#v", body["reasoning_effort"])
	}
}

func TestBuildChatCompletionBodyStreamAndTools(t *testing.T) {
	body, err := BuildChatCompletionBody(testMessages, CreateCompletionOptions{
		Model:    "deepseek-v4-flash",
		Stream:   true,
		Thinking: ThinkingDisabled,
		Tools: []Tool{
			{
				Type: "function",
				Function: ToolFunction{
					Name:        "read_file",
					Description: "Read a file",
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if body["stream"] != true {
		t.Fatalf("expected stream true")
	}
	if nested(body, "stream_options", "include_usage") != true {
		t.Fatalf("expected stream usage options, got %#v", body["stream_options"])
	}
	if body["tool_choice"] != "auto" {
		t.Fatalf("expected default auto tool choice, got %#v", body["tool_choice"])
	}
}

func TestBuildFimCompletionBody(t *testing.T) {
	body, err := BuildFimCompletionBody(CreateFimCompletionOptions{
		Model:     "deepseek-v4-pro",
		Prompt:    "func main() {",
		Suffix:    "}",
		MaxTokens: 64,
		Stream:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["prompt"] != "func main() {" || body["suffix"] != "}" {
		t.Fatalf("unexpected FIM body: %#v", body)
	}
	if body["max_tokens"] != 64 || body["stream"] != true {
		t.Fatalf("unexpected FIM body: %#v", body)
	}
}

func TestDeepSeekClientParsesNonStreamResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{
			"id": "chat_1",
			"choices": []map[string]any{
				{
					"finish_reason": "stop",
					"message": map[string]any{
						"content":           `{"ok":true}`,
						"reasoning_content": "reasoning",
					},
				},
			},
			"usage": map[string]any{"total_tokens": 18},
		})
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{APIKey: "test-key", BaseURL: server.URL})
	result, err := client.CreateDeepSeekCompletion(context.Background(), testMessages, CreateCompletionOptions{
		Model: "deepseek-v4-pro",
	})
	if err != nil {
		t.Fatal(err)
	}

	if result.ID != "chat_1" || result.Content != `{"ok":true}` || result.ReasoningContent != "reasoning" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Usage == nil || result.Usage.TotalTokens != 18 {
		t.Fatalf("unexpected usage: %#v", result.Usage)
	}
}

func TestDeepSeekClientParsesStreamingResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"id":"chat_2","choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}],"usage":null}`,
			"",
			`data: {"id":"chat_2","choices":[{"delta":{"content":"{\"files\":"},"finish_reason":null}],"usage":null}`,
			"",
			`data: {"id":"chat_2","choices":[{"delta":{"content":"[]}"},"finish_reason":"stop"}],"usage":null}`,
			"",
			`data: {"id":"chat_2","choices":[],"usage":{"total_tokens":42}}`,
			"",
			`data: [DONE]`,
			"",
		}, "\n")))
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{APIKey: "test-key", BaseURL: server.URL})
	result, err := client.CreateDeepSeekCompletion(context.Background(), testMessages, CreateCompletionOptions{
		Model:  "deepseek-v4-pro",
		Stream: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if result.Content != `{"files":[]}` || result.ReasoningContent != "think " || result.FinishReason != "stop" {
		t.Fatalf("unexpected streaming result: %#v", result)
	}
	if result.Usage == nil || result.Usage.TotalTokens != 42 {
		t.Fatalf("unexpected usage: %#v", result.Usage)
	}
}

func TestDeepSeekClientParsesStreamingToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"id":"chat_tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\""}}]},"finish_reason":null}],"usage":null}`,
			"",
			`data: {"id":"chat_tool","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"src/api.ts\"}"}}]},"finish_reason":"tool_calls"}],"usage":null}`,
			"",
			`data: [DONE]`,
			"",
		}, "\n")))
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{APIKey: "test-key", BaseURL: server.URL})
	result, err := client.CreateDeepSeekCompletion(context.Background(), testMessages, CreateCompletionOptions{
		Model:  "deepseek-v4-pro",
		Stream: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.ToolCalls) != 1 {
		t.Fatalf("expected one tool call, got %#v", result.ToolCalls)
	}
	call := result.ToolCalls[0]
	if call.ID != "call_1" || call.Function.Name != "read_file" || call.Function.Arguments != `{"path":"src/api.ts"}` {
		t.Fatalf("unexpected tool call: %#v", call)
	}
}

func TestDeepSeekClientUsesBetaEndpointForFim(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/beta/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{
			"id": "fim_1",
			"choices": []map[string]any{
				{
					"text":          "return value;",
					"finish_reason": "stop",
				},
			},
			"usage": map[string]any{"total_tokens": 9},
		})
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{APIKey: "test-key", BaseURL: server.URL})
	result, err := client.CreateDeepSeekFimCompletion(context.Background(), CreateFimCompletionOptions{
		Model:  "deepseek-v4-pro",
		Prompt: "if value {",
		Suffix: "}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "fim_1" || result.Content != "return value;" || result.Usage.TotalTokens != 9 {
		t.Fatalf("unexpected FIM result: %#v", result)
	}
}

func TestDeepSeekClientParsesStreamingFimCompletion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/beta/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"id":"fim_stream","choices":[{"text":"return ","finish_reason":null}],"usage":null}`,
			"",
			`data: {"id":"fim_stream","choices":[{"text":"value;","finish_reason":"stop"}],"usage":null}`,
			"",
			`data: {"id":"fim_stream","choices":[],"usage":{"total_tokens":11}}`,
			"",
			`data: [DONE]`,
			"",
		}, "\n")))
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{APIKey: "test-key", BaseURL: server.URL})
	result, err := client.CreateDeepSeekFimCompletion(context.Background(), CreateFimCompletionOptions{
		Model:  "deepseek-v4-pro",
		Prompt: "if value {",
		Suffix: "}",
		Stream: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "fim_stream" || result.Content != "return value;" || result.FinishReason != "stop" {
		t.Fatalf("unexpected streaming FIM result: %#v", result)
	}
	if result.Usage == nil || result.Usage.TotalTokens != 11 {
		t.Fatalf("unexpected streaming FIM usage: %#v", result.Usage)
	}
}

func TestDeepSeekClientRetriesRateLimit(t *testing.T) {
	attempts := 0
	var delays []time.Duration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		writeJSON(t, w, map[string]any{
			"id": "chat_retry",
			"choices": []map[string]any{
				{
					"finish_reason": "stop",
					"message": map[string]any{
						"content": `{"ok":true}`,
					},
				},
			},
		})
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{
		APIKey: "test-key",
		BaseURL: server.URL,
		Sleep: func(ctx context.Context, delay time.Duration) error {
			delays = append(delays, delay)
			return nil
		},
	})
	result, err := client.CreateDeepSeekCompletion(context.Background(), testMessages, CreateCompletionOptions{
		Model: "deepseek-v4-pro",
	})
	if err != nil {
		t.Fatal(err)
	}

	if result.ID != "chat_retry" || attempts != 2 {
		t.Fatalf("unexpected retry result: result=%#v attempts=%d", result, attempts)
	}
	if len(delays) != 1 || delays[0] != 2*time.Second {
		t.Fatalf("expected Retry-After delay, got %#v", delays)
	}
}

func TestDeepSeekClientStopsAfterRetryBudget(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "server unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := NewDeepSeekClient(DeepSeekClientOptions{
		APIKey:     "test-key",
		BaseURL:    server.URL,
		MaxRetries: 2,
		Sleep: func(ctx context.Context, delay time.Duration) error {
			return nil
		},
	})
	_, err := client.CreateDeepSeekCompletion(context.Background(), testMessages, CreateCompletionOptions{
		Model: "deepseek-v4-pro",
	})
	var clientErr *DeepSeekClientError
	if !errors.As(err, &clientErr) {
		t.Fatalf("expected DeepSeekClientError, got %T %v", err, err)
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
}

func nested(body map[string]any, key string, nestedKey string) any {
	value, ok := body[key].(map[string]any)
	if !ok {
		return nil
	}
	return value[nestedKey]
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
