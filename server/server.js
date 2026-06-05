import http from 'node:http';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3377);
const SESSIONS_ROOT = path.resolve(
  process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions')
);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MAX_PREVIEW = 4000;
const MAX_SEARCH_RESULTS = 200;

let overviewCache = null;
let overviewPromise = null;
let workflowCache = null;
let workflowPromise = null;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

function sendError(res, status, message, detail) {
  sendJson(res, status, { error: message, detail });
}

function compactText(value, max = MAX_PREVIEW) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const clean = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n...[truncated ${clean.length - max} chars]`;
}

function oneLine(value, max = 180) {
  return compactText(value, max).replace(/\s+/g, ' ').trim();
}

function basenameOfMaybePath(value) {
  if (!value) return '';
  return String(value).split(/[\\/]/).filter(Boolean).pop() || String(value);
}

function addCount(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function mapToRows(map, limit = 500) {
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function collectNumericFields(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'number' && Number.isFinite(item)) {
      out[name] = (out[name] || 0) + item;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      collectNumericFields(item, name, out);
    }
  }
  return out;
}

function mergeNumeric(target, source) {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = (target[key] || 0) + value;
    }
  }
  return target;
}

function tokenTotal(usage = {}) {
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input = usage.input_tokens || usage.prompt_tokens || 0;
  const output = usage.output_tokens || usage.completion_tokens || 0;
  return input + output;
}

function extractMessageText(payload) {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message;
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  if (typeof payload.content === 'string') return payload.content;
  if (payload.output) return payload.output;
  return '';
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function summarizeToolCall(payload) {
  const name = payload?.name || 'tool';
  const args = safeJsonParse(payload?.arguments ?? payload?.input);
  if (name === 'shell_command') {
    return {
      label: args.command || 'shell_command',
      workdir: args.workdir || '',
      args,
    };
  }
  if (name === 'update_plan') {
    return {
      label: Array.isArray(args.plan) ? `${args.plan.length} plan items` : 'plan update',
      workdir: '',
      args,
    };
  }
  if (name === 'apply_patch') {
    return {
      label: 'apply_patch',
      workdir: '',
      args: { patch: compactText(payload?.input, 1500) },
    };
  }
  return { label: name, workdir: args.workdir || '', args };
}

function looksLikeFailure(text) {
  if (!text) return false;
  return /exit code:\s*[1-9]|exception|traceback|error:|failed|parsererror/i.test(text);
}

function extractPatchFiles(changes) {
  const files = [];
  if (!changes) return files;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (typeof change === 'string') files.push(change);
      if (change && typeof change === 'object') {
        for (const key of ['path', 'file', 'filename', 'old_path', 'new_path']) {
          if (change[key]) files.push(String(change[key]));
        }
      }
    }
  } else if (typeof changes === 'object') {
    for (const [key, value] of Object.entries(changes)) {
      if (key && key !== 'undefined') files.push(key);
      if (value && typeof value === 'object') {
        for (const field of ['path', 'file', 'filename']) {
          if (value[field]) files.push(String(value[field]));
        }
      }
    }
  } else if (typeof changes === 'string') {
    files.push(changes);
  }
  return [...new Set(files.filter(Boolean))];
}

function millisBetween(start, end) {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function durationObjectToMs(value) {
  if (!value || typeof value !== 'object') return 0;
  const seconds = Number(value.secs || value.seconds || 0);
  const nanos = Number(value.nanos || value.nanoseconds || 0);
  const millis = Number(value.millis || value.ms || 0);
  return Math.round(seconds * 1000 + nanos / 1_000_000 + millis);
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function commandTextFromExecPayload(payload = {}) {
  const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command || '';
  const parsed = Array.isArray(payload.parsed_cmd)
    ? payload.parsed_cmd.map((item) => item?.cmd || '').filter(Boolean).join(' ')
    : '';
  return oneLine(parsed || command, 500);
}

function classifyCommand(command) {
  const text = String(command || '').toLowerCase();
  if (/\b(rg|grep|findstr)\b|select-string/.test(text)) return 'search';
  if (/get-content|\bcat\b|\btype\b|\bsed\b|\bnl\b/.test(text)) return 'read_file';
  if (/get-childitem|\bls\b|\bdir\b|rg --files/.test(text)) return 'list_files';
  if (/\bgit\b/.test(text)) return 'git';
  if (/npm test|pnpm test|yarn test|pytest|phpunit|cargo test|go test|dotnet test|playwright|vitest|jest|mocha/.test(text)) {
    return 'test';
  }
  if (/npm run|pnpm|yarn|composer|cargo build|dotnet build|tsc|eslint|ruff|mypy|\bbuild\b|\blint\b|compileall/.test(text)) {
    return 'build_lint';
  }
  if (/start-process|npm start|node .*server|uvicorn|flask|vite|next dev|serve|localhost|listen|get-process/.test(text)) {
    return 'server_process';
  }
  if (/new-item|copy-item|move-item|remove-item|mkdir|touch|rename-item|set-content|out-file/.test(text)) {
    return 'file_ops';
  }
  if (/python |node -e|powershell|pwsh|@\s*'|@"|sqlite3/.test(text)) return 'scripted_analysis';
  return 'other';
}

function operationLabel(category) {
  return {
    search: 'Search',
    read_file: 'Read File',
    list_files: 'List Files',
    git: 'Git',
    test: 'Test',
    build_lint: 'Build/Lint',
    server_process: 'Server/Process',
    file_ops: 'File Ops',
    scripted_analysis: 'Scripted Analysis',
    edit_patch: 'Patch/Edit',
    plan_update: 'Plan Update',
    other: 'Other',
  }[category] || category;
}

function classifyFailureSignal({ category = '', output = '', exitCode = null, patchFailed = false, aborted = false } = {}) {
  const text = String(output || '').toLowerCase();
  const hasNonZeroExit = exitCode !== null && exitCode !== undefined && exitCode !== 0;
  const hasFailureText = looksLikeFailure(output);
  if (aborted) return 'interruption';
  if (patchFailed) return 'patch_apply_failure';
  if (exitCode === 0) return '';
  if (!hasNonZeroExit && !hasFailureText) return '';
  if (category === 'search') return 'search_no_match_or_error';
  if (category === 'test') return 'test_failure';
  if (category === 'build_lint') return 'build_lint_failure';
  if (category === 'server_process') return 'server_process_failure';
  if (/permission|access denied|unauthorized|forbidden/.test(text)) return 'permission_or_access';
  if (/timed out|timeout|etimedout/.test(text)) return 'timeout';
  if (/econnrefused|failed to connect|network|http error|status=5\d\d/.test(text)) return 'network_or_server';
  if (/parsererror|cannot bind|parameter cannot be found|missing \)|unexpected token|syntaxerror/.test(text)) return 'shell_or_syntax';
  if (/traceback|exception|typeerror|referenceerror|valueerror|runtimeerror/.test(text)) return 'runtime_exception';
  if (hasNonZeroExit) return 'command_failure';
  if (hasFailureText) return 'failure_signal';
  return '';
}

function isInspectionCategory(category) {
  return ['search', 'read_file', 'list_files', 'git'].includes(category);
}

function isVerificationCategory(category) {
  return ['test', 'build_lint'].includes(category);
}

function extractCommandPaths(command) {
  const text = String(command || '');
  const paths = new Set();
  for (const match of text.matchAll(/["']([^"']*[A-Za-z]:\\[^"']+)["']/g)) {
    paths.add(match[1]);
  }
  for (const match of text.matchAll(/[A-Za-z]:\\[^\s"'`|<>]+/g)) {
    paths.add(match[0]);
  }
  for (const match of text.matchAll(/(?:New-Item|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item|Rename-Item)\s+(?:-[A-Za-z]+\s+)*["']?([^"'`\r\n|<>]+)["']?/gi)) {
    if (match[1]) paths.add(match[1].trim());
  }
  return [...paths].filter(Boolean).slice(0, 12);
}

function isOutsideWorkspace(filePath, cwd) {
  if (!filePath || !cwd || !/^[A-Za-z]:\\/.test(filePath)) return false;
  const normalizedPath = path.resolve(filePath).toLowerCase();
  const normalizedCwd = path.resolve(cwd).toLowerCase();
  return normalizedPath !== normalizedCwd && !normalizedPath.startsWith(`${normalizedCwd}${path.sep}`);
}

