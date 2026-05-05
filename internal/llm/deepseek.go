package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type ThinkingMode string

const (
	ThinkingEnabled  ThinkingMode = "enabled"
	ThinkingDisabled ThinkingMode = "disabled"
)

type ResponseFormat string

const (
	ResponseFormatText       ResponseFormat = "text"
	ResponseFormatJSONObject ResponseFormat = "json_object"
)

type ReasoningEffort string

const (
	ReasoningHigh ReasoningEffort = "high"
	ReasoningMax  ReasoningEffort = "max"
)

type DeepSeekClientOptions struct {
	APIKey           string
	BaseURL          string
	HTTPClient       *http.Client
	MaxRetries       int
	RetryBaseDelay   time.Duration
	Sleep            func(context.Context, time.Duration) error
	Timeout          time.Duration
}

type CreateCompletionOptions struct {
	MaxTokens       int
	Model           string
	ReasoningEffort ReasoningEffort
	ResponseFormat  ResponseFormat
	Stream          bool
	Thinking        ThinkingMode
	ToolChoice      any
	Tools           []Tool
}

type CreateFimCompletionOptions struct {
	Echo        *bool
	Logprobs    *int
	MaxTokens   int
	Model       string
	Prompt      string
	Stop        any
	Stream      bool
	Suffix      string
	Temperature *float64
	TopP        *float64
}

type DeepSeekCompletionResult struct {
	Content          string     `json:"content"`
	FinishReason    string     `json:"finishReason,omitempty"`
	ID              string     `json:"id,omitempty"`
	ReasoningContent string    `json:"reasoningContent"`
	ToolCalls       []ToolCall `json:"toolCalls"`
	Usage           *Usage     `json:"usage,omitempty"`
}

type DeepSeekFimCompletionResult struct {
	Content      string         `json:"content"`
	FinishReason string        `json:"finishReason,omitempty"`
	ID           string        `json:"id,omitempty"`
	Logprobs     map[string]any `json:"logprobs,omitempty"`
	Usage        *Usage         `json:"usage,omitempty"`
}

type DeepSeekClientError struct {
	Status  int
	Message string
}

func (e *DeepSeekClientError) Error() string {
	return e.Message
}

type DeepSeekClientAbortError struct {
	Message string
}

func (e *DeepSeekClientAbortError) Error() string {
	return e.Message
}

type DeepSeekClient struct {
	apiKey         string
	baseURL        string
	httpClient     *http.Client
	maxRetries     int
	retryBaseDelay time.Duration
	sleep          func(context.Context, time.Duration) error
	timeout        time.Duration
}

func NewDeepSeekClient(options DeepSeekClientOptions) *DeepSeekClient {
	baseURL := strings.TrimRight(options.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.deepseek.com"
	}

	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	maxRetries := options.MaxRetries
	if maxRetries == 0 {
		maxRetries = 3
	}

	retryBaseDelay := options.RetryBaseDelay
	if retryBaseDelay == 0 {
		retryBaseDelay = 500 * time.Millisecond
	}

	timeout := options.Timeout
	if timeout == 0 {
		timeout = 90 * time.Second
	}

	sleep := options.Sleep
	if sleep == nil {
		sleep = sleepContext
	}

	return &DeepSeekClient{
		apiKey:         options.APIKey,
		baseURL:        baseURL,
		httpClient:     httpClient,
		maxRetries:     maxRetries,
		retryBaseDelay: retryBaseDelay,
		sleep:          sleep,
		timeout:        timeout,
	}
}

