# Changelog

## v0.1.0

### Core Engine
- CLI entrypoint with `--help`, `--dry-run`, `--force`, and `undo`
- Project scanning with `.gitignore` and `.deepvibeignore` support
- Context building with token-budget trimming using tiktoken
- DeepSeek request construction, timeout handling, retry/backoff, and SSE parsing
- Structured response parsing with automatic repair retry
- Diff application with rollback on failure
- AI commit and AI operation recording
- Tool-call loop with safe read/write tools and allowlisted command execution
- 1M-context-aware prompt budgeting

### Features
- Live web search via `@web` trigger (DuckDuckGo, Tavily, Bing)
- Interactive REPL with streaming responses and session management
- Multi-step plan mode with step-by-step execution
- Session memory in `.deepvibe/context.json` with turn tracking
- Built-in HTTP + JSON-RPC service mode
- Task-based SSE event streaming with cancellation
- First-pass local plugin system for tool contributions
- Project-level custom system prompt via `.deepvibe/prompt.md`