function detectShellArtifactWrite(command, workdir) {
  const text = String(command || '');
  const writes =
    /\b(New-Item|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item|Rename-Item)\b|(^|[^>])>\s*[^&]|\btee\b/i.test(text);
  if (!writes) return null;
  const paths = extractCommandPaths(text);
  const outsideWorkspace = paths.some((item) => isOutsideWorkspace(item, workdir));
  return {
    mechanism: 'shell_command',
    path: paths[0] || '(path inferred from command)',
    paths,
    command: oneLine(text, 500),
    outsideWorkspace,
  };
}

function finalAnswerQuality(finalPreview, turn) {
  const text = String(finalPreview || '');
  const hasFinalMessage = Boolean(text.trim());
  const mentionsChangedFiles = /changed|updated|created|added|modified|wrote|file|files|artifact|document/i.test(text);
  const mentionsVerification = /test|tested|verified|verification|validated|checked|build|lint|pytest|npm|pass|ran/i.test(text);
  const mentionsRisks = /risk|not run|unable|failed|skipped|remaining|could(?: not|n't)|blocked|gap|warning/i.test(text);
  const expectedVerification = Boolean(turn.patchCalls || turn.patchResults || turn.failures || turn.patchFailures);
  const missingVerificationEvidence = expectedVerification && !mentionsVerification && !turn.verificationAfterPatch;
  return {
    hasFinalMessage,
    mentionsChangedFiles,
    mentionsVerification,
    mentionsRisks,
    expectedVerification,
    missingVerificationEvidence,
  };
}

function buildIssueLoop(turn) {
  const sequence = turn.operationSequence || [];
  const firstFailureIndex = sequence.findIndex((item) => item.type === 'failure');
  const lastFailureIndex = (() => {
    for (let index = sequence.length - 1; index >= 0; index -= 1) {
      if (sequence[index].type === 'failure') return index;
    }
    return -1;
  })();
  const afterFirstFailure = firstFailureIndex >= 0 ? sequence.slice(firstFailureIndex + 1) : [];
  const afterLastFailure = lastFailureIndex >= 0 ? sequence.slice(lastFailureIndex + 1) : [];
  const inspectAfterFailure = afterFirstFailure.some((item) => item.type === 'operation' && isInspectionCategory(item.category));
  const patchAfterFailure = afterFirstFailure.some((item) => item.type === 'operation' && item.category === 'edit_patch');
  const verifyAfterFailure = afterFirstFailure.some((item) => item.type === 'operation' && isVerificationCategory(item.category));
  const verificationAfterLastFailure = afterLastFailure.some((item) => item.type === 'operation' && isVerificationCategory(item.category));
  let status = 'none';
  if (firstFailureIndex >= 0) {
    status = 'unresolved_signal';
    if (inspectAfterFailure) status = 'inspected_after_failure';
    if (patchAfterFailure) status = 'patched_after_failure';
    if (verifyAfterFailure) status = verificationAfterLastFailure ? 'verified_after_failure' : 'verification_attempted_after_failure';
  }
  return {
    hadFailure: firstFailureIndex >= 0,
    inspectAfterFailure,
    patchAfterFailure,
    verifyAfterFailure,
    verificationAfterLastFailure,
    status,
  };
}

function buildWorkflowSteps(turn, issueLoop) {
  const categories = new Set(Object.keys(turn.operationCounts || {}));
  const hasInspection = [...categories].some(isInspectionCategory);
  const hasVerification = [...categories].some(isVerificationCategory) || turn.verificationAfterPatch;
  const steps = [
    { key: 'prompt', label: 'Prompt', status: turn.hasUser ? 'complete' : 'missing', timestamp: turn.userAt, input: 'user instruction', output: 'scoped goal' },
    { key: 'context', label: 'Context Setup', status: turn.setupEvents ? 'complete' : 'missing', timestamp: turn.startedAt, input: 'workspace and prior context', output: 'turn context' },
    { key: 'reasoning', label: 'Reasoning', status: turn.reasoningEvents ? 'complete' : 'missing', timestamp: turn.firstReasoningAt, input: 'prompt plus context', output: 'working approach' },
    { key: 'investigation', label: 'Investigation', status: hasInspection ? 'complete' : 'missing', timestamp: turn.operationSequence.find((item) => item.type === 'operation' && isInspectionCategory(item.category))?.timestamp || '', input: 'repo files and commands', output: 'evidence' },
    { key: 'edit', label: 'Artifact Edit', status: turn.patchCalls || turn.artifactWrites.length ? 'complete' : 'not_applicable', timestamp: turn.firstPatchAt, input: 'target files', output: 'changed artifacts' },
    { key: 'quality', label: 'Quality Check', status: hasVerification ? 'complete' : turn.patchCalls ? 'missing' : 'not_applicable', timestamp: turn.operationSequence.find((item) => item.type === 'operation' && isVerificationCategory(item.category))?.timestamp || '', input: 'changed artifacts', output: 'test/build/lint result' },
    { key: 'fix_loop', label: 'Issue Fix Loop', status: issueLoop.hadFailure ? issueLoop.status : 'not_applicable', timestamp: '', input: 'failure signals', output: 'corrective action' },
    { key: 'final', label: 'Final Inspection', status: turn.gitAfterPatch || (!turn.patchCalls && turn.finalPreview) ? 'complete' : turn.patchCalls ? 'missing' : 'not_applicable', timestamp: '', input: 'diff/status and verification', output: 'final summary' },
    { key: 'completion', label: 'Completion', status: turn.aborted ? 'aborted' : turn.completed ? 'complete' : 'missing', timestamp: turn.completedAt, input: 'final state', output: turn.aborted ? 'turn aborted' : 'task complete' },
  ];
  return steps;
}

function buildRiskFlags(turn, finalQuality, issueLoop) {
  const flags = [];
  if ((turn.patchCalls || turn.patchResults) && !turn.readOrSearchBeforePatch) {
    flags.push({ key: 'patch_without_prior_read_search', label: 'Patch without prior read/search', severity: 'high' });
  }
  if ((turn.patchCalls || turn.patchResults) && !turn.verificationAfterPatch) {
    flags.push({ key: 'patch_without_verification', label: 'Patch without verification', severity: 'high' });
  }
  if ((turn.failureRows || []).some((row) => row.count >= 3)) {
    flags.push({ key: 'repeated_failure_category', label: 'Repeated failure category', severity: 'medium' });
  }
  if (turn.patchCalls >= 5) {
    flags.push({ key: 'many_patch_attempts', label: 'Many patch attempts', severity: 'medium' });
  }
  if (turn.compactions >= 3) {
    flags.push({ key: 'many_compactions', label: 'Many compactions', severity: 'medium' });
  }
  if ((turn.artifactWrites || []).some((item) => item.outsideWorkspace)) {
    flags.push({ key: 'shell_write_outside_workspace', label: 'Shell write outside workspace', severity: 'high' });
  }
  if (finalQuality.missingVerificationEvidence) {
    flags.push({ key: 'final_answer_without_verification_evidence', label: 'Final answer lacks verification evidence', severity: 'medium' });
  }
  if (issueLoop.hadFailure && !issueLoop.inspectAfterFailure && !issueLoop.patchAfterFailure && !issueLoop.verifyAfterFailure) {
    flags.push({ key: 'failure_without_followup', label: 'Failure without follow-up action', severity: 'high' });
  }
  if (turn.aborted) {
    flags.push({ key: 'turn_aborted', label: 'Turn aborted or interrupted', severity: 'medium' });
  }
  return flags;
}

function qualityScoreForTurn(turn, finalQuality, riskFlags) {
  let score = 0;
  if (turn.hasUser) score += 10;
  if (!turn.patchCalls || turn.readOrSearchBeforePatch) score += 20;
  if (!turn.patchCalls || (turn.patchResults && !turn.patchFailures)) score += 20;
  if (!turn.patchCalls || turn.verificationAfterPatch) score += 20;
  if (!turn.patchCalls || turn.gitAfterPatch) score += 10;
  if (finalQuality.hasFinalMessage) score += 10;
  if (!turn.failures && !turn.patchFailures) score += 10;
  else if (turn.verificationAfterPatch) score += 5;

  for (const flag of riskFlags) {
    if (flag.severity === 'high') score -= 15;
    if (flag.severity === 'medium') score -= 7;
  }
  return Math.max(0, Math.min(100, score));
}

function workflowShapeForTurn(turn, issueLoop, riskFlags) {
  if (turn.aborted) return 'aborted';
  if (!turn.toolCalls) return 'answer_only';
  if ((turn.patchCalls || turn.patchResults) && !turn.verificationAfterPatch) return 'edit_without_verification';
  if ((turn.patchCalls || turn.patchResults) && turn.readOrSearchBeforePatch && turn.verificationAfterPatch && !riskFlags.some((flag) => flag.severity === 'high')) {
    return 'complete_workflow';
  }
  if (issueLoop.hadFailure && (issueLoop.patchAfterFailure || issueLoop.verifyAfterFailure || turn.failures >= 3)) {
    return 'repeated_debug_loop';
  }
  if (turn.actionClass === 'investigation') return 'investigation_only';
  return turn.actionClass || 'other';
}

async function listJsonlFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function readJsonl(filePath, visitor) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      const result = await visitor(JSON.parse(line), lineNo, line);
      if (result === false) {
        rl.close();
        stream.destroy();
        break;
      }
    } catch (error) {
      await visitor({ type: 'parse_error', payload: { error: error.message } }, lineNo, line);
    }
  }
}

