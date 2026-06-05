# Requirements

## Goal

Create a local dashboard that turns Codex JSONL session logs into a browser-based analysis tool. The dashboard should make the logs understandable by chat thread and session, not expose them as raw JSON dumps.

## Source Data

Default source folder:

```text
C:\Users\<user>\.codex\sessions
```

The scanner expects date-organized `.jsonl` files where each line is one JSON object with a top-level `timestamp`, `type`, and `payload`.

## Functional Requirements

1. Scan all session logs recursively from the configured sessions folder.
2. Build an overview index with session metadata, message counts, tools, token usage, patches, failures, repositories, workspaces, and timestamps.
3. Infer related chat threads using explicit thread metadata when available, otherwise grouping by working directory, then repository, then single session.
4. Provide filters for:
   - free text
   - inferred chat thread
   - workspace
   - repository
   - model
   - tool
   - date range
   - failures only
5. Provide top-level use-case views:
   - workflow analysis
   - transcript archive
   - command/tool audit
   - project/workspace activity
   - repository activity
   - changed files from patch records
   - patch history
   - token usage
   - error/failure summary
   - searchable session archive
6. Provide session drill-down with:
   - timeline
   - conversation
   - tool calls and outputs
   - token events
   - session metadata and payload type counts
7. Provide workflow-level analysis for:
   - per-turn lifecycle timing
   - operation categories
   - prompt-to-action classification
   - patch verification quality
   - command exit codes and durations
   - failure taxonomy
   - context compaction pressure
   - workflow quality score
   - workflow risk flags
   - normalized step timeline
   - artifact write tracking
   - failure-to-fix loop status
   - good-workflow shape filtering
   - final answer quality signals
8. Truncate large text fields in the UI so command output and long messages remain readable.
9. Serve the dashboard locally in a browser over loopback only.

## Nonfunctional Requirements

- No third-party runtime dependencies for the first version.
- Must work on Windows paths with spaces.
- Must avoid modifying Codex session logs.
- Must keep the UI responsive with large session files.
- Must expose refresh indexing from the browser.
- Must support a custom sessions directory through `CODEX_SESSIONS_DIR`.
- Must support a custom port through `PORT`.

## Current Boundaries

- The index is in memory only. Refreshing rebuilds it.
- The dashboard does not write a cache file.
- Global search scans logs on demand and returns capped results.
- File/path frequency is based on structured patch records, not every possible path printed by command output.
- Thread grouping is inferred because many session logs do not contain a durable cross-file thread id.

## Future Enhancements

- Persistent SQLite index for faster startup.
- Full-text search with tokenized indexes.
- Export filtered results to CSV or JSON.
- Redaction rules for secrets and access tokens.
- Stronger call-to-turn correlation if future logs expose more explicit turn spans.
- Diff viewer for patch records.
- Charts for token usage over time and failure rates.
