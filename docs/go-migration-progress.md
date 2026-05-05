# Go Migration Progress

This document tracks the Go migration work that has been implemented in this branch. It is meant to complement `docs/重构方案-Go语言迁移.md` with concrete shipped slices and validation notes.

## Scope Completed

### Project Skeleton

- Added `go.mod`, `Makefile`, and Go command entrypoints:
  - `cmd/deepvibe`
  - `cmd/deepvibe-server`
- Added `internal/cli` with preview commands for config, scan, context, chat, plugins, undo, and server mode.

### Configuration And Context

- Added project/global config loading and mutation helpers in `internal/config`.
- Added project scanning and prompt context assembly in:
  - `internal/scanner`
  - `internal/context`
- Added `.deepvibe/context.json` session store support:
  - session list/new/switch
  - chat history persistence
  - turn summaries
  - active session bootstrap

### LLM And Model Handling

- Added DeepSeek client support in `internal/llm`:
  - chat completions
  - streaming completions
  - FIM completions
  - response parsing and repair retry support
- Added execution profile resolution in `internal/model` for default, flash, and deep modes.

### Tools, Backend, And Middleware

- Added tool registry and execution in `internal/tools`.
- Added file tools:
  - `list_files`
  - `read_file`
  - `write_file`
  - `delete_file`
- Added command execution tool with command policies, approval hooks, directory restrictions, service-mode protection, and dirty-worktree guard support.
- Added web search tool support.
- Added `internal/backend` with a local backend for file and command execution.
- Routed file and command tools through the backend layer.
- Added `internal/middleware` minimal pipeline:
  - backend injection
  - filesystem tool injection
  - command tool injection
  - web search tool injection

### Engine And Patch Flow

- Added `internal/engine` core execution flow:
  - dry-run context preview
  - context preparation
  - tool-call loop
  - repair retry
  - apply prepared execution
  - plan and execute-plan skeletons
- Added `internal/patcher` with unified diff application, path safety, and rollback behavior.
- Added `internal/git` operation recording, AI commit creation, and undo support.

### Server And Task Runtime

- Added `internal/server` HTTP and JSON-RPC endpoints:
  - health
  - run
  - FIM
  - tasks
  - undo
  - sessions
- Added `internal/task` manager for async task lifecycle and event streaming.

### REPL And Intent

- Added `internal/repl` minimal interactive loop with:
  - `/help`
  - `/sessions`
  - `/new`
  - `/switch`
  - `/history`
  - `/mode auto|chat|project`
  - `/quit`
- Added `internal/intent` for chat/read/write intent detection.
- Connected REPL auto mode to intent detection so read-only requests use dry-run and write requests use project execution.

### Plugins

- Added `internal/plugins` manifest discovery and validation:
  - `.deepvibe/plugins/*/plugin.json`
  - `js` and `wasm` kind validation
  - enabled filtering
  - runtime and permissions validation
  - entry path escape checks
  - discovery status counts
- Added `deepvibe plugins [--json]` CLI preview.

### Deepagents Study Notes

- Added `docs/deepagents` study notes and migration lessons.
- Key architectural lesson applied in code: split future Go runtime into `engine + middleware + backend + entrypoints + evals` instead of growing one large engine package.

## Validation

The following checks were run repeatedly during the migration:

- `git diff --check`
- targeted trailing whitespace checks for modified Go files
- `npm run check`
- `npm test -- --run`

Latest TypeScript validation result:

- `npm run check`: passed
- `npm test -- --run`: passed, 24 test files and 281 tests

Go validation is currently blocked because this local Windows environment does not have `go` or `gofmt` available on `PATH`.

## Known Gaps

- Go code has not been formatted or compiled locally due to missing Go toolchain.
- `internal/backend` currently has only a local backend.
- `internal/middleware` is a minimal pipeline and does not yet implement permissions, summarization, verification, subagents, or plugin tool injection.
- Plugin support currently covers discovery and manifest validation only; Node.js plugin host execution is not wired into the Go tool registry yet.
- REPL is a minimal line-based loop, not the full Bubble Tea TUI described in the migration plan.
- Go evals and behavior fixtures are not yet added.

## Recommended Next Steps

1. Install Go 1.23+ locally and run:
   - `gofmt`
   - `go test ./...`
2. Add `internal/permissions` or `internal/middleware/permissions` and enforce read/write/execute rules before backend calls.
3. Add `internal/verification` and persist verification results into session turns.
4. Add planning/todo state as a tool-backed capability.
5. Add a minimal `task`/subagent abstraction with isolated context.
6. Connect plugin manifest loading to actual tool registration through the existing Node.js host path.