function createSessionSummary(filePath, stat) {
  const fileName = path.basename(filePath);
  const fileId = fileName.replace(/\.jsonl$/i, '');
  return {
    id: fileId,
    fileName,
    filePath,
    relativePath: path.relative(SESSIONS_ROOT, filePath),
    bytes: stat.size,
    lastWriteTime: stat.mtime.toISOString(),
    firstTimestamp: '',
    lastTimestamp: '',
    sessionTimestamp: '',
    title: fileId,
    cwd: '',
    cwdName: '',
    originator: '',
    cliVersion: '',
    source: '',
    modelProvider: '',
    threadSource: '',
    repositoryUrl: '',
    repositoryName: '',
    branch: '',
    commitHash: '',
    model: '',
    effort: '',
    currentDate: '',
    timezone: '',
    approvalPolicy: '',
    sandboxPolicy: '',
    permissionProfile: '',
    counts: {
      records: 0,
      parseErrors: 0,
      turns: 0,
      tasksStarted: 0,
      tasksCompleted: 0,
      turnsAborted: 0,
      userMessages: 0,
      assistantMessages: 0,
      developerMessages: 0,
      toolCalls: 0,
      toolOutputs: 0,
      shellCommands: 0,
      planUpdates: 0,
      patchCalls: 0,
      patchResults: 0,
      patchSuccess: 0,
      patchFailure: 0,
      tokenEvents: 0,
      reasoningEvents: 0,
      compactions: 0,
      failures: 0,
    },
    durationsMs: [],
    timeToFirstTokenMs: [],
    tools: {},
    commandNames: {},
    workdirs: {},
    recordTypes: {},
    payloadTypes: {},
    roles: {},
    touchedFiles: {},
    tokenTotals: {},
    tokenLastSum: {},
    rateLimitNames: {},
    firstUserMessage: '',
    lastUserMessage: '',
    lastAgentMessage: '',
    latestFailure: '',
    threadKey: '',
    threadLabel: '',
    threadReason: '',
  };
}

function applyRecordToSummary(session, record) {
  session.counts.records += 1;
  if (!session.firstTimestamp && record.timestamp) session.firstTimestamp = record.timestamp;
  if (record.timestamp) session.lastTimestamp = record.timestamp;
  addCount(session.recordTypes, record.type || 'unknown');

  const payload = record.payload || {};
  const payloadType = payload.type || record.type || 'unknown';
  addCount(session.payloadTypes, payloadType);

  if (record.type === 'parse_error') {
    session.counts.parseErrors += 1;
    return;
  }

  if (record.type === 'session_meta') {
    session.id = payload.id || session.id;
    session.sessionTimestamp = payload.timestamp || session.sessionTimestamp;
    session.cwd = payload.cwd || session.cwd;
    session.cwdName = basenameOfMaybePath(session.cwd);
    session.originator = payload.originator || session.originator;
    session.cliVersion = payload.cli_version || session.cliVersion;
    session.source = payload.source || session.source;
    session.modelProvider = payload.model_provider || session.modelProvider;
    session.threadSource = payload.thread_source || session.threadSource;
    if (payload.git) {
      session.repositoryUrl = payload.git.repository_url || session.repositoryUrl;
      session.repositoryName = basenameOfMaybePath(
        String(session.repositoryUrl || '').replace(/\.git$/i, '')
      );
      session.branch = payload.git.branch || session.branch;
      session.commitHash = payload.git.commit_hash || session.commitHash;
    }
    if (session.cwd) addCount(session.workdirs, session.cwd);
    return;
  }

  if (record.type === 'turn_context') {
    session.model = payload.model || session.model;
    session.effort = payload.effort || session.effort;
    session.currentDate = payload.current_date || session.currentDate;
    session.timezone = payload.timezone || session.timezone;
    session.approvalPolicy = payload.approval_policy || session.approvalPolicy;
    session.sandboxPolicy = payload.sandbox_policy || session.sandboxPolicy;
    session.permissionProfile = payload.permission_profile || session.permissionProfile;
    if (payload.turn_id) addCount(session.commandNames, `turn:${payload.turn_id}`, 0);
    return;
  }

  if (payloadType === 'task_started') {
    session.counts.tasksStarted += 1;
    if (payload.turn_id) session.counts.turns = Math.max(session.counts.turns, session.counts.tasksStarted);
    return;
  }

  if (payloadType === 'task_complete') {
    session.counts.tasksCompleted += 1;
    if (typeof payload.duration_ms === 'number') session.durationsMs.push(payload.duration_ms);
    if (typeof payload.time_to_first_token_ms === 'number') {
      session.timeToFirstTokenMs.push(payload.time_to_first_token_ms);
    }
    if (payload.last_agent_message) {
      session.lastAgentMessage = compactText(payload.last_agent_message, 600);
    }
    return;
  }

  if (payloadType === 'turn_aborted') {
    session.counts.turnsAborted += 1;
    if (typeof payload.duration_ms === 'number') session.durationsMs.push(payload.duration_ms);
    return;
  }

  if (payloadType === 'user_message') {
    session.counts.userMessages += 1;
    const text = compactText(payload.message, 1200);
    if (!session.firstUserMessage) session.firstUserMessage = text;
    session.lastUserMessage = text;
    return;
  }

  if (payloadType === 'agent_message') {
    session.counts.assistantMessages += 1;
    session.lastAgentMessage = compactText(payload.message, 1200);
    return;
  }

  if (payloadType === 'message') {
    const role = payload.role || 'unknown';
    addCount(session.roles, role);
    if (role === 'developer') session.counts.developerMessages += 1;
    return;
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    session.counts.toolCalls += 1;
    const name = payload.name || 'unknown';
    addCount(session.tools, name);
    if (name === 'shell_command') {
      session.counts.shellCommands += 1;
      const args = safeJsonParse(payload.arguments);
      addCount(session.commandNames, oneLine(args.command || 'shell_command', 120));
      addCount(session.workdirs, args.workdir || session.cwd || '');
    } else if (name === 'update_plan') {
      session.counts.planUpdates += 1;
    } else if (name === 'apply_patch') {
      session.counts.patchCalls += 1;
    }
    return;
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    session.counts.toolOutputs += 1;
    const output = compactText(payload.output, 1200);
    if (looksLikeFailure(output)) {
      session.counts.failures += 1;
      session.latestFailure = output;
    }
    return;
  }

  if (payloadType === 'patch_apply_end') {
    session.counts.patchResults += 1;
    if (payload.success) session.counts.patchSuccess += 1;
    else session.counts.patchFailure += 1;
    for (const file of extractPatchFiles(payload.changes)) {
      addCount(session.touchedFiles, file);
    }
    if (!payload.success) {
      session.counts.failures += 1;
      session.latestFailure = compactText(payload.stderr || payload.stdout || 'Patch failed', 1200);
    }
    return;
  }

  if (payloadType === 'token_count') {
    session.counts.tokenEvents += 1;
    const info = payload.info || {};
    const totalUsage = collectNumericFields(info.total_token_usage || {});
    const lastUsage = collectNumericFields(info.last_token_usage || {});
    if (Object.keys(totalUsage).length) session.tokenTotals = totalUsage;
    mergeNumeric(session.tokenLastSum, lastUsage);
    for (const limit of Array.isArray(payload.rate_limits) ? payload.rate_limits : [payload.rate_limits]) {
      if (limit?.limit_name) addCount(session.rateLimitNames, limit.limit_name);
    }
    return;
  }

  if (payloadType === 'reasoning') {
    session.counts.reasoningEvents += 1;
    return;
  }

  if (payloadType === 'context_compacted' || payloadType === 'compacted') {
    session.counts.compactions += 1;
  }
}

