# DeepVibe Core

CLI-first AI coding engine for DeepSeek workflows.

## Status

This repository currently contains the `M1` MVP foundation:

- CLI entrypoint with `--help`, `--dry-run`, `--force`, and `undo`
- project scanning with `.gitignore` / `.deepvibeignore` support
- context building with token-budget trimming
- DeepSeek request construction, timeout handling, retry/backoff, and SSE parsing
- structured response parsing with one automatic repair retry
- diff application with rollback on failure
- AI commit / AI operation recording
- first-pass `undo` support
- tool-call loop with safe read/write tools and allowlisted command execution
- 1M-context-aware prompt budgeting and larger default candidate windows
- persistent session memory in `.deepvibe/context.json`
- built-in HTTP + JSON-RPC service mode
- task-based SSE event streaming, cancellation, and service-side concurrency isolation
- first-pass local plugin system for tool contributions
- project-level custom system prompt via `.deepvibe/prompt.md`
- interactive REPL with streaming responses and per-turn confirmation
- session management with persistence, switching, and history
- multi-step plan mode with step-by-step execution

Current gaps:

- no richer plugin lifecycle management or resource governance beyond timeout/memory cap yet

## Requirements

- Node.js `18+`
- `pnpm`
- Git
- a DeepSeek API key for real execution

## Install Dependencies

```bash
pnpm install
```

## Local Development

```bash
pnpm check
pnpm test
pnpm cli --help
```

## Configuration

DeepVibe reads config from:

- global: `~/.deepvibe/config.json`
- project: `.deepvibe/config.json`

Minimal example:

```json
{
  "apiKey": "YOUR_DEEPSEEK_API_KEY",
  "defaultModel": "deepseek-v4-pro",
  "ignore": ["coverage/**"],
  "toolPermissions": {
    "command": {
      "enabled": true,
      "commandPolicies": [
        {
          "prefix": "git status",
          "risk": "low",
          "allowInService": true,
          "allowedDirectories": ["."],
          "allowPersistentApproval": true,
          "timeoutMs": 3000,
          "maxOutputChars": 2000
        },
        {
          "prefix": "git add",
          "risk": "medium",
          "allowedDirectories": ["src"],
          "requireCleanGit": true
        },
        { "prefix": "git push", "risk": "high" }
      ],
      "sandbox": {
        "enabled": true,
        "image": "node:20-alpine",
        "network": "none",
        "readOnlyRootFilesystem": true,
        "tmpfsPaths": ["/tmp", "/var/tmp"]
      },
      "requireApproval": true,
      "persistApprovals": true,
      "timeoutMs": 5000,
      "maxOutputChars": 4000
    }
  }
}
```

Project config overrides global defaults.

You can also write config from the CLI:

```bash
pnpm cli config set api_key YOUR_DEEPSEEK_API_KEY
pnpm cli config set default_model deepseek-v4-flash --project
```

If you start a command that needs real model execution and no API key is configured, the CLI will now prompt you to configure one and save it to global config before continuing.

Workspace trust notes:

- DeepVibe now treats new workspaces as **sandboxed by default**
- on first entry, the CLI can ask whether the current folder should stay in sandbox mode or be marked as fully trusted
- sandbox mode uses an isolated temporary workspace copy, so the original project directory is not modified directly
- when sandbox mode produces real file changes, DeepVibe now performs a dedicated **Sandbox Landing Review** before applying those changes back to the original workspace
- you can manually change trust later with:

```bash
pnpm cli config trust sandbox
pnpm cli config trust full
pnpm cli config trust clear
```

- only a manual user action should move a workspace to full access

Project prompt notes:

- if `.deepvibe/prompt.md` exists, its contents are appended to the system prompt
- this lets a repository add local coding rules without replacing the built-in prompt entirely

Command tool notes:

- `run_command` is disabled by default
- it only appears when `toolPermissions.command.enabled` is `true`
- commands must match one of the configured `commandPolicies` or legacy `allowedPrefixes`
- policy matching picks the **longest** prefix match (most specific wins)
- each policy supports these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prefix` | string | *(required)* | Command prefix to match (e.g. `"git status"`, `"pnpm test"`) |
| `risk` | `"low" \| "medium" \| "high"` | inferred from prefix | Risk tier; `high` requires explicit `"allow"` text |
| `allowInService` | boolean | `false` | Allow this command when running via HTTP/JSON-RPC service |
| `allowPersistentApproval` | boolean | `true` for `low` | Allow `"Always"` choice to persist approval in `.deepvibe/command-approvals.json` |
| `allowedDirectories` | string[] | *(any dir)* | Restrict this command to specific project subdirectories |
| `requireCleanGit` | boolean | `false` | Reject this command when the Git working tree has uncommitted changes |
| `timeoutMs` | number | global timeoutMs | Per-policy override of command execution timeout (minimum 1000ms) |
| `maxOutputChars` | number | global maxOutputChars | Per-policy override of stdout/stderr output character limit (minimum 256) |

- optional `toolPermissions.command.sandbox` can force `run_command` to execute inside a Docker sandbox instead of on the host
- recommended readonly sandbox example:

```json
{
  "toolPermissions": {
    "command": {
      "enabled": true,
      "sandbox": {
        "enabled": true,
        "image": "node:20-alpine",
        "network": "none",
        "readOnlyRootFilesystem": true,
        "tmpfsPaths": ["/tmp", "/var/tmp"]
      }
    }
  }
}
```

- with Docker sandbox enabled:
  - the project is mounted read-only into the container
  - the container root filesystem is read-only by default
  - temporary writable space is provided only through `tmpfsPaths`
  - network is disabled by default (`none`)
- this is meant to keep AI command execution isolated from accidental destructive host mutations
- write operations performed through DeepVibe's own patch/apply flow are still controlled separately from `run_command`
- `low` risk: can use `Always` when persistent approvals are enabled
- `medium` risk: single-use approval only
- `high` risk: explicit strong confirmation text required (type `"allow"`)
- when `persistApprovals` is `true`, choosing `Always` stores the approval in `.deepvibe/command-approvals.json`
- set `toolPermissions.command.requireApproval` to `false` only for fully trusted repositories
- working directories are still constrained to the project root

Legacy `allowedPrefixes` (string array without per-policy fields) is still supported but
discouraged; prefer `commandPolicies` for full policy control.

Full command policy example:

```json
{
  "toolPermissions": {
    "command": {
      "enabled": true,
      "requireApproval": true,
      "persistApprovals": true,
      "timeoutMs": 15000,
      "maxOutputChars": 16000,
      "commandPolicies": [
        { "prefix": "git status", "risk": "low", "allowInService": true, "allowPersistentApproval": true },
        { "prefix": "git diff", "risk": "low", "allowInService": true },
        { "prefix": "pnpm test", "risk": "low" },
        { "prefix": "npm test", "risk": "low" },
        { "prefix": "git add", "risk": "medium", "requireCleanGit": false },
        { "prefix": "git commit", "risk": "high", "allowedDirectories": ["src"], "requireCleanGit": true },
        { "prefix": "git push", "risk": "high", "allowInService": false },
        { "prefix": "pnpm build", "risk": "medium", "timeoutMs": 120000, "maxOutputChars": 32000 },
        { "prefix": "npm run build", "risk": "medium", "timeoutMs": 120000 }
      ]
    }
  }
}
```

Session memory notes:

- DeepVibe stores first-pass session memory in `.deepvibe/context.json`
- it records turn summaries, touched files, search summaries, tool summaries, and result references
- it does not persist raw chain-of-thought or large raw file contents

Plugin notes:

- project-local plugins can live under `.deepvibe/plugins/<plugin-name>/`
- each plugin must provide a `plugin.json`
- the entry module can export `createTools(context)` to contribute `LocalTool[]`
- plugins can declare first-pass permissions in `plugin.json`
- service mode can refuse plugin tools unless the plugin manifest explicitly allows them
- plugin code is executed through an isolated child-process host
- each `describe` / `execute` call uses a fresh plugin host process; plugin state does not persist across calls
- plugin source is still pre-validated in a restricted sandbox style:
  - static imports are rejected
  - dynamic imports are rejected
  - `process` / `require` are not exposed
  - string-based code generation is not exposed
- each plugin host call has a timeout, a memory cap, and a maximum result size
- `dispose()` is attempted after describe/execute even when plugin initialization or execution fails
- plugin host calls honor engine cancellation via `abortSignal`
- plugins may also declare:
  - `version`
  - `runtime.timeoutMs`
  - `runtime.memoryLimitMb`
  - `runtime.maxResultChars`
  - optional lifecycle hooks such as `initialize(context)` and `dispose()`

## Usage

Dry-run only builds scan/context state and does not call the model:

```bash
pnpm cli --dry-run "summarize the project"
```

Dry-run with `@web` injects live search results into the context:

```bash
pnpm cli --dry-run "@web deepseek api timeout retry"
```

`@web` currently works in two paths:

1. Context injection
   - when the user instruction contains `@web`, the engine runs a local web search first
   - results are formatted into the context so the model sees them directly
2. Tool call
   - when the user instruction contains `@web`, the tool registry also exposes a `web_search` tool
   - the model can call that tool later in the tool loop for follow-up searches

Search backend notes:

- the current implementation is a local multi-provider adapter
- supported providers:
  - `duckduckgo` as the default/fallback HTML search path
  - `tavily` via API key
  - `bing` via API key
- DuckDuckGo results are fetched and parsed locally from HTML
- if DuckDuckGo `fetch` fails, it falls back to Python `urllib`
- this is not a native DeepSeek web-search request parameter

Real execution requires:

- a Git repository
- a configured API key

Interactive execution:

```bash
pnpm cli "update API timeout handling"
```

The CLI will:

1. scan the project
2. build context
3. call the model
4. show a change summary
5. ask for `[A]ccept / [R]eview / [N]o`

In review mode, the CLI now shows each file diff one by one so you can apply or skip files individually before anything is written.

Skip confirmation:

```bash
pnpm cli --force "update API timeout handling"
```

Use a faster/lower-effort model:

```bash
pnpm cli --flash "fix typo in README"
```

Use maximum reasoning effort:

```bash
pnpm cli --deep "refactor the authentication module"
```

Undo the most recent successful AI change:

```bash
pnpm cli undo
```

Start the built-in service:

```bash
pnpm cli serve --host 127.0.0.1 --port 4242
```

Service endpoints:

- `GET /health`
- `POST /run`
- `POST /undo`
- `POST /rpc` for JSON-RPC 2.0
- `POST /tasks/run`
- `GET /tasks/:taskId`
- `GET /tasks/:taskId/events` (SSE)
- `POST /tasks/:taskId/cancel`
- `GET /sessions`
- `POST /sessions/new`
- `POST /sessions/switch`
- `GET /sessions/history`

Task event stream notes:

- `GET /tasks/:taskId/events` returns SSE events with `event: <type>` and `data: <json>`
- the JSON payload uses a stable envelope:
  - `id`: per-task event sequence
  - `taskId`: task identifier
  - `type`: event name
  - `source`: `task` or `engine`
  - `status`: task status at emission time
  - `terminal`: whether this is a terminal task event
  - `timestamp`: ISO timestamp
  - `version`: currently `1`
  - `payload`: event-specific fields
- common task-level events:
  - `task.started`
  - `task.cancel_requested`
  - `task.completed`
  - `task.failed`
  - `task.canceled`
- common engine-level events currently include:
  - `scan.started`
  - `scan.completed`
  - `context.built`
  - `model.requested`
  - `model.completed`
  - `tool_calls.requested`
  - `tool_calls.completed`
  - `apply.completed`
  - `apply.skipped`
- the SSE stream closes automatically after a terminal event

## Interactive REPL (chat mode)

Start an interactive REPL session:

```bash
pnpm cli chat
pnpm cli chat --flash      # prefer flash model
pnpm cli chat --deep       # prefer deep reasoning
pnpm cli chat --session <id>   # resume a specific session
```

In the REPL:
- if the current directory is not a Git repository, DeepVibe starts in chat-only mode
- Type any instruction and the engine will analyze, stream the response, and prompt for confirmation
- When changes are proposed, use `[A]ccept`, `[R]eview` (to see diffs), or `[N]o`
- Slash commands:
  - `/new` — start a new session
  - `/history` — show conversation history
  - `/sessions` — list all sessions
  - `/switch <id>` — switch to a different session
  - `/clear` — clear the screen (TTY only)
  - `/help` — show help
  - `/quit` or `/exit` — exit the REPL

**Sessions:**
- Each session maintains its own conversation history and turn history
- Sessions are persisted in `.deepvibe/context.json` (max 20 sessions, max 200 chat messages per session)
- Session history summaries are injected into the context for cross-turn awareness

Chat-only mode notes:

- normal conversation works even outside a Git repository
- file edits, patches, and repo operations stay disabled until you enter a Git repository
- if you ask for clear project/file creation work in chat-only mode, DeepVibe can prompt to run `git init` and switch into project mode
- once you open the REPL inside a Git repository, DeepVibe switches back to full project mode

## Multi-step Plan Mode

Generate a plan first, then execute step by step:

```bash
pnpm cli --plan "add user authentication with JWT"
```

The engine will:
1. Generate a multi-step plan with overview, steps, and notes
2. Let you review and confirm the plan
3. Execute each step individually with per-step confirmation ([A]ccept/[S]kip/[R]eview/[N]o stop)

Undo behavior:

- clean Git workspace: reverts the latest AI commit if it is still at `HEAD`
- dirty Git workspace: restores files only if current contents still match the recorded AI post-image hashes

## Scripts

```bash
pnpm check
pnpm test
pnpm build
pnpm cli --help
```

Publishing is gated by:

```bash
pnpm prepublishOnly
```

Recommended full release check:

```bash
pnpm release:check
pnpm release:smoke
```

`release:check` verifies typecheck, tests, build, and tarball contents.
`release:smoke` installs the packed tarball into a temporary prefix and verifies the published `deepvibe` binary can run `--help` and `serve --help`.

Detailed release notes:

- [docs/发布流程.md](</F:/deepseek code/docs/发布流程.md>)

## Repository Notes

Key implementation files:

- [src/engine.ts](</F:/deepseek code/src/engine.ts>)
- [src/cli.ts](</F:/deepseek code/src/cli.ts>)
- [src/repl.ts](</F:/deepseek code/src/repl.ts>)
- [src/context-store.ts](</F:/deepseek code/src/context-store.ts>)
- [src/search.ts](</F:/deepseek code/src/search.ts>)
- [src/tools.ts](</F:/deepseek code/src/tools.ts>)
- [src/project/scanner.ts](</F:/deepseek code/src/project/scanner.ts>)
- [src/context/builder.ts](</F:/deepseek code/src/context/builder.ts>)
- [src/llm/deepseek-client.ts](</F:/deepseek code/src/llm/deepseek-client.ts>)
- [src/llm/response-parser.ts](</F:/deepseek code/src/llm/response-parser.ts>)
- [src/patcher.ts](</F:/deepseek code/src/patcher.ts>)
- [src/project/git-manager.ts](</F:/deepseek code/src/project/git-manager.ts>)

Design references:

- [docs/项目计划.md](</F:/deepseek code/docs/项目计划.md>)
- [docs/开发任务拆解.md](</F:/deepseek code/docs/开发任务拆解.md>)
