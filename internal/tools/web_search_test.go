package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/zilu-fuck/deepvibe/internal/llm"
)

func TestParseDuckDuckGoHTML(t *testing.T) {
	html := `
<a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Example <b>One</b></a>
<a class="result__snippet" href="/one">First &amp; useful result</a>
<a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Duplicate</a>
<a class="result__snippet" href="/one">Duplicate result</a>
<a rel="nofollow" class="result__a" href="https://example.com/two">Example Two</a>
<a class="result__snippet" href="/two">Second result</a>`

	results := ParseDuckDuckGoHTML(html)
	if len(results) != 2 {
		t.Fatalf("expected 2 deduped results, got %#v", results)
	}
	if results[0].Title != "Example One" || results[0].URL != "https://example.com/one" || results[0].Snippet != "First & useful result" {
		t.Fatalf("unexpected first result: %#v", results[0])
	}
}

func TestWebSearchToolUsesInjectedSearch(t *testing.T) {
	registry := CreateDefaultRegistry(ExecutionContext{Instruction: "look this up @web"})
	results, err := ExecuteToolCalls(context.Background(), []llm.ToolCall{
		{
			ID:   "web",
			Type: "function",
			Function: llm.ToolCallFunction{
				Name:      "web_search",
				Arguments: `{"query":"deepvibe","max_results":2}`,
			},
		},
	}, registry, ExecutionContext{
		Instruction: "look this up @web",
		SearchWeb: func(ctx context.Context, options SearchOptions) ([]WebSearchResult, error) {
			if options.Query != "deepvibe" || options.MaxResults != 2 {
				t.Fatalf("unexpected search options: %#v", options)
			}
			return []WebSearchResult{
				{Title: "DeepVibe", URL: "https://example.com", Snippet: "Result"},
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(results[0].Content, "DeepVibe") {
		t.Fatalf("unexpected web result: %s", results[0].Content)
	}
}

func TestWebSearchTriggerHelpers(t *testing.T) {
	if !HasWebSearchTrigger("check @web please") {
		t.Fatal("expected trigger")
	}
	if StripWebSearchTrigger("check   @web   please") != "check please" {
		t.Fatalf("unexpected stripped instruction")
	}
}