function finalizeSession(session) {
  session.title =
    oneLine(session.firstUserMessage, 90) ||
    `${session.cwdName || session.repositoryName || session.fileName} (${session.firstTimestamp || 'unknown time'})`;

  if (session.threadSource && session.threadSource !== 'user') {
    session.threadKey = `thread:${session.threadSource}`;
    session.threadLabel = session.threadSource;
    session.threadReason = 'explicit thread source';
  } else if (session.cwd) {
    session.threadKey = `cwd:${session.cwd.toLowerCase()}`;
    session.threadLabel = session.cwdName || session.cwd;
    session.threadReason = 'same working directory';
  } else if (session.repositoryUrl) {
    session.threadKey = `repo:${session.repositoryUrl.toLowerCase()}:${session.branch.toLowerCase()}`;
    session.threadLabel = `${session.repositoryName || session.repositoryUrl}${session.branch ? ` (${session.branch})` : ''}`;
    session.threadReason = 'same git repository and branch';
  } else {
    session.threadKey = `session:${session.id}`;
    session.threadLabel = session.title;
    session.threadReason = 'single session';
  }

  session.toolsList = mapToRows(session.tools, 50);
  session.commandList = mapToRows(session.commandNames, 50);
  session.workdirList = mapToRows(session.workdirs, 50);
  session.payloadTypeList = mapToRows(session.payloadTypes, 50);
  session.recordTypeList = mapToRows(session.recordTypes, 50);
  session.touchedFileList = mapToRows(session.touchedFiles, 100);
  session.tokenTotal = tokenTotal(session.tokenTotals);
  session.durationTotalMs = session.durationsMs.reduce((sum, value) => sum + value, 0);
  session.durationAvgMs = session.durationsMs.length
    ? Math.round(session.durationTotalMs / session.durationsMs.length)
    : 0;
  session.timeToFirstTokenAvgMs = session.timeToFirstTokenMs.length
    ? Math.round(session.timeToFirstTokenMs.reduce((sum, value) => sum + value, 0) / session.timeToFirstTokenMs.length)
    : 0;

  delete session.tools;
  delete session.commandNames;
  delete session.workdirs;
  delete session.recordTypes;
  delete session.payloadTypes;
  delete session.roles;
  delete session.touchedFiles;
  delete session.rateLimitNames;
  delete session.durationsMs;
  delete session.timeToFirstTokenMs;
  delete session.tokenLastSum;

  return session;
}

async function summarizeFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const session = createSessionSummary(filePath, stat);
  await readJsonl(filePath, (record) => applyRecordToSummary(session, record));
  return finalizeSession(session);
}

function buildThreads(sessions) {
  const map = new Map();
  for (const session of sessions) {
    if (!map.has(session.threadKey)) {
      map.set(session.threadKey, {
        key: session.threadKey,
        label: session.threadLabel,
        reason: session.threadReason,
        cwd: session.cwd,
        repositoryUrl: session.repositoryUrl,
        repositoryName: session.repositoryName,
        branch: session.branch,
        sessions: [],
        counts: {
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          shellCommands: 0,
          patchCalls: 0,
          failures: 0,
          tokenEvents: 0,
        },
        bytes: 0,
        tokenTotal: 0,
        firstTimestamp: '',
        lastTimestamp: '',
        tools: {},
        touchedFiles: {},
      });
    }
    const thread = map.get(session.threadKey);
    thread.sessions.push(session.id);
    thread.bytes += session.bytes;
    thread.tokenTotal += session.tokenTotal || 0;
    for (const key of Object.keys(thread.counts)) {
      thread.counts[key] += session.counts[key] || 0;
    }
    if (!thread.firstTimestamp || session.firstTimestamp < thread.firstTimestamp) {
      thread.firstTimestamp = session.firstTimestamp;
    }
    if (!thread.lastTimestamp || session.lastTimestamp > thread.lastTimestamp) {
      thread.lastTimestamp = session.lastTimestamp;
    }
    for (const item of session.toolsList || []) addCount(thread.tools, item.name, item.count);
    for (const item of session.touchedFileList || []) addCount(thread.touchedFiles, item.name, item.count);
  }

  return [...map.values()]
    .map((thread) => {
      const toolsList = mapToRows(thread.tools, 30);
      const touchedFileList = mapToRows(thread.touchedFiles, 30);
      delete thread.tools;
      delete thread.touchedFiles;
      return {
        ...thread,
        sessionCount: thread.sessions.length,
        toolsList,
        touchedFileList,
      };
    })
    .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
}

function buildOverviewTotals(sessions, threads) {
  const totals = {
    sessions: sessions.length,
    threads: threads.length,
    bytes: 0,
    records: 0,
    userMessages: 0,
    assistantMessages: 0,
    developerMessages: 0,
    toolCalls: 0,
    toolOutputs: 0,
    shellCommands: 0,
    planUpdates: 0,
    patchCalls: 0,
    patchResults: 0,
    patchSuccess: 0,
    patchFailure: 0,
    tokenEvents: 0,
    tokenTotal: 0,
    failures: 0,
    compactions: 0,
    firstTimestamp: '',
    lastTimestamp: '',
  };
  const facets = {
    cwd: {},
    repository: {},
    branch: {},
    model: {},
    effort: {},
    tool: {},
    payloadType: {},
    touchedFile: {},
    day: {},
    command: {},
  };

  for (const session of sessions) {
    totals.bytes += session.bytes;
    totals.tokenTotal += session.tokenTotal || 0;
    totals.records += session.counts.records || 0;
    for (const key of [
      'userMessages',
      'assistantMessages',
      'developerMessages',
      'toolCalls',
      'toolOutputs',
      'shellCommands',
      'planUpdates',
      'patchCalls',
      'patchResults',
      'patchSuccess',
      'patchFailure',
      'tokenEvents',
      'failures',
      'compactions',
    ]) {
      totals[key] += session.counts[key] || 0;
    }
    if (!totals.firstTimestamp || session.firstTimestamp < totals.firstTimestamp) {
      totals.firstTimestamp = session.firstTimestamp;
    }
    if (!totals.lastTimestamp || session.lastTimestamp > totals.lastTimestamp) {
      totals.lastTimestamp = session.lastTimestamp;
    }
    addCount(facets.cwd, session.cwd || '(none)');
    addCount(facets.repository, session.repositoryName || session.repositoryUrl || '(none)');
    addCount(facets.branch, session.branch || '(none)');
    addCount(facets.model, session.model || '(unknown)');
    addCount(facets.effort, session.effort || '(unknown)');
    const day = (session.firstTimestamp || session.sessionTimestamp || '').slice(0, 10) || '(unknown)';
    addCount(facets.day, day);
    for (const item of session.toolsList || []) addCount(facets.tool, item.name, item.count);
    for (const item of session.payloadTypeList || []) addCount(facets.payloadType, item.name, item.count);
    for (const item of session.touchedFileList || []) addCount(facets.touchedFile, item.name, item.count);
    for (const item of session.commandList || []) addCount(facets.command, item.name, item.count);
  }

  return {
    totals,
    facets: {
      cwd: mapToRows(facets.cwd),
      repository: mapToRows(facets.repository),
      branch: mapToRows(facets.branch),
      model: mapToRows(facets.model),
      effort: mapToRows(facets.effort),
      tool: mapToRows(facets.tool),
      payloadType: mapToRows(facets.payloadType),
      touchedFile: mapToRows(facets.touchedFile),
      day: mapToRows(facets.day),
      command: mapToRows(facets.command, 100),
    },
  };
}

async function buildOverview() {
  const started = Date.now();
  const files = await listJsonlFiles(SESSIONS_ROOT);
  const sessions = [];
  for (const file of files) {
    sessions.push(await summarizeFile(file));
  }
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  const threads = buildThreads(sessions);
  const { totals, facets } = buildOverviewTotals(sessions, threads);
  return {
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    sessionsRoot: SESSIONS_ROOT,
    totals,
    facets,
    threads,
    sessions,
  };
}

async function getOverview(force = false) {
  if (force) {
    overviewCache = null;
    workflowCache = null;
  }
  if (overviewCache) return overviewCache;
  if (!overviewPromise) {
    overviewPromise = buildOverview()
      .then((overview) => {
        overviewCache = overview;
        overviewPromise = null;
        return overview;
      })
      .catch((error) => {
        overviewPromise = null;
        throw error;
      });
  }
  return overviewPromise;
}

