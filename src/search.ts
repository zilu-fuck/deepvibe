import { execFile } from "node:child_process";
import { promisify } from "node:util";

const WEB_TRIGGER = "@web";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export type SearchProviderId = "duckduckgo" | "tavily" | "bing";

export interface WebSearchResult {
  snippet: string;
  title: string;
  url: string;
}

export interface SearchWebOptions {
  abortSignal?: AbortSignal;
  fallbackHtmlFetcher?: (url: string) => Promise<string>;
  fetchFn?: typeof fetch;
  maxResults?: number;
  provider?: SearchProviderId;
  pythonCommand?: string;
  query: string;
  searchApiKey?: string;
  timeoutMs?: number;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

export function hasWebSearchTrigger(instruction: string): boolean {
  return instruction.includes(WEB_TRIGGER);
}

export function stripWebSearchTrigger(instruction: string): string {
  return instruction.replaceAll(WEB_TRIGGER, "").replace(/\s+/gu, " ").trim();
}

export function buildContextSearchSection(results: WebSearchResult[]): string {
  const lines = ["联网搜索结果："];

  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   URL: ${result.url}`);
    lines.push(`   摘要: ${result.snippet}`);
  }

  return lines.join("\n");
}

export async function searchWeb(options: SearchWebOptions): Promise<WebSearchResult[]> {
  const query = options.query.trim();

  if (query.length === 0) {
    throw new WebSearchError("A non-empty query is required for @web search.");
  }

  const provider = options.provider ?? "duckduckgo";
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  if (options.abortSignal?.aborted) {
    throw new WebSearchError("Web search was aborted.");
  }

  switch (provider) {
    case "tavily":
      return searchWithTavily(query, options, maxResults);
    case "bing":
      return searchWithBing(query, options, maxResults);
    default:
      return searchWithDuckDuckGo(query, options, maxResults);
  }
}

async function searchWithDuckDuckGo(
  query: string,
  options: SearchWebOptions,
  maxResults: number
): Promise<WebSearchResult[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchSearchHtml(url, {
    abortSignal: options.abortSignal,
    fallbackHtmlFetcher: options.fallbackHtmlFetcher,
    fetchFn,
    pythonCommand: options.pythonCommand,
    timeoutMs
  });

  const results = parseDuckDuckGoHtml(html);

  if (results.length === 0 && html.length > 0) {
    throw new WebSearchError(
      "Web search returned no parseable results. The search page structure may have changed."
    );
  }

  return results.slice(0, maxResults);
}

async function searchWithTavily(
  query: string,
  options: SearchWebOptions,
  maxResults: number
): Promise<WebSearchResult[]> {
  const apiKey = options.searchApiKey;

  if (!apiKey) {
    throw new WebSearchError("Tavily search requires a searchApiKey. Configure tavilyApiKey in your config.");
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.abortSignal ?? AbortSignal.timeout(timeoutMs);

  const response = await fetchFn("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false
    }),
    signal
  });

  if (!response.ok) {
    throw new WebSearchError(`Tavily search failed with status ${response.status}.`);
  }

  const json = (await response.json()) as TavilyResponse;

  return (json.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    snippet: r.content ?? "",
    url: r.url ?? ""
  }));
}

async function searchWithBing(
  query: string,
  options: SearchWebOptions,
  maxResults: number
): Promise<WebSearchResult[]> {
  const apiKey = options.searchApiKey;

  if (!apiKey) {
    throw new WebSearchError("Bing search requires a searchApiKey. Configure bingApiKey in your config.");
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.abortSignal ?? AbortSignal.timeout(timeoutMs);
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${maxResults}`;

  const response = await fetchFn(url, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
    signal
  });

  if (!response.ok) {
    throw new WebSearchError(`Bing search failed with status ${response.status}.`);
  }

  const json = (await response.json()) as BingResponse;

  return (json.webPages?.value ?? []).slice(0, maxResults).map((r) => ({
    title: r.name ?? "",
    snippet: r.snippet ?? "",
    url: r.url ?? ""
  }));
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const titlePattern = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/gu;
  const matches = [...html.matchAll(titlePattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const blockStart = match.index ?? 0;
    const blockEnd = matches[index + 1]?.index ?? html.length;
    const block = html.slice(blockStart, blockEnd);
    const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/u);
    const rawUrl = match[1];
    const title = cleanHtmlText(match[2] ?? "");
    const snippet = cleanHtmlText(snippetMatch?.[1] ?? "");
    const url = decodeDuckDuckGoRedirect(rawUrl);

    if (!title || !url) {
      continue;
    }

    results.push({
      title,
      snippet,
      url
    });
  }

  return dedupeResults(results);
}

interface TavilyResponse {
  results?: Array<{
    content?: string;
    title?: string;
    url?: string;
  }>;
}

interface BingResponse {
  webPages?: {
    value?: Array<{
      name?: string;
      snippet?: string;
      url?: string;
    }>;
  };
}

function decodeDuckDuckGoRedirect(rawUrl: string): string {
  try {
    const absoluteUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(absoluteUrl, "https://html.duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");

    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return rawUrl;
  }
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x27;/gu, "'")
    .replace(/&#x2F;/gu, "/");
}

function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];

  for (const result of results) {
    if (seen.has(result.url)) {
      continue;
    }

    seen.add(result.url);
    deduped.push(result);
  }

  return deduped;
}

async function fetchSearchHtml(
  url: string,
  options: {
    fallbackHtmlFetcher?: (url: string) => Promise<string>;
    fetchFn: typeof fetch;
    pythonCommand?: string;
    abortSignal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<string> {
  const signal = options.abortSignal ?? AbortSignal.timeout(options.timeoutMs);

  try {
    const response = await options.fetchFn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (DeepVibe Core)"
      },
      signal
    });

    if (!response.ok) {
      throw new WebSearchError(`Web search request failed with status ${response.status}.`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof WebSearchError) {
      throw error;
    }

    if (options.fallbackHtmlFetcher) {
      return options.fallbackHtmlFetcher(url);
    }

    return fetchSearchHtmlWithPython(url, options.pythonCommand, signal);
  }
}

async function fetchSearchHtmlWithPython(url: string, pythonCommand = "python", abortSignal?: AbortSignal): Promise<string> {
  const script = [
    "import sys, urllib.request",
    "url = sys.argv[1]",
    "req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (DeepVibe Core)'})",
    "with urllib.request.urlopen(req, timeout=20) as response:",
    "    sys.stdout.write(response.read().decode('utf-8', 'ignore'))"
  ].join("\n");

  try {
    const { stdout } = await execFileAsync(pythonCommand, ["-c", script, url], {
      maxBuffer: 2_000_000,
      signal: abortSignal
    });

    return stdout;
  } catch (error) {
    throw new WebSearchError(
      `Web search failed for ${url}: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}
