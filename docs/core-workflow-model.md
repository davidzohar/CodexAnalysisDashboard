# Core Workflow Model

This document describes the logical workflow visible in the Codex session logs: what happens after a user submits a prompt, what inputs and outputs exist at each step, how artifacts are written, how quality is checked, and how issues are found and fixed.

## Core Flow

| Step | Inputs | Outputs |
| --- | --- | --- |
| 1. User prompt intake | User instruction, current working directory, repository state, chat history, current date/time, sandbox policy | `task_started`, `turn_context`, `user_message`, scoped goal |
| 2. Context setup | System/developer instructions, prior summaries, workspace metadata, model settings | Model `message` records, `token_count`, active constraints |
| 3. Initial reasoning | User prompt plus context | `reasoning` or `agent_reasoning`, first assistant update, possible plan |
| 4. Investigation | File tree, known paths, search queries, git state | `shell_command` calls for search, list, read, git status/log/diff |
| 5. Working theory | Investigation output, errors, code/docs read | Refined scope, affected files, next action |
| 6. Artifact edit | Target files, intended change, local code/documentation patterns | `apply_patch`, `patch_apply_end`, changed files |
| 7. Quality check | Changed files, project test/build/lint commands | Test/build/lint output, command exit codes, failure taxonomy |
| 8. Issue fix loop | Failed tests, command errors, patch failures, syntax/runtime errors | Additional search/read/edit/test cycles |
| 9. Final inspection | Git diff/status, final test output, changed artifacts | Final summary, verification status, known gaps |
| 10. Completion | Final answer and runtime logs | `task_complete` or `turn_aborted` |

## Artifact Writing

Project artifacts are written mainly through `apply_patch`. That is the clean edit path:

```text
custom_tool_call -> apply_patch -> custom_tool_call_output -> patch_apply_end
```

The patch result records whether the edit was applied successfully and, when structured change metadata is present, which files were affected.

Artifacts can also be written by shell commands when the command itself creates or modifies files. Examples include:

- `New-Item`
- redirects or `Out-File`
- generators
- build tools
- test tools that create reports

Those writes are visible as `shell_command` records and, in older logs, `exec_command_end` records with command, cwd, stdout/stderr, exit code, duration, and status.

The Codex session log itself is written by the runtime as append-only JSONL. The dashboard reads those logs; it does not create the original workflow artifacts.

## Quality Workflow

A good session does not jump directly from prompt to patch. The reliable pattern is:

```text
understand -> inspect -> edit -> verify -> inspect diff -> fix -> verify again -> summarize
```

The important quality gates are:

- Search/read before edit: confirms the target and local patterns.
- Plan update for multi-step work: keeps scope controlled.
- Patch apply result: catches malformed edits.
- Focused tests/build/lint: validates behavior.
- Git status/diff: verifies actual changed files.
- Failure classification: separates real failures from expected probing, such as search no-match.
- Final summary: states changed files, checks run, and remaining risk.

## Main Loops

### Discovery Loop

```text
search/list/read -> interpret output -> search/read more
```

Purpose: avoid guessing by grounding the next action in actual repository state.

### Edit Loop

```text
identify target -> apply_patch -> patch_apply_end -> inspect changed area
```

Purpose: make scoped changes and confirm the patch landed.

### Verification Loop

```text
run test/build/lint -> classify failure -> inspect cause -> patch -> rerun
```

Purpose: turn failures into fixes instead of merely reporting them.

### Git Inspection Loop

```text
git status/diff -> check changed files -> catch accidental or unrelated edits
```

Purpose: protect the worktree and keep the final answer accurate.

### Context Pressure Loop

```text
token_count grows -> compacted/context_compacted -> continue from summary
```

Purpose: preserve continuity in long sessions.

## Issues To Detect

The dashboard should flag these workflow risks:

- Patch without prior read/search.
- Patch without test/build/lint afterward.
- Repeated command failures in the same category.
- Large number of patch attempts in one turn.
- Long sessions with many compactions.
- Final answer without verification evidence.
- Shell commands that write files outside the intended workspace.
- Failure-like output counted as failure when it was only probing.

## Good Workflow Definition

A high-quality workflow is one where every edit is traceable:

```text
prompt
-> reasoned scope
-> evidence from files/commands
-> targeted artifact write
-> verification result
-> issue fix loop if needed
-> final summary with residual risk
```

The dashboard should highlight this cycle so a session can be judged by engineering quality, not only by raw event volume.

## Dashboard Implementation Mapping

The dashboard now maps this workflow model into concrete review surfaces:

- Workflow quality score: evaluates evidence gathering, patch success, verification, git/final inspection, final summary, and unresolved failures.
- Workflow risk flags: highlights patches without investigation, edits without verification, repeated failure categories, many patch attempts, compaction pressure, shell writes outside the workspace, missing final verification evidence, and failures without follow-up.
- Normalized step timeline: renders prompt, context setup, reasoning, investigation, artifact edit, quality check, issue fix loop, final inspection, and completion as per-turn step pills.
- Artifact write tracking: separates `apply_patch` writes from shell-based writes and shows whether a write was verified afterward.
- Verification coverage: shows tests/build/lint/git activity after patch turns.
- Failure-to-fix loop review: shows whether a failure was followed by inspection, patching, and verification.
- Good workflow filter: filters turns by complete workflow, investigation only, edit without verification, repeated debug loop, answer only, or aborted/interrupted.
- Final answer quality check: tracks whether final responses include changed-file, verification, and risk/gap signals.