function createWorkflowTurn(session, record = null) {
  return {
    sessionId: session.id,
    sessionTitle: session.title,
    threadKey: session.threadKey,
    cwd: session.cwd,
    cwdName: session.cwdName,
    repositoryName: session.repositoryName,
    branch: session.branch,
    turnId: record?.payload?.turn_id || '',
    startedAt: record?.timestamp || '',
    userAt: '',
    completedAt: '',
    firstTokenAt: '',
    firstReasoningAt: '',
    firstAgentAt: '',
    firstToolAt: '',
    firstPatchAt: '',
    userPreview: '',
    finalPreview: '',
    setupEvents: 0,
    events: 0,
    hasUser: false,
    completed: false,
    aborted: false,
    tokenEvents: 0,
    reasoningEvents: 0,
    agentMessages: 0,
    toolCalls: 0,
    shellCommands: 0,
    patchCalls: 0,
    patchResults: 0,
    patchFailures: 0,
    planUpdates: 0,
    compactions: 0,
    failures: 0,
    failureKinds: {},
    operationCounts: {},
    operationSequence: [],
    commands: [],
    artifactWrites: [],
    touchedFiles: {},
    lastPatchIndex: -1,
    testsAfterPatch: 0,
    buildAfterPatch: 0,
    gitAfterPatch: 0,
    verificationAfterPatch: false,
    tokenTotal: 0,
  };
}

function noteTurnTiming(turn, field, timestamp) {
  if (turn.hasUser && timestamp && !turn[field]) turn[field] = timestamp;
}

function addOperation(turn, category, timestamp = '') {
  addCount(turn.operationCounts, category);
  turn.operationSequence.push({ type: 'operation', category, label: operationLabel(category), timestamp });
  if (turn.lastPatchIndex >= 0 && ['test', 'build_lint', 'git'].includes(category)) {
    if (category === 'test') turn.testsAfterPatch += 1;
    if (category === 'build_lint') turn.buildAfterPatch += 1;
    if (category === 'git') turn.gitAfterPatch += 1;
    turn.verificationAfterPatch = true;
  }
}

function noteFailure(turn, kind, timestamp = '') {
  if (!kind) return;
  turn.failures += 1;
  addCount(turn.failureKinds, kind);
  turn.operationSequence.push({ type: 'failure', category: 'failure', failureKind: kind, label: kind, timestamp });
}

function finalizeWorkflowTurn(turn) {
  if (!turn.hasUser) return null;
  const operationRows = mapToRows(turn.operationCounts, 30);
  const failureRows = mapToRows(turn.failureKinds, 20);
  turn.failureRows = failureRows;
  const categories = operationRows.map((item) => item.name);
  let actionClass = 'answer_only';
  if (turn.patchCalls || turn.patchResults) actionClass = 'implementation';
  else if (categories.includes('test') || categories.includes('build_lint') || turn.failures) actionClass = 'verification_debug';
  else if (categories.includes('server_process')) actionClass = 'runtime_server';
  else if (turn.planUpdates && categories.length <= 2) actionClass = 'planning_status';
  else if (categories.some((name) => ['search', 'read_file', 'list_files', 'git'].includes(name))) actionClass = 'investigation';
  if (/handoff|document|docs|readme|markdown/i.test(turn.userPreview) && (turn.patchCalls || actionClass === 'investigation')) {
    actionClass = 'documentation';
  }
  turn.actionClass = actionClass;

  const commandDurations = turn.commands.map((command) => command.durationMs).filter((value) => value > 0);
  const failedCommands = turn.commands.filter((command) => command.failureKind || command.failed).length;
  const readOrSearchBeforePatch =
    turn.lastPatchIndex > 0 &&
    turn.operationSequence
      .slice(0, turn.lastPatchIndex)
      .some((op) => ['read_file', 'search', 'list_files'].includes(op.category));
  turn.readOrSearchBeforePatch = readOrSearchBeforePatch;
  const commandStatsMap = {};
  for (const command of turn.commands) {
    if (!command.category) continue;
    if (!commandStatsMap[command.category]) {
      commandStatsMap[command.category] = { category: command.category, count: 0, ok: 0, fail: 0, durations: [] };
    }
    const row = commandStatsMap[command.category];
    row.count += 1;
    if (command.exitCode === 0) row.ok += 1;
    if (command.failureKind || (command.exitCode !== null && command.exitCode !== undefined && command.exitCode !== 0)) {
      row.fail += 1;
    }
    if (command.durationMs > 0) row.durations.push(command.durationMs);
  }
  const commandStats = Object.values(commandStatsMap).map((row) => ({
    category: row.category,
    label: operationLabel(row.category),
    count: row.count,
    ok: row.ok,
    fail: row.fail,
    avgDurationMs: average(row.durations),
    p90DurationMs: percentile(row.durations, 0.9),
  }));
  const intensityScore =
    turn.toolCalls +
    turn.patchCalls * 3 +
    (turn.testsAfterPatch + turn.buildAfterPatch) * 2 +
    turn.failures +
    turn.compactions * 5;
  const issueLoop = buildIssueLoop(turn);
  const finalQuality = finalAnswerQuality(turn.finalPreview, turn);
  const workflowSteps = buildWorkflowSteps(turn, issueLoop);
  for (const artifact of turn.artifactWrites) {
    artifact.verifiedAfterWrite = Boolean(turn.verificationAfterPatch);
    artifact.finalAnswerMentionsVerification = finalQuality.mentionsVerification;
  }
  const riskFlags = buildRiskFlags(turn, finalQuality, issueLoop);
  const qualityScore = qualityScoreForTurn(turn, finalQuality, riskFlags);
  const workflowShape = workflowShapeForTurn(turn, issueLoop, riskFlags);

  return {
    ...turn,
    durationMs: millisBetween(turn.userAt, turn.completedAt),
    firstTokenMs: millisBetween(turn.userAt, turn.firstTokenAt),
    firstReasoningMs: millisBetween(turn.userAt, turn.firstReasoningAt),
    firstAgentMs: millisBetween(turn.userAt, turn.firstAgentAt),
    firstToolMs: millisBetween(turn.userAt, turn.firstToolAt),
    firstPatchMs: millisBetween(turn.userAt, turn.firstPatchAt),
    operationRows,
    operationStart: turn.operationSequence.slice(0, 12),
    readOrSearchBeforePatch,
    failureRows,
    actionClass,
    workflowShape,
    workflowSteps,
    qualityScore,
    qualityBand: qualityScore >= 85 ? 'strong' : qualityScore >= 65 ? 'watch' : 'risk',
    riskFlags,
    issueLoop,
    finalAnswerQuality: finalQuality,
    commandCount: turn.commands.length,
    failedCommands,
    avgCommandDurationMs: average(commandDurations),
    commandStats,
    intensityScore,
    touchedFileList: mapToRows(turn.touchedFiles, 30),
    artifactWrites: turn.artifactWrites.slice(0, 80),
    operationCounts: undefined,
    failureKinds: undefined,
    touchedFiles: undefined,
    operationSequence: undefined,
    commands: turn.commands,
  };
}

function createWorkflowAccumulator() {
  return {
    turns: [],
    operationCategories: {},
    actionClasses: {},
    workflowShapes: {},
    qualityBands: {},
    riskFlags: {},
    finalAnswerQuality: {
      hasFinalMessage: 0,
      mentionsChangedFiles: 0,
      mentionsVerification: 0,
      mentionsRisks: 0,
      missingVerificationEvidence: 0,
    },
    issueLoopStatus: {},
    failureTaxonomy: {},
    commandStats: {},
    commandExamples: {},
    patchVerification: {
      patchTurns: 0,
      readOrSearchBeforePatch: 0,
      testsAfterPatch: 0,
      buildAfterPatch: 0,
      gitAfterPatch: 0,
      verifiedAfterPatch: 0,
      noVerificationAfterPatch: 0,
      patchFailureTurns: 0,
      planIncluded: 0,
    },
    compactions: [],
    artifactWrites: [],
    slowCommands: [],
    failedCommands: [],
    failureEvents: [],
  };
}

