# Session Workflow Analysis

This report summarizes what the Codex session logs reveal about the workflow that happens after a user submits an instruction. It is based on the local session archive indexed on May 21, 2026.

## Dataset Snapshot

- Files scanned: 52 JSONL session files
- Inferred chat threads: 28
- Total turns found: 2,265
- Turns with user messages: 2,188
- Completed user turns: 2,180
- Aborted/interrupted user turns: 38
- Tool-assisted user turns: 1,627, or 74.4%
- No-tool user turns: 561, or 25.6%
- Patch/edit turns: 972, or 44.4%
- Turns with compaction records: 593, or 27.1%

## Under-The-Hood Lifecycle

The common sequence after a user submits a prompt is:

1. `task_started`
2. `turn_context`
3. one or more `message` records that represent the model input context
4. `user_message`
5. `token_count`
6. `reasoning` or older `agent_reasoning`
7. `agent_message` plus a mirrored `message`
8. optional tool calls:
   - `function_call` for tools such as `shell_command` and `update_plan`
   - `custom_tool_call` for `apply_patch`
9. tool execution/result records:
   - `function_call_output`
   - `custom_tool_call_output`
   - older/extra structured records such as `exec_command_end`
   - `patch_apply_end`
10. more reasoning/tool loops as needed
11. `task_complete` or `turn_aborted`

The logs are append-only event streams. Some records are runtime events, while others are structured model input/output items. A session viewer should not treat every record as human-facing chat text.

## Common Pre-User Context Pattern

Most turns show context setup before the visible user message:

- `task_started -> turn_context -> message`: 1,776 turns
- `task_started -> message`: 193 turns
- `task_started -> message -> turn_context -> message`: 156 turns

This means a good dashboard should show a "turn setup" area separately from the user-facing transcript.

## Common Post-User Pattern

The first meaningful event after the user message is usually:

- `reasoning`: 1,312 turns
- `agent_message`: 273 turns
- older `agent_reasoning`: 207 turns
- `session_meta`: 354 turns, usually from resumed or older log structure

Common early sequences include:

- `token_count -> reasoning -> agent_message -> message -> function_call...`
- `reasoning -> agent_message -> message -> function_call...`
- `token_count -> agent_message -> message -> token_count`

This supports a drill-down model of:

```text
Prompt -> context/accounting -> reasoning -> visible update -> tools -> outputs -> completion
```

## Timing Patterns

Measured from `user_message`:

| Metric | Average | P50 | P90 |
| --- | ---: | ---: | ---: |
| first token count | 4.2s | 1.3s | 13.2s |
| first reasoning record | 9.9s | 10.0s | 18.1s |
| first agent message | 14.3s | 13.2s | 23.3s |
| first tool call | 12.3s | 14.7s | 24.5s |
| first shell command | 13.5s | 16.0s | 28.2s |
| first patch | 98.3s | 169.9s | 460.5s |
| turn completion | 705.7s | 143.8s | 1,459.8s |

Patch/edit work tends to happen much later than first tool usage because the agent usually searches and reads before editing.

## Operation Categories

Tool operations can be categorized beyond raw tool names:

| Category | Count |
| --- | ---: |
| read file | 43,124 |
| edit patch | 19,528 |
| search | 15,016 |
| git | 12,644 |
| test | 5,065 |
| list files | 3,417 |
| plan update | 1,771 |
| scripted analysis | 1,686 |
| build/lint | 1,574 |
| server/process | 1,133 |
| file operations | 118 |

The dominant workflow is read/search-heavy before edit. Common starts include:

- `search -> read -> read -> read -> read`
- `read -> read -> read -> read -> read`
- `git -> read -> read -> read -> read`
- `plan -> read/search -> read...`

## Patch/Edit Pattern

Among 972 patch turns:

- 943 had read/search/list activity before patching
- 555 ran tests or build/lint after patching
- 816 ran git commands after patching
- 415 included explicit plan updates
- 859 had at least one failure-like signal

Failure-like signals need careful interpretation. Many are expected nonzero exits such as search misses, test failures during iteration, or command probing. The dashboard should distinguish:

- expected probe/no-match exits
- failed tests
- syntax/runtime exceptions
- patch failures
- server/process failures

## Execution Telemetry Types To Add

The first dashboard version captures the major records, but deeper workflow analysis should also promote these:

- `exec_command_end`: structured command telemetry with command, cwd, parsed command, stdout, stderr, exit code, duration, and status.
- `agent_reasoning`: older event-style reasoning text.
- `compacted`: replacement history created during context compaction.
- `context_compacted`: marker that context was compacted.
- `turn_aborted`: interrupted turns.
- `thread_name_updated`: thread labeling events.

`exec_command_end` is especially useful because it can produce real command duration and exit-code reports without parsing formatted shell output.

## Additional Dashboard Areas

### Turn Lifecycle View

Show one lane per user turn:

- setup/context
- user prompt
- reasoning
- visible assistant updates
- tool calls
- tool outputs
- patches
- token usage
- completion/abort

Useful metrics:

- time to first reasoning
- time to first visible assistant message
- time to first tool
- time to first patch
- total turn duration

### Operation Category Timeline

Classify shell commands into:

- search
- read file
- list files
- git
- test
- build/lint
- server/process
- scripted analysis
- file operations
- other

This makes the real workflow digestible: investigate, edit, verify, inspect git state, repeat.

### Tool Pairing And Duration

Pair `function_call` with:

- `function_call_output`
- `exec_command_end`

For each call:

- command/tool name
- cwd
- start time
- end time
- duration
- exit code
- output size
- failure classification

### Verification Quality

For patch turns, show whether verification happened after edits:

- tests after patch
- build/lint after patch
- git diff/status after patch
- no verification found

This can flag risky sessions where edits happened without a follow-up verification command.

### Error Taxonomy

Separate failure signals by root category:

- command not found or shell syntax
- test assertion failure
- build/lint/typecheck failure
- patch apply failure
- search no-match
- network/server failure
- permission/sandbox failure
- timeout/interruption

### Context Pressure And Compaction

Track:

- compaction count per session
- compaction position in the timeline
- token usage before and after compaction
- work lost/reintroduced through replacement history

This explains why long sessions may behave differently from short sessions.

### Prompt-To-Action Classification

Classify each user turn into:

- answer only
- investigation only
- edit implementation
- verification/debug
- planning/status
- handoff/documentation
- server/runtime operation

This makes the archive easier to browse at the workflow level instead of by raw events.

### Patch Impact View

For every patch turn:

- files changed
- number of patch calls
- failed patch attempts
- verification commands after patch
- final git diff/stat if available
- related prompt and final assistant message

### Session Intensity Score

Compute a simple score per session or turn:

```text
tool calls + patch calls * 3 + test commands * 2 + failures + compactions * 5
```

This helps identify unusually complex, risky, or expensive sessions.

## Data Caveats

- Token totals are cumulative in `token_count` records. Do not sum every token event as if it were a delta.
- `cached_input_tokens` dominate long sessions and should be reported separately from output and reasoning tokens.
- Failure regexes overcount unless command category is considered. `rg` returning no matches is often useful probing, not a real failure.
- Some older logs use event names that newer logs do not, such as `agent_reasoning` and `exec_command_end`.
- Thread grouping remains inferred unless a durable cross-session thread id is available.

## Recommended Next Build Step

Add a "Workflow" top-level dashboard view with:

1. per-turn lifecycle table
2. operation category timeline
3. patch verification report
4. command duration and exit-code report from `exec_command_end`
5. failure taxonomy
6. context compaction report

That view would explain how work actually unfolded after each prompt, not just what files and tools appeared in the final session summary.

## Implementation Status

Implemented in the dashboard:

- `GET /api/workflow` for lazy workflow analysis.
- Top-level Workflow tab.
- Per-turn lifecycle table.
- Operation category summary.
- Prompt-to-action classification.
- Patch verification report.
- Command exit-code and duration report from `exec_command_end` where available.
- Failure taxonomy summary.
- Context compaction report.
- Session detail timeline support for `exec_command_end`, `agent_reasoning`, and `thread_name_updated`.
