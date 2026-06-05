# Codex Analysis Dashboard

Local browser dashboard for Codex JSONL session logs.

## Run

```powershell
cd "C:\path\to\codex_analysis"
npm start
```

Open:

```text
http://127.0.0.1:3377
```

By default the server reads:

```text
C:\Users\<user>\.codex\sessions
```

To point at another Codex session folder:

```powershell
$env:CODEX_SESSIONS_DIR="C:\path\to\sessions"
npm start
```

To use another port:

```powershell
$env:PORT="3388"
npm start
```

## What It Provides

- Top-level dashboard metrics for sessions, inferred chat threads, messages, tool calls, shell commands, patches, tokens, and failures.
- Filters by text, inferred thread, workspace, repository, model, tool, date range, and failure status.
- Drill-down views for transcript archive, command audit, project activity, repositories, changed files, patch history, token usage, error summary, and global search.
- Workflow analysis for per-turn lifecycle, operation categories, patch verification, command exit/duration telemetry, failure taxonomy, and context compaction.
- Workflow quality review with scores, risk flags, normalized step timelines, artifact writes, failure-to-fix loops, good-workflow filters, and final-answer quality checks.
- Session-level detail with timeline, conversation, tools, token events, and metadata fields.

## Implementation

The project uses only built-in Node.js modules. There are no runtime package dependencies.

- `server/server.js` scans and parses JSONL logs.
- `public/index.html` serves the dashboard shell.
- `public/app.js` renders the browser UI.
- `public/styles.css` contains the dashboard styling.
- `docs/requirements.md` defines product requirements.
- `docs/design.md` documents the architecture and data model.
- `docs/workflow-analysis.md` documents workflow patterns found in the logs and the implemented analysis areas.

## Privacy

The dashboard reads local Codex logs and serves them only on `127.0.0.1`. Session logs can contain prompts, local paths, command output, repository URLs, source snippets, and secrets if they were ever printed in a terminal output. Tool output and message previews are truncated in the UI, but the server still reads the source logs to build views.