function addCommandStat(acc, command) {
  if (!command.category) return;
  if (!acc.commandStats[command.category]) {
    acc.commandStats[command.category] = {
      category: command.category,
      label: operationLabel(command.category),
      count: 0,
      ok: 0,
      fail: 0,
      durations: [],
    };
  }
  const row = acc.commandStats[command.category];
  row.count += 1;
  if (command.exitCode === 0) row.ok += 1;
  if (command.failureKind || (command.exitCode !== null && command.exitCode !== undefined && command.exitCode !== 0)) {
    row.fail += 1;
  }
  if (command.durationMs > 0) row.durations.push(command.durationMs);
  if (!acc.commandExamples[command.category]) acc.commandExamples[command.category] = command.command;
}

function finalizeWorkflowAccumulator(acc, overview, startedAt) {
  for (const turn of acc.turns) {
    addCount(acc.actionClasses, turn.actionClass);
    addCount(acc.workflowShapes, turn.workflowShape);
    addCount(acc.qualityBands, turn.qualityBand);
    addCount(acc.issueLoopStatus, turn.issueLoop?.status || 'none');
    for (const risk of turn.riskFlags || []) addCount(acc.riskFlags, risk.key);
    if (turn.finalAnswerQuality?.hasFinalMessage) acc.finalAnswerQuality.hasFinalMessage += 1;
    if (turn.finalAnswerQuality?.mentionsChangedFiles) acc.finalAnswerQuality.mentionsChangedFiles += 1;
    if (turn.finalAnswerQuality?.mentionsVerification) acc.finalAnswerQuality.mentionsVerification += 1;
    if (turn.finalAnswerQuality?.mentionsRisks) acc.finalAnswerQuality.mentionsRisks += 1;
    if (turn.finalAnswerQuality?.missingVerificationEvidence) acc.finalAnswerQuality.missingVerificationEvidence += 1;
    for (const op of turn.operationRows || []) addCount(acc.operationCategories, op.name, op.count);
    for (const failure of turn.failureRows || []) addCount(acc.failureTaxonomy, failure.name, failure.count);

    const hadPatch = turn.patchCalls || turn.patchResults;
    if (hadPatch) {
      acc.patchVerification.patchTurns += 1;
      if (turn.readOrSearchBeforePatch) {
        acc.patchVerification.readOrSearchBeforePatch += 1;
      }
      if (turn.testsAfterPatch) acc.patchVerification.testsAfterPatch += 1;
      if (turn.buildAfterPatch) acc.patchVerification.buildAfterPatch += 1;
      if (turn.gitAfterPatch) acc.patchVerification.gitAfterPatch += 1;
      if (turn.verificationAfterPatch) acc.patchVerification.verifiedAfterPatch += 1;
      else acc.patchVerification.noVerificationAfterPatch += 1;
      if (turn.patchFailures) acc.patchVerification.patchFailureTurns += 1;
      if (turn.planUpdates) acc.patchVerification.planIncluded += 1;
    }

    if (turn.compactions) {
      acc.compactions.push({
        sessionId: turn.sessionId,
        sessionTitle: turn.sessionTitle,
        threadKey: turn.threadKey,
        turnId: turn.turnId,
        timestamp: turn.completedAt || turn.userAt,
        count: turn.compactions,
        tokenTotal: turn.tokenTotal,
      });
    }

    for (const artifact of turn.artifactWrites || []) {
      acc.artifactWrites.push({
        sessionId: turn.sessionId,
        sessionTitle: turn.sessionTitle,
        threadKey: turn.threadKey,
        turnId: turn.turnId,
        timestamp: artifact.timestamp || turn.userAt,
        path: artifact.path,
        paths: artifact.paths || [],
        mechanism: artifact.mechanism,
        command: artifact.command || '',
        patchSuccess: artifact.patchSuccess,
        outsideWorkspace: Boolean(artifact.outsideWorkspace),
        verifiedAfterWrite: Boolean(artifact.verifiedAfterWrite),
        risk: artifact.outsideWorkspace ? 'outside_workspace' : artifact.verifiedAfterWrite ? '' : 'unverified_write',
      });
    }

    for (const command of turn.commands || []) {
      addCommandStat(acc, command);
      if (command.durationMs > 0) {
        acc.slowCommands.push({
          sessionId: turn.sessionId,
          sessionTitle: turn.sessionTitle,
          turnId: turn.turnId,
          timestamp: command.endedAt || command.startedAt,
          category: command.category,
          label: operationLabel(command.category),
          command: command.command,
          durationMs: command.durationMs,
          exitCode: command.exitCode,
          failureKind: command.failureKind,
        });
      }
      if (command.failureKind) {
        const row = {
          sessionId: turn.sessionId,
          sessionTitle: turn.sessionTitle,
          turnId: turn.turnId,
          timestamp: command.endedAt || command.startedAt,
          category: command.category,
          label: operationLabel(command.category),
          kind: command.failureKind,
          command: command.command,
          exitCode: command.exitCode,
          snippet: command.outputPreview || '',
        };
        acc.failedCommands.push(row);
        acc.failureEvents.push(row);
      }
    }
  }

  const commandStats = Object.values(acc.commandStats)
    .map((row) => ({
      category: row.category,
      label: row.label,
      count: row.count,
      ok: row.ok,
      fail: row.fail,
      failRate: row.count ? Number(((row.fail / row.count) * 100).toFixed(1)) : 0,
      avgDurationMs: average(row.durations),
      p50DurationMs: percentile(row.durations, 0.5),
      p90DurationMs: percentile(row.durations, 0.9),
      example: acc.commandExamples[row.category] || '',
    }))
    .sort((a, b) => b.count - a.count);

  const durationValues = acc.turns.map((turn) => turn.durationMs).filter((value) => value > 0);
  const firstToolValues = acc.turns.map((turn) => turn.firstToolMs).filter((value) => value > 0);
  const firstPatchValues = acc.turns.map((turn) => turn.firstPatchMs).filter((value) => value > 0);
  const userTurns = acc.turns.length;

  return {
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - startedAt,
    sessionsRoot: overview.sessionsRoot,
    totals: {
      sessions: overview.sessions.length,
      threads: overview.threads.length,
      turns: userTurns,
      toolTurns: acc.turns.filter((turn) => turn.toolCalls > 0).length,
      patchTurns: acc.patchVerification.patchTurns,
      verifiedPatchTurns: acc.patchVerification.verifiedAfterPatch,
      unverifiedPatchTurns: acc.patchVerification.noVerificationAfterPatch,
      failedTurns: acc.turns.filter((turn) => turn.failures > 0 || turn.patchFailures > 0).length,
      compactionTurns: acc.turns.filter((turn) => turn.compactions > 0).length,
      abortedTurns: acc.turns.filter((turn) => turn.aborted).length,
      avgDurationMs: average(durationValues),
      p50DurationMs: percentile(durationValues, 0.5),
      p90DurationMs: percentile(durationValues, 0.9),
      avgFirstToolMs: average(firstToolValues),
      avgFirstPatchMs: average(firstPatchValues),
      avgQualityScore: average(acc.turns.map((turn) => turn.qualityScore).filter((value) => Number.isFinite(value))),
      riskFlagTurns: acc.turns.filter((turn) => (turn.riskFlags || []).length).length,
    },
    operationCategories: mapToRows(acc.operationCategories, 50).map((row) => ({
      ...row,
      label: operationLabel(row.name),
    })),
    actionClasses: mapToRows(acc.actionClasses, 30),
    workflowShapes: mapToRows(acc.workflowShapes, 30),
    qualityBands: mapToRows(acc.qualityBands, 10),
    riskFlags: mapToRows(acc.riskFlags, 50),
    issueLoopStatus: mapToRows(acc.issueLoopStatus, 30),
    finalAnswerQuality: acc.finalAnswerQuality,
    failureTaxonomy: mapToRows(acc.failureTaxonomy, 50),
    commandStats,
    patchVerification: acc.patchVerification,
    compactions: acc.compactions
      .sort((a, b) => b.count - a.count || b.timestamp.localeCompare(a.timestamp))
      .slice(0, 200),
    artifactWrites: acc.artifactWrites
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 500),
    slowCommands: acc.slowCommands
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 120),
    failedCommands: acc.failedCommands
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 120),
    failureEvents: acc.failureEvents
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 200),
    turns: acc.turns
      .sort((a, b) => b.userAt.localeCompare(a.userAt))
      .slice(0, 2500)
      .map((turn) => ({
        ...turn,
        commands: (turn.commands || []).slice(0, 30),
      })),
  };
}