func (c *DeepSeekClient) CreateCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions) (*CompletionResult, error) {
	result, err := c.CreateDeepSeekCompletion(ctx, messages, CreateCompletionOptions{
		MaxTokens:   opts.MaxTokens,
		Model:       opts.Model,
		Stream:      opts.Stream,
		ToolChoice:  opts.ToolChoice,
		Tools:       opts.Tools,
	})
	if err != nil {
		return nil, err
	}

	content := result.Content
	return &CompletionResult{
		Message: ChatMessage{
			Role:             "assistant",
			Content:          &content,
			ReasoningContent: result.ReasoningContent,
			ToolCalls:        result.ToolCalls,
		},
		FinishReason: result.FinishReason,
		Usage:        derefUsage(result.Usage),
	}, nil
}

func (c *DeepSeekClient) CreateStreamingCompletion(ctx context.Context, messages []ChatMessage, opts CompletionOptions, callbacks StreamingCallbacks) (*CompletionResult, error) {
	result, err := c.CreateDeepSeekStreamingCompletion(ctx, messages, CreateCompletionOptions{
		MaxTokens:  opts.MaxTokens,
		Model:      opts.Model,
		ToolChoice: opts.ToolChoice,
		Tools:      opts.Tools,
	}, callbacks)
	if err != nil {
		return nil, err
	}

	content := result.Content
	return &CompletionResult{
		Message: ChatMessage{
			Role:             "assistant",
			Content:          &content,
			ReasoningContent: result.ReasoningContent,
			ToolCalls:        result.ToolCalls,
		},
		FinishReason: result.FinishReason,
		Usage:        derefUsage(result.Usage),
	}, nil
}

func (c *DeepSeekClient) CreateFimCompletion(ctx context.Context, opts FimOptions) (*FimResult, error) {
	result, err := c.CreateDeepSeekFimCompletion(ctx, CreateFimCompletionOptions{
		MaxTokens:   opts.MaxTokens,
		Model:       opts.Model,
		Prompt:      opts.Prefix,
		Suffix:      opts.Suffix,
		Temperature: &opts.Temperature,
	})
	if err != nil {
		return nil, err
	}

	return &FimResult{
		Content:      result.Content,
		FinishReason: result.FinishReason,
		ID:           result.ID,
		Logprobs:     result.Logprobs,
		Usage:        derefUsage(result.Usage),
	}, nil
}

func (c *DeepSeekClient) CreateDeepSeekCompletion(ctx context.Context, messages []ChatMessage, options CreateCompletionOptions) (*DeepSeekCompletionResult, error) {
	body, err := BuildChatCompletionBody(messages, options)
	if err != nil {
		return nil, err
	}

	return retry(ctx, c, func(requestCtx context.Context) (*DeepSeekCompletionResult, *http.Response, error) {
		response, err := c.postJSON(requestCtx, c.baseURL+"/chat/completions", body)
		if err != nil {
			return nil, nil, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, response, responseError(response)
		}
		defer response.Body.Close()
		if options.Stream {
			result, err := ReadStreamingResponse(response)
			return result, nil, err
		}
		result, err := ReadJSONResponse(response)
		return result, nil, err
	})
}

func (c *DeepSeekClient) CreateDeepSeekStreamingCompletion(ctx context.Context, messages []ChatMessage, options CreateCompletionOptions, callbacks StreamingCallbacks) (*DeepSeekCompletionResult, error) {
	options.Stream = true
	body, err := BuildChatCompletionBody(messages, options)
	if err != nil {
		return nil, err
	}

	return retry(ctx, c, func(requestCtx context.Context) (*DeepSeekCompletionResult, *http.Response, error) {
		response, err := c.postJSON(requestCtx, c.baseURL+"/chat/completions", body)
		if err != nil {
			return nil, nil, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, response, responseError(response)
		}
		defer response.Body.Close()
		result, err := ReadStreamingResponseWithCallbacks(response, callbacks)
		return result, nil, err
	})
}

