import { describe, expect, it, vi } from "vitest";

import {
  buildContextSearchSection,
  hasWebSearchTrigger,
  parseDuckDuckGoHtml,
  searchWeb,
  stripWebSearchTrigger,
  WebSearchError
} from "../src/search.js";

describe("search helpers", () => {
  it("detects and strips the @web trigger", () => {
    expect(hasWebSearchTrigger("fix this @web now")).toBe(true);
    expect(stripWebSearchTrigger("fix this @web now")).toBe("fix this now");
  });

  it("parses DuckDuckGo HTML results and decodes redirect URLs", () => {
    const results = parseDuckDuckGoHtml(`
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example Docs</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Use <b>Example</b> docs now.</a>
    `);

    expect(results).toEqual([
      {
        title: "Example Docs",
        snippet: "Use Example docs now.",
        url: "https://example.com/docs"
      }
    ]);
  });

  it("executes a web search with a mocked fetch implementation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">Example Guide</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">Latest <b>guide</b> text.</a>
        `,
        { status: 200 }
      )
    );

    const results = await searchWeb({
      query: "example query",
      fetchFn
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      title: "Example Guide",
      url: "https://example.com/guide"
    });
  });

  it("falls back to the provided html fetcher when fetch fails", async () => {
    const results = await searchWeb({
      query: "example query",
      fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
      fallbackHtmlFetcher: vi.fn().mockResolvedValue(`
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffallback&amp;rut=abc">Fallback Guide</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffallback&amp;rut=abc">Fallback <b>guide</b> text.</a>
      `)
    });

    expect(results[0]).toMatchObject({
      title: "Fallback Guide",
      url: "https://example.com/fallback"
    });
  });

  it("renders search results into a context section", () => {
    const section = buildContextSearchSection([
      {
        title: "Example Guide",
        url: "https://example.com/guide",
        snippet: "Latest guide text."
      }
    ]);

    expect(section).toContain("联网搜索结果");
    expect(section).toContain("https://example.com/guide");
  });

  it("throws WebSearchError when HTML is non-empty but yields no parseable results", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><body>No results here</body></html>", { status: 200 })
    );

    await expect(
      searchWeb({ query: "test query", fetchFn })
    ).rejects.toThrow(WebSearchError);
  });

  it("throws WebSearchError on fetch timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 100))
    );

    await expect(
      searchWeb({ query: "test query", fetchFn, timeoutMs: 50 })
    ).rejects.toThrow(WebSearchError);
  });

  it("does not throw when HTML is genuinely empty (empty string)", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("", { status: 200 })
    );

    const results = await searchWeb({ query: "test query", fetchFn });
    expect(results).toEqual([]);
  });
});

describe("tavily provider", () => {
  it("searches via Tavily API and maps results", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: "Tavily Result", content: "Snippet text", url: "https://example.com/tavily" }
          ]
        }),
        { status: 200 }
      )
    );

    const results = await searchWeb({
      query: "test query",
      provider: "tavily",
      searchApiKey: "tvly-test-key",
      fetchFn
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.api_key).toBe("tvly-test-key");
    expect(body.query).toBe("test query");
    expect(results).toEqual([
      { title: "Tavily Result", snippet: "Snippet text", url: "https://example.com/tavily" }
    ]);
  });

  it("throws WebSearchError when API key is missing", async () => {
    await expect(
      searchWeb({ query: "test", provider: "tavily" })
    ).rejects.toThrow(WebSearchError);
  });

  it("throws WebSearchError on non-OK response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("error", { status: 429 })
    );

    await expect(
      searchWeb({ query: "test", provider: "tavily", searchApiKey: "key", fetchFn })
    ).rejects.toThrow(WebSearchError);
  });
});

describe("bing provider", () => {
  it("searches via Bing API and maps results", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          webPages: {
            value: [
              { name: "Bing Result", snippet: "Bing snippet", url: "https://example.com/bing" }
            ]
          }
        }),
        { status: 200 }
      )
    );

    const results = await searchWeb({
      query: "test query",
      provider: "bing",
      searchApiKey: "bing-test-key",
      fetchFn
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("https://api.bing.microsoft.com/v7.0/search");
    expect((init?.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("bing-test-key");
    expect(results).toEqual([
      { title: "Bing Result", snippet: "Bing snippet", url: "https://example.com/bing" }
    ]);
  });

  it("throws WebSearchError when API key is missing", async () => {
    await expect(
      searchWeb({ query: "test", provider: "bing" })
    ).rejects.toThrow(WebSearchError);
  });

  it("throws WebSearchError on non-OK response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("error", { status: 403 })
    );

    await expect(
      searchWeb({ query: "test", provider: "bing", searchApiKey: "key", fetchFn })
    ).rejects.toThrow(WebSearchError);
  });
});