async function buildWorkflow() {
  const startedAt = Date.now();
  const overview = await getOverview();
  const acc = createWorkflowAccumulator();

  for (const session of overview.sessions) {
    let current = null;
    const callIndex = new Map();

    function closeTurn() {
      if (!current) return;
      const finalized = finalizeWorkflowTurn(current);
      if (finalized) acc.turns.push(finalized);
      current = null;
    }

    await readJsonl(session.filePath, (record) => {
      const payload = record.payload || {};
      const payloadType = payload.type || record.type || 'unknown';

      if (payloadType === 'task_started') {
        closeTurn();
        current = createWorkflowTurn(session, record);
      }
      if (!current) current = createWorkflowTurn(session);
      current.events += 1;
      if (!current.hasUser) current.setupEvents += 1;
      if (payload.turn_id && !current.turnId) current.turnId = payload.turn_id;

      if (payloadType === 'user_message') {
        current.hasUser = true;
        current.userAt = current.userAt || record.timestamp || '';
        current.userPreview = current.userPreview || oneLine(payload.message, 260);
        return;
      }

      if (payloadType === 'token_count') {
        current.tokenEvents += 1;
        noteTurnTiming(current, 'firstTokenAt', record.timestamp);
        current.tokenTotal = tokenTotal(collectNumericFields(payload.info?.total_token_usage || {}));
        return;
      }

      if (payloadType === 'reasoning' || payloadType === 'agent_reasoning') {
        current.reasoningEvents += 1;
        noteTurnTiming(current, 'firstReasoningAt', record.timestamp);
        return;
      }

      if (payloadType === 'agent_message') {
        current.agentMessages += 1;
        noteTurnTiming(current, 'firstAgentAt', record.timestamp);
        current.finalPreview = oneLine(payload.message, 260) || current.finalPreview;
        return;
      }

      if (payloadType === 'function_call') {
        current.toolCalls += 1;
        noteTurnTiming(current, 'firstToolAt', record.timestamp);
        const name = payload.name || 'unknown';
        if (name === 'shell_command') {
          current.shellCommands += 1;
          const args = safeJsonParse(payload.arguments);
          const command = oneLine(args.command || 'shell_command', 500);
          const category = classifyCommand(command);
          addOperation(current, category, record.timestamp);
          const commandRow = {
            callId: payload.call_id || '',
            name,
            command,
            category,
            label: operationLabel(category),
            workdir: args.workdir || session.cwd || '',
            startedAt: record.timestamp || '',
            endedAt: '',
            durationMs: 0,
            exitCode: null,
            failed: false,
            failureKind: '',
            outputPreview: '',
          };
          current.commands.push(commandRow);
          if (commandRow.callId) callIndex.set(commandRow.callId, commandRow);
          const artifact = detectShellArtifactWrite(command, commandRow.workdir);
          if (artifact) {
            current.artifactWrites.push({
              ...artifact,
              timestamp: record.timestamp || '',
              category,
              patchSuccess: null,
            });
          }
        } else if (name === 'update_plan') {
          current.planUpdates += 1;
          addOperation(current, 'plan_update', record.timestamp);
        }
        return;
      }

      if (payloadType === 'custom_tool_call') {
        current.toolCalls += 1;
        noteTurnTiming(current, 'firstToolAt', record.timestamp);
        if (payload.name === 'apply_patch') {
          current.patchCalls += 1;
          noteTurnTiming(current, 'firstPatchAt', record.timestamp);
          addOperation(current, 'edit_patch', record.timestamp);
          current.lastPatchIndex = current.operationSequence.length - 1;
          if (payload.call_id) {
            callIndex.set(payload.call_id, {
              callId: payload.call_id,
              name: 'apply_patch',
              command: 'apply_patch',
              category: 'edit_patch',
              label: operationLabel('edit_patch'),
              startedAt: record.timestamp || '',
              endedAt: '',
              durationMs: 0,
              exitCode: null,
              failed: false,
              failureKind: '',
              outputPreview: '',
            });
          }
        }
        return;
      }

      if (payloadType === 'exec_command_end') {
        const callId = payload.call_id || '';
        const command = commandTextFromExecPayload(payload);
        const category = classifyCommand(command);
        let commandRow = callId ? callIndex.get(callId) : null;
        if (!commandRow) {
          commandRow = {
            callId,
            name: 'shell_command',
            command,
            category,
            label: operationLabel(category),
            workdir: payload.cwd || session.cwd || '',
            startedAt: '',
            endedAt: record.timestamp || '',
            durationMs: 0,
            exitCode: null,
            failed: false,
            failureKind: '',
            outputPreview: '',
          };
          current.commands.push(commandRow);
          if (callId) callIndex.set(callId, commandRow);
        }
        commandRow.command = commandRow.command || command;
        commandRow.category = commandRow.category || category;
        commandRow.label = operationLabel(commandRow.category);
        commandRow.workdir = commandRow.workdir || payload.cwd || session.cwd || '';
        commandRow.endedAt = record.timestamp || commandRow.endedAt;
        commandRow.durationMs = durationObjectToMs(payload.duration);
        commandRow.exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : commandRow.exitCode;
        commandRow.outputPreview = oneLine(payload.aggregated_output || payload.formatted_output || payload.stderr || payload.stdout || '', 500);
        commandRow.failureKind = classifyFailureSignal({
          category: commandRow.category,
          output: commandRow.outputPreview,
          exitCode: commandRow.exitCode,
        });
        commandRow.failed = Boolean(commandRow.failureKind);
        noteFailure(current, commandRow.failureKind, record.timestamp);
        return;
      }

      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const output = compactText(payload.output, 1200);
        const commandRow = payload.call_id ? callIndex.get(payload.call_id) : null;
        const kind = classifyFailureSignal({
          category: commandRow?.category || '',
          output,
          exitCode: null,
        });
        if (commandRow) {
          commandRow.outputPreview = oneLine(output, 500);
          commandRow.failureKind = commandRow.failureKind || kind;
          commandRow.failed = Boolean(commandRow.failureKind);
        }
        if (!commandRow?.failureKind || commandRow.failureKind === kind) noteFailure(current, kind, record.timestamp);
        return;
      }

      if (payloadType === 'patch_apply_end') {
        current.patchResults += 1;
        for (const file of extractPatchFiles(payload.changes)) {
          addCount(current.touchedFiles, file);
          current.artifactWrites.push({
            mechanism: 'apply_patch',
            path: file,
            paths: [file],
            command: 'apply_patch',
            timestamp: record.timestamp || '',
            patchSuccess: Boolean(payload.success),
            outsideWorkspace: false,
          });
        }
        if (!payload.success) {
          current.patchFailures += 1;
          noteFailure(current, classifyFailureSignal({
            patchFailed: true,
            output: payload.stderr || payload.stdout || 'Patch failed',
          }), record.timestamp);
        }
        return;
      }

      if (payloadType === 'context_compacted' || payloadType === 'compacted') {
        current.compactions += 1;
        return;
      }

      if (payloadType === 'turn_aborted') {
        current.aborted = true;
        current.completedAt = record.timestamp || '';
        noteFailure(current, classifyFailureSignal({ aborted: true, output: payload.reason || 'interrupted' }), record.timestamp);
        closeTurn();
        return;
      }

      if (payloadType === 'task_complete') {
        current.completed = true;
        current.completedAt = record.timestamp || '';
        if (payload.last_agent_message) current.finalPreview = oneLine(payload.last_agent_message, 260);
        closeTurn();
      }
    });

    closeTurn();
  }

  return finalizeWorkflowAccumulator(acc, overview, startedAt);
}

async function getWorkflow(force = false) {
  if (force) workflowCache = null;
  if (workflowCache) return workflowCache;
  if (!workflowPromise) {
    workflowPromise = buildWorkflow()
      .then((workflow) => {
        workflowCache = workflow;
        workflowPromise = null;
        return workflow;
      })
      .catch((error) => {
        workflowPromise = null;
        throw error;
      });
  }
  return workflowPromise;
}

function timelineTextForRecord(payload, payloadType) {
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const call = summarizeToolCall(payload);
    return compactText(call.args, 2500);
  }
  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    return compactText(payload.output, 3000);
  }
  if (payloadType === 'token_count') {
    return compactText(payload.info || payload, 1500);
  }
  if (payloadType === 'patch_apply_end') {
    return compactText({
      success: payload.success,
      changes: payload.changes,
      stdout: payload.stdout,
      stderr: payload.stderr,
    }, 2500);
  }
  return compactText(extractMessageText(payload) || payload, 2500);
}