func (c *DeepSeekClient) CreateDeepSeekFimCompletion(ctx context.Context, options CreateFimCompletionOptions) (*DeepSeekFimCompletionResult, error) {
	body, err := BuildFimCompletionBody(options)
	if err != nil {
		return nil, err
	}

	fimBaseURL := c.baseURL
	if !strings.HasSuffix(fimBaseURL, "/beta") {
		fimBaseURL += "/beta"
	}

	return retry(ctx, c, func(requestCtx context.Context) (*DeepSeekFimCompletionResult, *http.Response, error) {
		response, err := c.postJSON(requestCtx, fimBaseURL+"/completions", body)
		if err != nil {
			return nil, nil, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, response, responseError(response)
		}
		defer response.Body.Close()
		if options.Stream {
			result, err := ReadStreamingTextCompletionResponse(response)
			return result, nil, err
		}
		result, err := ReadTextCompletionResponse(response)
		return result, nil, err
	})
}

func BuildChatCompletionBody(messages []ChatMessage, options CreateCompletionOptions) (map[string]any, error) {
	if options.Model == "" {
		return nil, errors.New("model is required")
	}

	thinking := options.Thinking
	if thinking == "" {
		thinking = ThinkingEnabled
	}

	responseFormat := options.ResponseFormat
	if responseFormat == "" {
		responseFormat = ResponseFormatJSONObject
	}

	body := map[string]any{
		"model":    options.Model,
		"messages": messages,
		"thinking": map[string]any{
			"type": string(thinking),
		},
		"response_format": map[string]any{
			"type": string(responseFormat),
		},
	}

	if options.MaxTokens > 0 {
		body["max_tokens"] = options.MaxTokens
	}
	if options.ReasoningEffort != "" {
		body["reasoning_effort"] = string(options.ReasoningEffort)
	}
	if options.Stream {
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if len(options.Tools) > 0 {
		body["tools"] = options.Tools
		if options.ToolChoice != nil {
			body["tool_choice"] = options.ToolChoice
		} else {
			body["tool_choice"] = "auto"
		}
	}

	return body, nil
}

func BuildFimCompletionBody(options CreateFimCompletionOptions) (map[string]any, error) {
	model := options.Model
	if model == "" {
		model = "deepseek-v4-pro"
	}
	if options.Prompt == "" {
		return nil, errors.New("prompt is required")
	}

	body := map[string]any{
		"model":  model,
		"prompt": options.Prompt,
	}
	if options.Echo != nil {
		body["echo"] = *options.Echo
	}
	if options.Logprobs != nil {
		body["logprobs"] = *options.Logprobs
	}
	if options.MaxTokens > 0 {
		body["max_tokens"] = options.MaxTokens
	}
	if options.Stop != nil {
		body["stop"] = options.Stop
	}
	if options.Stream {
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if options.Suffix != "" {
		body["suffix"] = options.Suffix
	}
	if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	if options.TopP != nil {
		body["top_p"] = *options.TopP
	}
	return body, nil
}

func ReadJSONResponse(response *http.Response) (*DeepSeekCompletionResult, error) {
	var payload chatCompletionChunk
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}

	var choice chatChoice
	if len(payload.Choices) > 0 {
		choice = payload.Choices[0]
	}

	return &DeepSeekCompletionResult{
		ID:              payload.ID,
		Content:          choice.Message.Content,
		ReasoningContent: choice.Message.ReasoningContent,
		FinishReason:    choice.FinishReason,
		ToolCalls:       choice.Message.ToolCalls,
		Usage:           payload.Usage,
	}, nil
}

func ReadTextCompletionResponse(response *http.Response) (*DeepSeekFimCompletionResult, error) {
	var payload textCompletionChunk
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}

	var choice textChoice
	if len(payload.Choices) > 0 {
		choice = payload.Choices[0]
	}

	return &DeepSeekFimCompletionResult{
		ID:           payload.ID,
		Content:      choice.Text,
		FinishReason: choice.FinishReason,
		Logprobs:     choice.Logprobs,
		Usage:        payload.Usage,
	}, nil
}

func ReadStreamingResponse(response *http.Response) (*DeepSeekCompletionResult, error) {
	return readStreamingResponse(response, StreamingCallbacks{})
}

