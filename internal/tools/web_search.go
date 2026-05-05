package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/zilu-fuck/deepvibe/internal/config"
)

const webSearchTrigger = "@web"
const defaultMaxSearchResults = 5
const defaultSearchTimeout = 15 * time.Second

type WebSearchTool struct{}

type WebSearchError struct {
	Message string
}

func (e *WebSearchError) Error() string {
	return e.Message
}

func (t WebSearchTool) Definition() Definition {
	return Definition{
		Type: "function",
		Function: FunctionDef{
			Name:        "web_search",
			Description: "Run a web search and return the top search results.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"query"},
				"properties": map[string]any{
					"query":       map[string]any{"type": "string"},
					"max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 10},
				},
			},
		},
	}
}

func (t WebSearchTool) Execute(ctx context.Context, args json.RawMessage, execCtx ExecutionContext) (string, error) {
	var parsed struct {
		Query      string `json:"query"`
		MaxResults int    `json:"max_results"`
	}
	if err := parseToolArgs(args, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.Query) == "" {
		return "", fmt.Errorf(`web_search requires a non-empty "query" argument`)
	}

	search := execCtx.SearchWeb
	if search == nil {
		search = SearchWeb
	}
	maxResults := parsed.MaxResults
	if maxResults <= 0 {
		maxResults = defaultMaxSearchResults
	}
	if maxResults > 10 {
		maxResults = 10
	}

	results, err := search(ctx, SearchOptions{
		MaxResults: maxResults,
		Query:      parsed.Query,
	})
	if err != nil {
		return "", err
	}

	return encodeToolJSON(map[string]any{
		"ok":      true,
		"results": results,
	})
}

func HasWebSearchTrigger(instruction string) bool {
	return strings.Contains(instruction, webSearchTrigger)
}

func StripWebSearchTrigger(instruction string) string {
	return strings.TrimSpace(strings.Join(strings.Fields(strings.ReplaceAll(instruction, webSearchTrigger, "")), " "))
}

func BuildContextSearchSection(results []WebSearchResult) string {
	lines := []string{"Web search results:"}
	for index, result := range results {
		lines = append(lines, fmt.Sprintf("%d. %s", index+1, result.Title))
		lines = append(lines, "   URL: "+result.URL)
		lines = append(lines, "   Summary: "+result.Snippet)
	}
	return strings.Join(lines, "\n")
}

func SearchWeb(ctx context.Context, options SearchOptions) ([]WebSearchResult, error) {
	query := strings.TrimSpace(options.Query)
	if query == "" {
		return nil, &WebSearchError{Message: "a non-empty query is required for @web search"}
	}

	maxResults := options.MaxResults
	if maxResults <= 0 {
		maxResults = defaultMaxSearchResults
	}
	if maxResults > 10 {
		maxResults = 10
	}

	provider := options.Provider
	if provider == "" {
		provider = config.SearchProviderDuckDuckGo
	}

	switch provider {
	case config.SearchProviderBing:
		return searchWithBing(ctx, query, options.SearchAPIKey, maxResults)
	case config.SearchProviderTavily:
		return searchWithTavily(ctx, query, options.SearchAPIKey, maxResults)
	default:
		return searchWithDuckDuckGo(ctx, query, maxResults)
	}
}

func searchWithDuckDuckGo(ctx context.Context, query string, maxResults int) ([]WebSearchResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, defaultSearchTimeout)
	defer cancel()

	endpoint := "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 (DeepVibe Core)")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, &WebSearchError{Message: fmt.Sprintf("web search failed for %s: %v", endpoint, err)}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &WebSearchError{Message: fmt.Sprintf("web search request failed with status %d", response.StatusCode)}
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, 2_000_000))
	if err != nil {
		return nil, err
	}
	results := ParseDuckDuckGoHTML(string(data))
	if len(results) == 0 && len(data) > 0 {
		return nil, &WebSearchError{Message: "web search returned no parseable results"}
	}
	if len(results) > maxResults {
		results = results[:maxResults]
	}
	return results, nil
}

func searchWithTavily(ctx context.Context, query string, apiKey string, maxResults int) ([]WebSearchResult, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, &WebSearchError{Message: "Tavily search requires a search API key"}
	}
	return nil, &WebSearchError{Message: "Tavily search is not wired in this migration phase"}
}

func searchWithBing(ctx context.Context, query string, apiKey string, maxResults int) ([]WebSearchResult, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, &WebSearchError{Message: "Bing search requires a search API key"}
	}
	return nil, &WebSearchError{Message: "Bing search is not wired in this migration phase"}
}

func ParseDuckDuckGoHTML(markup string) []WebSearchResult {
	titlePattern := regexp.MustCompile(`(?s)<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)</a>`)
	snippetPattern := regexp.MustCompile(`(?s)<a class="result__snippet"[^>]*>(.*?)</a>`)
	matches := titlePattern.FindAllStringSubmatchIndex(markup, -1)

	var results []WebSearchResult
	for index, match := range matches {
		blockStart := match[0]
		blockEnd := len(markup)
		if index+1 < len(matches) {
			blockEnd = matches[index+1][0]
		}
		block := markup[blockStart:blockEnd]

		rawURL := markup[match[2]:match[3]]
		rawTitle := markup[match[4]:match[5]]
		snippet := ""
		if snippetMatch := snippetPattern.FindStringSubmatch(block); len(snippetMatch) >= 2 {
			snippet = cleanHTMLText(snippetMatch[1])
		}

		title := cleanHTMLText(rawTitle)
		decodedURL := decodeDuckDuckGoRedirect(rawURL)
		if title == "" || decodedURL == "" {
			continue
		}
		results = append(results, WebSearchResult{
			Title:   title,
			Snippet: snippet,
			URL:     decodedURL,
		})
	}

	return dedupeSearchResults(results)
}

func decodeDuckDuckGoRedirect(rawURL string) string {
	absoluteURL := rawURL
	if strings.HasPrefix(absoluteURL, "//") {
		absoluteURL = "https:" + absoluteURL
	}

	parsed, err := url.Parse(absoluteURL)
	if err != nil {
		return rawURL
	}
	if parsed.Scheme == "" {
		parsed, err = url.Parse("https://html.duckduckgo.com" + absoluteURL)
		if err != nil {
			return rawURL
		}
	}

	redirected := parsed.Query().Get("uddg")
	if redirected == "" {
		return parsed.String()
	}
	value, err := url.QueryUnescape(redirected)
	if err != nil {
		return redirected
	}
	return value
}

func cleanHTMLText(value string) string {
	tagPattern := regexp.MustCompile(`<[^>]+>`)
	withoutTags := tagPattern.ReplaceAllString(value, " ")
	return strings.TrimSpace(strings.Join(strings.Fields(html.UnescapeString(withoutTags)), " "))
}

func dedupeSearchResults(results []WebSearchResult) []WebSearchResult {
	seen := map[string]bool{}
	deduped := make([]WebSearchResult, 0, len(results))
	for _, result := range results {
		if seen[result.URL] {
			continue
		}
		seen[result.URL] = true
		deduped = append(deduped, result)
	}
	return deduped
}
