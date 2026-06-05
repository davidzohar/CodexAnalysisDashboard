# Design

## Architecture

The dashboard is a local Node.js web app:

```text
Browser UI -> Node HTTP server -> Codex JSONL files
```

The server binds to `127.0.0.1` and serves both static assets and JSON APIs. It uses only built-in Node modules: `http`, `fs`, `path`, `readline`, and streams.

## Data Flow

1. Browser requests `/api/overview`.
2. Server recursively scans the configured sessions folder for `.jsonl` files.
3. Each file is streamed line by line.
4. The server builds one compact session summary per file.
5. Summaries are grouped into inferred chat threads.
6. The browser renders overview metrics, facets, filters, and use-case views.
7. When a session is selected, the browser requests `/api/session/:id`.
8. The server streams that one JSONL file again and returns a structured timeline, conversation records, tool records, token records, and metadata.

## API

### `GET /api/health`

Returns server health, source folder, and cache status.

### `GET /api/overview`

Builds or returns the in-memory index.

Query:

- `refresh=1` forces a rebuild.

Returns:

- totals
- facets
- inferred threads
- session summaries

### `GET /api/workflow`

Streams the indexed session files and builds per-turn workflow analytics.

Returns:

- turn lifecycle summaries
- operation category totals
- prompt-to-action classification totals
- patch verification metrics
- command exit-code and duration stats from `exec_command_end`
- failure taxonomy
- context compaction rows
- slow and failed command samples
- workflow quality scores and bands
- risk flag counts
- artifact write rows
- failure-to-fix loop status
- final-answer quality signals

### `GET /api/session/:id`

Parses one session file and returns:

- session summary
- payload type counts
- timeline events
- conversation rows
- tool call rows
- token event rows

### `GET /api/search`

Scans logs for a text term.

Query:

- `q`
- `type`
- `thread`
- `session`
- `limit`

## Session Summary Model

Each session summary contains:

- identity: `id`, `fileName`, `filePath`, `relativePath`
- timestamps: first, last, session metadata timestamp, file write time
- environment: `cwd`, model, effort, timezone, sandbox policy, approval policy
- git: repository URL, repository name, branch, commit hash
- counts: messages, tool calls, shell commands, plans, patches, token events, failures, compactions
- tools: names and counts
- commands: shell command labels and counts
- files: files touched by patch records
- tokens: final cumulative token usage when available
- previews: first user message, last user message, last agent message, latest failure signal

## Thread Inference

Codex session logs may not expose one durable thread id across files. The dashboard uses this order:

1. Explicit `thread_source` when present and not just `user`.
2. Same working directory.
3. Same repository URL and branch.
4. Single session fallback.

The UI labels these as "Chat Threads" and shows the reason for each grouping.

## UI Views

### Overview

Metrics, recent sessions, inferred threads, activity by day, and top shell commands.

### Workflow

Per-turn analysis showing prompt lifecycle, action class, timing to first tool and patch, operation categories, patch verification, command exit/duration telemetry, failure taxonomy, and context compaction.
It also exposes slow command and failed command samples for drill-down into expensive or problematic tool calls.
The Workflow view includes quality scoring, workflow-shape filters, risk flag filters, normalized step pills, artifact write tracking, failure-to-fix loop review, and final-answer quality checks.

### Chat Threads

Grouped sessions with workspace, time range, tool count, and token count.

### Transcript Archive

Session list and selected session detail with timeline, conversation, tools, tokens, and fields.

### Command Audit

Tool mix, shell command frequency, sessions with tool activity, and selected session drill-down.

### Project Activity

Workspace-level session counts, tool activity, patch counts, token usage, and failures.

### Repositories

Repository and branch activity.

### Files Changed

File frequency from structured patch records.

### Patch History

Patch call counts, patch result counts, success/failure counts, and touched file counts.

### Token Usage

Session-level token totals, token event counts, model, average time to first token, and average turn duration.

### Error Summary

Sessions with failed tool output or failed patches.

### Search

On-demand full-log search with optional payload type filtering.

## Performance Choices

- JSONL files are streamed instead of loaded whole.
- Overview stores compact summaries only.
- Workflow analysis is loaded lazily when the Workflow tab is opened.
- Detail parsing is done for one session at a time.
- Long messages and command outputs are truncated in API responses.
- Search returns capped results.

## Safety Choices

- The app does not write to session logs.
- The server listens on loopback only.
- Static file serving is constrained to the `public` directory.
- Session detail lookup uses indexed file paths, not arbitrary file paths from the browser.