func ReadStreamingResponseWithCallbacks(response *http.Response, callbacks StreamingCallbacks) (*DeepSeekCompletionResult, error) {
	return readStreamingResponse(response, callbacks)
}

func ReadStreamingTextCompletionResponse(response *http.Response) (*DeepSeekFimCompletionResult, error) {
	events, err := readSSE(response.Body)
	if err != nil {
		return nil, err
	}

	result := &DeepSeekFimCompletionResult{}
	for _, data := range events {
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk textCompletionChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil, err
		}
		if chunk.ID != "" {
			result.ID = chunk.ID
		}
		if chunk.Usage != nil {
			result.Usage = chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		result.Content += choice.Text
		if choice.FinishReason != "" {
			result.FinishReason = choice.FinishReason
		}
		if choice.Logprobs != nil {
			result.Logprobs = choice.Logprobs
		}
	}

	return result, nil
}

func readStreamingResponse(response *http.Response, callbacks StreamingCallbacks) (*DeepSeekCompletionResult, error) {
	events, err := readSSE(response.Body)
	if err != nil {
		return nil, err
	}

	result := &DeepSeekCompletionResult{}
	for _, data := range events {
		if data == "" || data == "[DONE]" {
			continue
		}

		var chunk chatCompletionChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil, err
		}

		if chunk.ID != "" {
			result.ID = chunk.ID
		}
		if chunk.Usage != nil {
			result.Usage = chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			continue
		}

		choice := chunk.Choices[0]
		if choice.FinishReason != "" {
			result.FinishReason = choice.FinishReason
		}
		if choice.Delta.Content != "" {
			result.Content += choice.Delta.Content
			if callbacks.OnContent != nil {
				callbacks.OnContent(choice.Delta.Content)
			}
		}
		if choice.Delta.ReasoningContent != "" {
			result.ReasoningContent += choice.Delta.ReasoningContent
			if callbacks.OnReasoningContent != nil {
				callbacks.OnReasoningContent(choice.Delta.ReasoningContent)
			}
		}
		if len(choice.Delta.ToolCalls) > 0 {
			mergeToolCalls(&result.ToolCalls, choice.Delta.ToolCalls)
		}
	}

	if callbacks.OnDone != nil {
		content := result.Content
		callbacks.OnDone(&CompletionResult{
			Message: ChatMessage{
				Role:             "assistant",
				Content:          &content,
				ReasoningContent: result.ReasoningContent,
				ToolCalls:        result.ToolCalls,
			},
			FinishReason: result.FinishReason,
			Usage:        derefUsage(result.Usage),
		})
	}

	return result, nil
}