async function getSessionDetail(sessionId) {
  const overview = await getOverview();
  const session = overview.sessions.find((item) => item.id === sessionId || item.fileName === sessionId);
  if (!session) return null;

  const timeline = [];
  const conversation = [];
  const tools = [];
  const tokens = [];
  const payloadTypeCounts = {};
  const callIndex = new Map();
  let activeTurnId = '';

  await readJsonl(session.filePath, (record, lineNo) => {
    const payload = record.payload || {};
    const payloadType = payload.type || record.type || 'unknown';
    addCount(payloadTypeCounts, payloadType);
    if (payload.turn_id) activeTurnId = payload.turn_id;
    if (payloadType === 'task_started' && payload.turn_id) activeTurnId = payload.turn_id;

    const baseEvent = {
      lineNo,
      timestamp: record.timestamp || '',
      recordType: record.type || '',
      payloadType,
      turnId: payload.turn_id || activeTurnId,
    };

    if (payloadType === 'user_message' || payloadType === 'agent_message') {
      const role = payloadType === 'user_message' ? 'user' : 'assistant';
      const text = compactText(payload.message, 5000);
      conversation.push({ ...baseEvent, role, text });
      timeline.push({
        ...baseEvent,
        kind: role,
        title: role === 'user' ? 'User message' : 'Assistant message',
        text,
      });
      return;
    }

    if (payloadType === 'message') {
      const role = payload.role || 'unknown';
      const text = compactText(extractMessageText(payload), 5000);
      if (text) conversation.push({ ...baseEvent, role, text });
      if (role === 'developer') {
        timeline.push({ ...baseEvent, kind: 'context', title: 'Developer/context message', text });
      }
      return;
    }

    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const call = summarizeToolCall(payload);
      const item = {
        ...baseEvent,
        kind: 'tool-call',
        callId: payload.call_id || '',
        name: payload.name || 'unknown',
        title: payload.name || 'Tool call',
        label: call.label,
        workdir: call.workdir,
        args: call.args,
        text: compactText(call.args, 3500),
        output: '',
        status: payload.status || '',
        failed: false,
      };
      tools.push(item);
      timeline.push(item);
      if (item.callId) callIndex.set(item.callId, item);
      return;
    }

    if (payloadType === 'exec_command_end') {
      const command = commandTextFromExecPayload(payload);
      const output = compactText(payload.aggregated_output || payload.formatted_output || payload.stderr || payload.stdout || '', 5000);
      const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null;
      const category = classifyCommand(command);
      const failureKind = classifyFailureSignal({ category, output, exitCode });
      const paired = payload.call_id ? callIndex.get(payload.call_id) : null;
      if (paired) {
        paired.output = output;
        paired.failed = Boolean(failureKind);
        paired.durationMs = durationObjectToMs(payload.duration);
        paired.exitCode = exitCode;
        paired.failureKind = failureKind;
      }
      timeline.push({
        ...baseEvent,
        kind: failureKind ? 'exec-command failed' : 'exec-command',
        callId: payload.call_id || '',
        title: failureKind ? 'Command execution failed' : 'Command execution',
        name: operationLabel(category),
        label: command,
        workdir: payload.cwd || '',
        text: compactText({
          exitCode,
          durationMs: durationObjectToMs(payload.duration),
          status: payload.status,
          output,
        }, 5000),
        failed: Boolean(failureKind),
      });
      return;
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const output = compactText(payload.output, 5000);
      const failed = looksLikeFailure(output);
      const paired = payload.call_id ? callIndex.get(payload.call_id) : null;
      if (paired) {
        paired.output = output;
        paired.failed = failed;
      }
      timeline.push({
        ...baseEvent,
        kind: failed ? 'tool-output failed' : 'tool-output',
        callId: payload.call_id || '',
        title: failed ? 'Tool output with failure signal' : 'Tool output',
        text: output,
        failed,
      });
      return;
    }

    if (payloadType === 'token_count') {
      const info = payload.info || {};
      const tokenEvent = {
        ...baseEvent,
        kind: 'tokens',
        title: 'Token count',
        totalUsage: collectNumericFields(info.total_token_usage || {}),
        lastUsage: collectNumericFields(info.last_token_usage || {}),
        contextWindow: info.model_context_window,
        rateLimits: payload.rate_limits || [],
      };
      tokenEvent.total = tokenTotal(tokenEvent.totalUsage);
      tokenEvent.text = compactText({
        totalUsage: tokenEvent.totalUsage,
        lastUsage: tokenEvent.lastUsage,
        contextWindow: tokenEvent.contextWindow,
        rateLimits: tokenEvent.rateLimits,
      }, 2500);
      tokens.push(tokenEvent);
      timeline.push(tokenEvent);
      return;
    }

    if (payloadType === 'agent_reasoning') {
      timeline.push({
        ...baseEvent,
        kind: 'reasoning',
        title: 'Agent reasoning',
        text: compactText(payload.text || payload, 2500),
      });
      return;
    }

    if (
      [
        'task_started',
        'task_complete',
        'turn_aborted',
        'turn_context',
        'context_compacted',
        'compacted',
        'patch_apply_end',
        'thread_name_updated',
      ].includes(payloadType)
    ) {
      timeline.push({
        ...baseEvent,
        kind: payloadType,
        title: payloadType.replace(/_/g, ' '),
        text: timelineTextForRecord(payload, payloadType),
        failed: payloadType === 'patch_apply_end' && !payload.success,
      });
    }
  });

  return {
    session,
    payloadTypeCounts: mapToRows(payloadTypeCounts),
    timeline,
    conversation,
    tools,
    tokens,
  };
}

async function searchSessions(query) {
  const term = String(query.term || '').trim();
  if (term.length < 2) {
    return { term, results: [], scannedFiles: 0, message: 'Use at least 2 characters.' };
  }
  const limit = Math.min(Number(query.limit || 80), MAX_SEARCH_RESULTS);
  const lower = term.toLowerCase();
  const overview = await getOverview();
  const byPath = new Map(overview.sessions.map((session) => [session.filePath, session]));
  const results = [];
  let scannedFiles = 0;

  for (const session of overview.sessions) {
    if (query.session && query.session !== session.id) continue;
    if (query.thread && query.thread !== session.threadKey) continue;
    scannedFiles += 1;
    await readJsonl(session.filePath, (record, lineNo, rawLine) => {
      if (results.length >= limit) return false;
      if (!rawLine.toLowerCase().includes(lower)) return;
      const payload = record.payload || {};
      const payloadType = payload.type || record.type || 'unknown';
      if (query.type && query.type !== payloadType) return;
      const owner = byPath.get(session.filePath);
      results.push({
        sessionId: owner?.id || session.id,
        sessionTitle: owner?.title || session.title,
        threadKey: owner?.threadKey || session.threadKey,
        lineNo,
        timestamp: record.timestamp || '',
        recordType: record.type || '',
        payloadType,
        snippet: oneLine(timelineTextForRecord(payload, payloadType) || rawLine, 500),
      });
    });
    if (results.length >= limit) break;
  }

  return { term, results, scannedFiles, limit };
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendError(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendError(res, 404, 'Not found');
    } else {
      sendError(res, 500, 'Static file error', error.message);
    }
  }
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        sessionsRoot: SESSIONS_ROOT,
        hasCache: Boolean(overviewCache),
        generatedAt: overviewCache?.generatedAt || null,
      });
      return;
    }

    if (url.pathname === '/api/overview') {
      const overview = await getOverview(url.searchParams.get('refresh') === '1');
      sendJson(res, 200, overview);
      return;
    }

    if (url.pathname === '/api/workflow') {
      const workflow = await getWorkflow(url.searchParams.get('refresh') === '1');
      sendJson(res, 200, workflow);
      return;
    }

    if (url.pathname.startsWith('/api/session/')) {
      const sessionId = decodeURIComponent(url.pathname.replace('/api/session/', ''));
      const detail = await getSessionDetail(sessionId);
      if (!detail) {
        sendError(res, 404, 'Session not found');
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (url.pathname === '/api/search') {
      const result = await searchSessions({
        term: url.searchParams.get('q') || '',
        type: url.searchParams.get('type') || '',
        session: url.searchParams.get('session') || '',
        thread: url.searchParams.get('thread') || '',
        limit: url.searchParams.get('limit') || '',
      });
      sendJson(res, 200, result);
      return;
    }

    sendError(res, 404, 'API route not found');
  } catch (error) {
    sendError(res, 500, 'API error', error.stack || error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex Analysis dashboard: http://127.0.0.1:${PORT}`);
  console.log(`Reading sessions from: ${SESSIONS_ROOT}`);
});