func readSSE(reader io.Reader) ([]string, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024), 10*1024*1024)

	var events []string
	var current []string
	flush := func() {
		if len(current) == 0 {
			return
		}
		events = append(events, strings.Join(current, "\n"))
		current = nil
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			current = append(current, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flush()
	return events, scanner.Err()
}

func mergeToolCalls(current *[]ToolCall, incoming []toolCallDelta) {
	for _, delta := range incoming {
		index := len(*current)
		if delta.Index != nil {
			index = *delta.Index
		}
		for len(*current) <= index {
			*current = append(*current, ToolCall{
				Type: "function",
				Function: ToolCallFunction{},
			})
		}

		existing := (*current)[index]
		if delta.ID != "" {
			existing.ID = delta.ID
		}
		if delta.Type != "" {
			existing.Type = delta.Type
		}
		if existing.Type == "" {
			existing.Type = "function"
		}
		if delta.Function.Name != "" {
			existing.Function.Name = delta.Function.Name
		}
		existing.Function.Arguments += delta.Function.Arguments
		(*current)[index] = existing
	}
}

func (c *DeepSeekClient) postJSON(ctx context.Context, url string, body map[string]any) (*http.Response, error) {
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("Content-Type", "application/json")

	return c.httpClient.Do(request)
}

func retry[T any](ctx context.Context, client *DeepSeekClient, fn func(context.Context) (T, *http.Response, error)) (T, error) {
	var zero T
	attempt := 0
	for {
		if err := ctx.Err(); err != nil {
			return zero, &DeepSeekClientAbortError{Message: "Completion was aborted before the request was sent."}
		}

		result, response, err := fn(ctx)
		if err == nil {
			return result, nil
		}

		if ctx.Err() != nil {
			return zero, &DeepSeekClientAbortError{Message: "Completion was aborted."}
		}

		if !isRetriableError(err) || attempt >= client.maxRetries {
			return zero, err
		}

		delay := resolveExponentialDelay(attempt, client.retryBaseDelay)
		if response != nil {
			if retryAfter := parseRetryAfter(response.Header.Get("Retry-After")); retryAfter >= 0 {
				delay = retryAfter
			}
		}
		if sleepErr := client.sleep(ctx, delay); sleepErr != nil {
			return zero, sleepErr
		}
		attempt++
	}
}

func responseError(response *http.Response) error {
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return &DeepSeekClientError{
		Status:  response.StatusCode,
		Message: string(data),
	}
}

func isRetriableError(err error) bool {
	var clientErr *DeepSeekClientError
	if errors.As(err, &clientErr) {
		return clientErr.Status == http.StatusTooManyRequests || clientErr.Status >= 500
	}
	var abortErr *DeepSeekClientAbortError
	if errors.As(err, &abortErr) {
		return false
	}
	return true
}

func resolveExponentialDelay(attempt int, base time.Duration) time.Duration {
	if attempt <= 0 {
		return base
	}
	return base * time.Duration(1<<attempt)
}

func parseRetryAfter(value string) time.Duration {
	if value == "" {
		return -1
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		return time.Duration(seconds * float64(time.Second))
	}
	if timestamp, err := http.ParseTime(value); err == nil {
		delay := time.Until(timestamp)
		if delay < 0 {
			return 0
		}
		return delay
	}
	return -1
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return &DeepSeekClientAbortError{Message: "Completion was aborted."}
	case <-timer.C:
		return nil
	}
}

func derefUsage(usage *Usage) Usage {
	if usage == nil {
		return Usage{}
	}
	return *usage
}

type chatCompletionChunk struct {
	Choices []chatChoice `json:"choices"`
	ID      string       `json:"id"`
	Usage   *Usage       `json:"usage"`
}

type chatChoice struct {
	Delta        chatDelta   `json:"delta"`
	FinishReason string      `json:"finish_reason"`
	Message      chatMessage `json:"message"`
}

type chatMessage struct {
	Content          string     `json:"content"`
	ReasoningContent string    `json:"reasoning_content"`
	ToolCalls       []ToolCall `json:"tool_calls"`
}

type chatDelta struct {
	Content          string          `json:"content"`
	ReasoningContent string         `json:"reasoning_content"`
	Role             string         `json:"role"`
	ToolCalls        []toolCallDelta `json:"tool_calls"`
}

type toolCallDelta struct {
	Function toolCallDeltaFunction `json:"function"`
	ID       string                `json:"id"`
	Index    *int                  `json:"index"`
	Type     string                `json:"type"`
}

type toolCallDeltaFunction struct {
	Arguments string `json:"arguments"`
	Name      string `json:"name"`
}

type textCompletionChunk struct {
	Choices []textChoice `json:"choices"`
	ID      string       `json:"id"`
	Usage   *Usage       `json:"usage"`
}

type textChoice struct {
	FinishReason string         `json:"finish_reason"`
	Logprobs     map[string]any `json:"logprobs"`
	Text         string         `json:"text"`
}

func DebugBody(body map[string]any) string {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Sprintf("<invalid body: %v>", err)
	}
	return string(data)
}
