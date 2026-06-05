const state = {
  overview: null,
  workflow: null,
  workflowLoading: false,
  workflowShape: '',
  workflowRisk: '',
  view: 'overview',
  selectedSessionId: '',
  detail: null,
  detailTab: 'timeline',
  search: {
    term: '',
    type: '',
    results: null,
  },
};

const useCases = [
  ['overview', 'Overview'],
  ['workflow', 'Workflow'],
  ['threads', 'Chat Threads'],
  ['transcripts', 'Transcript Archive'],
  ['commands', 'Command Audit'],
  ['projects', 'Project Activity'],
  ['repositories', 'Repositories'],
  ['files', 'Files Changed'],
  ['patches', 'Patch History'],
  ['tokens', 'Token Usage'],
  ['failures', 'Error Summary'],
  ['search', 'Search'],
];

const els = {
  sourceLine: document.querySelector('#sourceLine'),
  statusPanel: document.querySelector('#statusPanel'),
  metricGrid: document.querySelector('#metricGrid'),
  useCaseNav: document.querySelector('#useCaseNav'),
  facetPanel: document.querySelector('#facetPanel'),
  mainPanel: document.querySelector('#mainPanel'),
  refreshBtn: document.querySelector('#refreshBtn'),
  textFilter: document.querySelector('#textFilter'),
  threadFilter: document.querySelector('#threadFilter'),
  cwdFilter: document.querySelector('#cwdFilter'),
  repoFilter: document.querySelector('#repoFilter'),
  modelFilter: document.querySelector('#modelFilter'),
  toolFilter: document.querySelector('#toolFilter'),
  dateFromFilter: document.querySelector('#dateFromFilter'),
  dateToFilter: document.querySelector('#dateToFilter'),
  failureFilter: document.querySelector('#failureFilter'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function fmt(value) {
  return Number(value || 0).toLocaleString();
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortDate(value) {
  return value ? String(value).slice(0, 10) : '';
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!value) return '';
  if (value < 1000) return `${value} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function safeIncludes(value, term) {
  return String(value || '').toLowerCase().includes(term);
}

function setStatus(message, kind = '') {
  els.statusPanel.innerHTML = message
    ? `<div class="status ${escapeAttr(kind)}">${escapeHtml(message)}</div>`
    : '';
}

async function apiGet(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function loadOverview(force = false) {
  setStatus(force ? 'Refreshing index...' : 'Indexing Codex sessions...');
  els.refreshBtn.disabled = true;
  try {
    state.overview = await apiGet(`/api/overview${force ? '?refresh=1' : ''}`);
    if (force) state.workflow = null;
    populateFilters();
    setStatus('');
    render();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function loadWorkflow(force = false) {
  if (state.workflowLoading) return;
  state.workflowLoading = true;
  setStatus(force ? 'Refreshing workflow analysis...' : 'Analyzing per-turn workflow...');
  try {
    state.workflow = await apiGet(`/api/workflow${force ? '?refresh=1' : ''}`);
    setStatus('');
    render();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    state.workflowLoading = false;
  }
}

function optionHtml(value, label, count = '') {
  const suffix = count === '' ? '' : ` (${fmt(count)})`;
  return `<option value="${escapeAttr(value)}">${escapeHtml(label)}${suffix}</option>`;
}

function populateFilters() {
  const overview = state.overview;
  if (!overview) return;

  const selected = {
    thread: els.threadFilter.value,
    cwd: els.cwdFilter.value,
    repo: els.repoFilter.value,
    model: els.modelFilter.value,
    tool: els.toolFilter.value,
  };

  els.threadFilter.innerHTML =
    optionHtml('', 'All threads') +
    overview.threads
      .map((thread) => optionHtml(thread.key, thread.label, thread.sessionCount))
      .join('');

  els.cwdFilter.innerHTML =
    optionHtml('', 'All workspaces') +
    overview.facets.cwd.map((item) => optionHtml(item.name, item.name, item.count)).join('');

  els.repoFilter.innerHTML =
    optionHtml('', 'All repositories') +
    overview.facets.repository.map((item) => optionHtml(item.name, item.name, item.count)).join('');

  els.modelFilter.innerHTML =
    optionHtml('', 'All models') +
    overview.facets.model.map((item) => optionHtml(item.name, item.name, item.count)).join('');

  els.toolFilter.innerHTML =
    optionHtml('', 'All tools') +
    overview.facets.tool.map((item) => optionHtml(item.name, item.name, item.count)).join('');

  els.threadFilter.value = selected.thread;
  els.cwdFilter.value = selected.cwd;
  els.repoFilter.value = selected.repo;
  els.modelFilter.value = selected.model;
  els.toolFilter.value = selected.tool;
}

function getFilters() {
  return {
    text: els.textFilter.value.trim().toLowerCase(),
    thread: els.threadFilter.value,
    cwd: els.cwdFilter.value,
    repo: els.repoFilter.value,
    model: els.modelFilter.value,
    tool: els.toolFilter.value,
    from: els.dateFromFilter.value,
    to: els.dateToFilter.value,
    failures: els.failureFilter.checked,
  };
}

function sessionSearchText(session) {
  return [
    session.id,
    session.title,
    session.fileName,
    session.filePath,
    session.cwd,
    session.repositoryName,
    session.repositoryUrl,
    session.branch,
    session.model,
    session.firstUserMessage,
    session.lastAgentMessage,
    ...(session.toolsList || []).map((item) => item.name),
    ...(session.commandList || []).map((item) => item.name),
    ...(session.touchedFileList || []).map((item) => item.name),
  ].join(' ');
}

function matchesSession(session, filters) {
  const day = shortDate(session.firstTimestamp || session.sessionTimestamp);
  const repoName = session.repositoryName || session.repositoryUrl || '(none)';
  if (filters.thread && session.threadKey !== filters.thread) return false;
  if (filters.cwd && (session.cwd || '(none)') !== filters.cwd) return false;
  if (filters.repo && repoName !== filters.repo) return false;
  if (filters.model && (session.model || '(unknown)') !== filters.model) return false;
  if (filters.tool && !(session.toolsList || []).some((item) => item.name === filters.tool)) return false;
  if (filters.failures && !session.counts.failures && !session.counts.patchFailure) return false;
  if (filters.from && day && day < filters.from) return false;
  if (filters.to && day && day > filters.to) return false;
  if (filters.text && !safeIncludes(sessionSearchText(session), filters.text)) return false;
  return true;
}

function filteredSessions() {
  if (!state.overview) return [];
  const filters = getFilters();
  return state.overview.sessions.filter((session) => matchesSession(session, filters));
}

function filteredThreads(sessions) {
  const ids = new Set(sessions.map((session) => session.id));
  return state.overview.threads.filter((thread) => thread.sessions.some((id) => ids.has(id)));
}

function aggregateSessions(sessions) {
  const totals = {
    sessions: sessions.length,
    bytes: 0,
    records: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    shellCommands: 0,
    patchCalls: 0,
    patchFailure: 0,
    tokenEvents: 0,
    tokenTotal: 0,
    failures: 0,
    firstTimestamp: '',
    lastTimestamp: '',
  };
  for (const session of sessions) {
    totals.bytes += session.bytes || 0;
    totals.records += session.counts.records || 0;
    totals.userMessages += session.counts.userMessages || 0;
    totals.assistantMessages += session.counts.assistantMessages || 0;
    totals.toolCalls += session.counts.toolCalls || 0;
    totals.shellCommands += session.counts.shellCommands || 0;
    totals.patchCalls += session.counts.patchCalls || 0;
    totals.patchFailure += session.counts.patchFailure || 0;
    totals.tokenEvents += session.counts.tokenEvents || 0;
    totals.tokenTotal += session.tokenTotal || 0;
    totals.failures += session.counts.failures || 0;
    if (!totals.firstTimestamp || session.firstTimestamp < totals.firstTimestamp) {
      totals.firstTimestamp = session.firstTimestamp;
    }
    if (!totals.lastTimestamp || session.lastTimestamp > totals.lastTimestamp) {
      totals.lastTimestamp = session.lastTimestamp;
    }
  }
  return totals;
}

function renderMetrics(sessions, threads) {
  const totals = aggregateSessions(sessions);
  const cards = [
    ['Sessions', fmt(totals.sessions), 'blue'],
    ['Threads', fmt(threads.length), 'green'],
    ['Data', formatBytes(totals.bytes), 'purple'],
    ['Messages', fmt(totals.userMessages + totals.assistantMessages), 'blue'],
    ['Tool Calls', fmt(totals.toolCalls), 'amber'],
    ['Shell Commands', fmt(totals.shellCommands), 'amber'],
    ['Tokens', fmt(totals.tokenTotal), 'green'],
    ['Failures', fmt(totals.failures + totals.patchFailure), 'red'],
  ];
  els.metricGrid.innerHTML = cards
    .map(
      ([label, value, color]) => `
        <div class="metric ${color}">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
        </div>
      `
    )
    .join('');
}

function renderUseCaseNav() {
  els.useCaseNav.innerHTML = useCases
    .map(
      ([id, label]) =>
        `<button type="button" data-view="${escapeAttr(id)}" class="${state.view === id ? 'active' : ''}">${escapeHtml(label)}</button>`
    )
    .join('');
}

function computeFacetRows(sessions, getter, limit = 12) {
  const map = new Map();
  for (const session of sessions) {
    for (const [name, count] of getter(session)) {
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + (count || 1));
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function renderFacetList(title, rows, filterName = '') {
  const max = rows[0]?.count || 1;
  const body = rows.length
    ? `<div class="facet-list">
        ${rows
          .map(
            (row) => `
              <div class="facet-item">
                <span class="facet-name ${filterName ? 'clickable' : ''}" ${filterName ? `data-set-filter="${escapeAttr(filterName)}" data-filter-value="${escapeAttr(row.name)}"` : ''}>${escapeHtml(row.name)}</span>
                <span class="facet-count">${fmt(row.count)}</span>
                <div class="bar"><span style="width:${Math.max(4, Math.round((row.count / max) * 100))}%"></span></div>
              </div>
            `
          )
          .join('')}
      </div>`
    : '<div class="empty">No values</div>';
  return panel(title, '', body);
}

function renderFacets(sessions) {
  els.facetPanel.innerHTML = [
    renderFacetList(
      'Workspaces',
      computeFacetRows(sessions, (session) => [[session.cwd || '(none)', 1]]),
      'cwd'
    ),
    renderFacetList(
      'Tools',
      computeFacetRows(sessions, (session) => (session.toolsList || []).map((item) => [item.name, item.count])),
      'tool'
    ),
    renderFacetList(
      'Repositories',
      computeFacetRows(sessions, (session) => [[session.repositoryName || session.repositoryUrl || '(none)', 1]]),
      'repo'
    ),
    renderFacetList(
      'Files',
      computeFacetRows(sessions, (session) => (session.touchedFileList || []).map((item) => [item.name, item.count])),
      ''
    ),
  ].join('');
}

function panel(title, subtitle, body) {
  return `
    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">${escapeHtml(title)}</h2>
        ${subtitle ? `<div class="panel-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="panel-body">${body}</div>
    </section>
  `;
}

function sessionTitleCell(session) {
  const failure = session.counts.failures || session.counts.patchFailure
    ? '<span class="pill red">failure</span>'
    : '';
  return `
    <div class="clickable" data-session="${escapeAttr(session.id)}">${escapeHtml(session.title || session.id)}</div>
    <div class="muted">${escapeHtml(session.cwdName || session.repositoryName || '')} ${failure}</div>
  `;
}

function renderSessionRows(sessions, limit = 80) {
  const rows = sessions.slice(0, limit);
  if (!rows.length) return '<div class="empty">No sessions match the current filters.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Started</th>
            <th>Workspace</th>
            <th>Tools</th>
            <th>Tokens</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (session) => `
                <tr>
                  <td>${sessionTitleCell(session)}</td>
                  <td class="nowrap">${escapeHtml(formatDate(session.firstTimestamp))}</td>
                  <td><div class="path">${escapeHtml(session.cwd || '')}</div></td>
                  <td>${fmt(session.counts.toolCalls)} <span class="muted">calls</span></td>
                  <td>${fmt(session.tokenTotal)}</td>
                  <td>${fmt((session.counts.failures || 0) + (session.counts.patchFailure || 0))}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
    ${sessions.length > limit ? `<div class="panel-subtitle">Showing ${limit} of ${sessions.length}</div>` : ''}
  `;
}

function renderThreadRows(threads, sessionsById, limit = 80) {
  const rows = threads.slice(0, limit);
  if (!rows.length) return '<div class="empty">No threads match the current filters.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Thread</th>
            <th>Sessions</th>
            <th>Range</th>
            <th>Workspace</th>
            <th>Tools</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((thread) => {
              const firstSession = sessionsById.get(thread.sessions[0]);
              return `
                <tr>
                  <td>
                    <div class="clickable" data-set-filter="thread" data-filter-value="${escapeAttr(thread.key)}">${escapeHtml(thread.label)}</div>
                    <div class="muted">${escapeHtml(thread.reason)}</div>
                  </td>
                  <td>${fmt(thread.sessionCount)}</td>
                  <td>${escapeHtml(shortDate(thread.firstTimestamp))} to ${escapeHtml(shortDate(thread.lastTimestamp))}</td>
                  <td><div class="path">${escapeHtml(thread.cwd || firstSession?.cwd || '')}</div></td>
                  <td>${fmt(thread.counts.toolCalls)} <span class="muted">calls</span></td>
                  <td>${fmt(thread.tokenTotal)}</td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderOverview(sessions, threads) {
  const sessionsById = new Map(state.overview.sessions.map((session) => [session.id, session]));
  const dayRows = computeFacetRows(
    sessions,
    (session) => [[shortDate(session.firstTimestamp) || '(unknown)', 1]],
    30
  );
  const commandRows = computeFacetRows(
    sessions,
    (session) => (session.commandList || []).map((item) => [item.name, item.count]),
    15
  );

  els.mainPanel.innerHTML = [
    panel('Recent Sessions', `${sessions.length} matching`, renderSessionRows(sessions, 15)),
    panel('Chat Threads', `${threads.length} matching`, renderThreadRows(threads, sessionsById, 15)),
    panel('Activity By Day', '', renderSimpleRows(dayRows, 'Day', 'Sessions')),
    panel('Top Commands', '', renderSimpleRows(commandRows, 'Command', 'Count', true)),
  ].join('');
}

function renderSimpleRows(rows, nameLabel, countLabel, codeNames = false) {
  if (!rows.length) return '<div class="empty">No rows</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>${escapeHtml(nameLabel)}</th><th>${escapeHtml(countLabel)}</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td class="${codeNames ? 'path' : ''}">${escapeHtml(row.name)}</td>
                  <td>${fmt(row.count)}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderThreads(sessions, threads) {
  const sessionsById = new Map(state.overview.sessions.map((session) => [session.id, session]));
  const selectedThread = els.threadFilter.value;
  const selectedSessions = selectedThread ? sessions.filter((session) => session.threadKey === selectedThread) : sessions;
  els.mainPanel.innerHTML = [
    panel('Chat Threads', `${threads.length} matching`, renderThreadRows(threads, sessionsById, 120)),
    panel('Sessions In Scope', `${selectedSessions.length} sessions`, renderSessionRows(selectedSessions, 80)),
  ].join('');
}

function renderTranscripts(sessions) {
  const detail = renderDetailPanel();
  els.mainPanel.innerHTML = `
    <div class="split">
      ${panel('Sessions', `${sessions.length} matching`, renderSessionRows(sessions, 80))}
      ${detail}
    </div>
  `;
}

function renderCommands(sessions) {
  const commandRows = computeFacetRows(
    sessions,
    (session) => (session.commandList || []).map((item) => [item.name, item.count]),
    100
  );
  const toolRows = computeFacetRows(
    sessions,
    (session) => (session.toolsList || []).map((item) => [item.name, item.count]),
    40
  );
  const sessionRows = sessions
    .filter((session) => session.counts.toolCalls || session.counts.shellCommands)
    .sort((a, b) => b.counts.toolCalls - a.counts.toolCalls);
  els.mainPanel.innerHTML = [
    panel('Tool Mix', '', renderSimpleRows(toolRows, 'Tool', 'Calls')),
    panel('Shell Commands', '', renderSimpleRows(commandRows, 'Command', 'Count', true)),
    panel('Sessions With Tools', `${sessionRows.length} sessions`, renderSessionRows(sessionRows, 80)),
    renderDetailPanel(),
  ].join('');
}

function renderProjects(sessions) {
  const groups = groupSessions(sessions, (session) => session.cwd || '(none)', (group) => ({
    label: group.key,
    sessions: group.sessions.length,
    toolCalls: sum(group.sessions, (session) => session.counts.toolCalls),
    patches: sum(group.sessions, (session) => session.counts.patchCalls),
    tokens: sum(group.sessions, (session) => session.tokenTotal),
    failures: sum(group.sessions, (session) => session.counts.failures + session.counts.patchFailure),
  }));
  els.mainPanel.innerHTML = panel('Project Activity', `${groups.length} workspaces`, renderGroupTable(groups, 'Workspace'));
}

function renderRepositories(sessions) {
  const groups = groupSessions(
    sessions,
    (session) => `${session.repositoryName || session.repositoryUrl || '(none)'}${session.branch ? ` / ${session.branch}` : ''}`,
    (group) => ({
      label: group.key,
      sessions: group.sessions.length,
      toolCalls: sum(group.sessions, (session) => session.counts.toolCalls),
      patches: sum(group.sessions, (session) => session.counts.patchCalls),
      tokens: sum(group.sessions, (session) => session.tokenTotal),
      failures: sum(group.sessions, (session) => session.counts.failures + session.counts.patchFailure),
    })
  );
  els.mainPanel.innerHTML = panel('Repositories', `${groups.length} repositories or branches`, renderGroupTable(groups, 'Repository / Branch'));
}

function renderFiles(sessions) {
  const rows = computeFacetRows(
    sessions,
    (session) => (session.touchedFileList || []).map((item) => [item.name, item.count]),
    200
  );
  els.mainPanel.innerHTML = panel('Files Changed By Patches', `${rows.length} files`, renderSimpleRows(rows, 'File', 'Changes', true));
}

function renderPatches(sessions) {
  const rows = sessions
    .filter((session) => session.counts.patchCalls || session.counts.patchResults)
    .sort((a, b) => b.counts.patchCalls - a.counts.patchCalls);
  const body = rows.length
    ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Patch Calls</th><th>Results</th><th>Success</th><th>Failure</th><th>Files</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (session) => `
                  <tr>
                    <td>${sessionTitleCell(session)}</td>
                    <td>${fmt(session.counts.patchCalls)}</td>
                    <td>${fmt(session.counts.patchResults)}</td>
                    <td><span class="pill green">${fmt(session.counts.patchSuccess)}</span></td>
                    <td><span class="pill ${session.counts.patchFailure ? 'red' : ''}">${fmt(session.counts.patchFailure)}</span></td>
                    <td>${fmt((session.touchedFileList || []).length)}</td>
                  </tr>
                `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
    : '<div class="empty">No patch activity in scope.</div>';
  els.mainPanel.innerHTML = [panel('Patch History', `${rows.length} sessions`, body), renderDetailPanel()].join('');
}

function renderTokens(sessions) {
  const rows = [...sessions].sort((a, b) => (b.tokenTotal || 0) - (a.tokenTotal || 0));
  const body = rows.length
    ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Token Total</th><th>Events</th><th>Context</th><th>TTFT Avg</th><th>Duration Avg</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (session) => `
                  <tr>
                    <td>${sessionTitleCell(session)}</td>
                    <td>${fmt(session.tokenTotal)}</td>
                    <td>${fmt(session.counts.tokenEvents)}</td>
                    <td>${escapeHtml(session.model || '')}</td>
                    <td>${escapeHtml(formatDuration(session.timeToFirstTokenAvgMs))}</td>
                    <td>${escapeHtml(formatDuration(session.durationAvgMs))}</td>
                  </tr>
                `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
    : '<div class="empty">No token data in scope.</div>';
  els.mainPanel.innerHTML = [panel('Token Usage', `${rows.length} sessions`, body), renderDetailPanel()].join('');
}

function renderFailures(sessions) {
  const rows = sessions
    .filter((session) => session.counts.failures || session.counts.patchFailure)
    .sort((a, b) => (b.counts.failures + b.counts.patchFailure) - (a.counts.failures + a.counts.patchFailure));
  const body = rows.length
    ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Failures</th><th>Latest Signal</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (session) => `
                  <tr>
                    <td>${sessionTitleCell(session)}</td>
                    <td><span class="pill red">${fmt(session.counts.failures + session.counts.patchFailure)}</span></td>
                    <td><pre>${escapeHtml(session.latestFailure || '')}</pre></td>
                  </tr>
                `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
    : '<div class="empty">No failure signals in scope.</div>';
  els.mainPanel.innerHTML = [panel('Error Summary', `${rows.length} sessions`, body), renderDetailPanel()].join('');
}

function workflowTurnSearchText(turn) {
  return [
    turn.sessionTitle,
    turn.sessionId,
    turn.turnId,
    turn.cwd,
    turn.repositoryName,
    turn.userPreview,
    turn.finalPreview,
    turn.actionClass,
    turn.workflowShape,
    turn.qualityBand,
    ...(turn.riskFlags || []).map((item) => `${item.key} ${item.label}`),
    ...(turn.operationRows || []).map((item) => `${item.name} ${item.label}`),
    ...(turn.failureRows || []).map((item) => item.name),
    ...(turn.commands || []).map((item) => item.command),
  ].join(' ');
}

function filteredWorkflowTurns(sessions) {
  if (!state.workflow) return [];
  const ids = new Set(sessions.map((session) => session.id));
  const filters = getFilters();
  return (state.workflow.turns || []).filter((turn) => {
    const day = shortDate(turn.userAt);
    if (!ids.has(turn.sessionId)) return false;
    if (filters.failures && !turn.failures && !turn.patchFailures && !turn.failedCommands) return false;
    if (filters.from && day && day < filters.from) return false;
    if (filters.to && day && day > filters.to) return false;
    if (filters.text && !safeIncludes(workflowTurnSearchText(turn), filters.text)) return false;
    if (state.workflowShape && turn.workflowShape !== state.workflowShape) return false;
    if (state.workflowRisk && !(turn.riskFlags || []).some((risk) => risk.key === state.workflowRisk)) return false;
    return true;
  });
}

function aggregateWorkflowRows(turns, getter, limit = 50) {
  const map = new Map();
  for (const turn of turns) {
    for (const [name, count] of getter(turn)) {
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + (count || 1));
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count, label: name }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function aggregateWorkflowTotals(turns) {
  const patchTurns = turns.filter((turn) => turn.patchCalls || turn.patchResults);
  return {
    turns: turns.length,
    toolTurns: turns.filter((turn) => turn.toolCalls).length,
    patchTurns: patchTurns.length,
    verifiedPatchTurns: patchTurns.filter((turn) => turn.verificationAfterPatch).length,
    noVerificationPatchTurns: patchTurns.filter((turn) => !turn.verificationAfterPatch).length,
    failedTurns: turns.filter((turn) => turn.failures || turn.patchFailures || turn.failedCommands).length,
    compactionTurns: turns.filter((turn) => turn.compactions).length,
    abortedTurns: turns.filter((turn) => turn.aborted).length,
    avgQualityScore: averageClient(turns.map((turn) => turn.qualityScore).filter((value) => value !== undefined && value !== null)),
    riskFlagTurns: turns.filter((turn) => (turn.riskFlags || []).length).length,
    avgDurationMs: averageClient(turns.map((turn) => turn.durationMs).filter(Boolean)),
    avgFirstToolMs: averageClient(turns.map((turn) => turn.firstToolMs).filter(Boolean)),
    avgFirstPatchMs: averageClient(turns.map((turn) => turn.firstPatchMs).filter(Boolean)),
  };
}

function averageClient(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length) : 0;
}

function renderWorkflowMetricGrid(totals) {
  const cards = [
    ['Turns', fmt(totals.turns), 'blue'],
    ['Tool Turns', fmt(totals.toolTurns), 'amber'],
    ['Patch Turns', fmt(totals.patchTurns), 'purple'],
    ['Verified Patches', fmt(totals.verifiedPatchTurns), 'green'],
    ['Unverified Patches', fmt(totals.noVerificationPatchTurns), 'red'],
    ['Failed Turns', fmt(totals.failedTurns), 'red'],
    ['Compactions', fmt(totals.compactionTurns), 'amber'],
    ['Avg Quality', `${fmt(totals.avgQualityScore)}%`, qualityColor(totals.avgQualityScore)],
    ['Risk Turns', fmt(totals.riskFlagTurns), totals.riskFlagTurns ? 'red' : 'green'],
    ['Avg Duration', formatDuration(totals.avgDurationMs), 'blue'],
  ];
  return `
    <div class="workflow-metric-grid">
      ${cards
        .map(
          ([label, value, color]) => `
            <div class="metric ${color}">
              <div class="label">${escapeHtml(label)}</div>
              <div class="value">${escapeHtml(value)}</div>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderWorkflow(sessions) {
  if (!state.workflow) {
    if (!state.workflowLoading) loadWorkflow();
    els.mainPanel.innerHTML = panel('Workflow', '', '<div class="empty">Loading workflow analysis...</div>');
    return;
  }

  const turns = filteredWorkflowTurns(sessions);
  const totals = aggregateWorkflowTotals(turns);
  const operationRows = aggregateWorkflowRows(
    turns,
    (turn) => (turn.operationRows || []).map((item) => [operationLabelClient(item.name), item.count]),
    30
  );
  const actionRows = aggregateWorkflowRows(turns, (turn) => [[actionLabel(turn.actionClass), 1]], 20);
  const shapeRows = aggregateWorkflowRows(turns, (turn) => [[workflowShapeLabel(turn.workflowShape), 1]], 20);
  const qualityRows = aggregateWorkflowRows(turns, (turn) => [[qualityBandLabel(turn.qualityBand), 1]], 10);
  const riskRows = aggregateWorkflowRows(
    turns,
    (turn) => (turn.riskFlags || []).map((item) => [riskFlagLabel(item.key), 1]),
    30
  );
  const failureRows = aggregateWorkflowRows(
    turns,
    (turn) => (turn.failureRows || []).map((item) => [failureLabel(item.name), item.count]),
    30
  );
  const commandRows = aggregateCommandStats(turns);
  const commandSamples = filteredWorkflowCommandSamples(sessions);
  const artifactRows = filteredWorkflowArtifacts(sessions);
  const patchRows = turns
    .filter((turn) => turn.patchCalls || turn.patchResults)
    .sort((a, b) => b.intensityScore - a.intensityScore)
    .slice(0, 80);
  const compactionRows = turns
    .filter((turn) => turn.compactions)
    .sort((a, b) => b.compactions - a.compactions || b.userAt.localeCompare(a.userAt))
    .slice(0, 80);

  els.mainPanel.innerHTML = [
    renderWorkflowControls(),
    panel('Workflow Summary', `${turns.length} turns in scope`, renderWorkflowMetricGrid(totals)),
    `<div class="split">
      ${panel('Workflow Quality', '', renderWorkflowQualityRows(qualityRows, shapeRows))}
      ${panel('Risk Flags', '', renderSimpleRows(riskRows, 'Risk', 'Turns'))}
    </div>`,
    panel('Turn Lifecycle', 'prompt -> reasoning -> tools -> patch -> verification -> completion', renderWorkflowTurnRows(turns, 120)),
    `<div class="split">
      ${panel('Operation Categories', '', renderSimpleRows(operationRows, 'Operation', 'Events'))}
      ${panel('Prompt-To-Action', '', renderSimpleRows(actionRows, 'Class', 'Turns'))}
    </div>`,
    panel('Final Answer Quality', '', renderFinalAnswerQualityRows(turns)),
    panel('Artifact Write Tracking', `${artifactRows.length} writes shown`, renderArtifactRows(artifactRows)),
    panel('Patch Verification', `${patchRows.length} patch turns shown`, renderPatchVerificationRows(patchRows)),
    panel('Failure-To-Fix Loops', '', renderIssueLoopRows(turns)),
    panel('Command Exit And Duration', 'from paired command telemetry where available', renderCommandStats(commandRows)),
    `<div class="split">
      ${panel('Slow Commands', `${commandSamples.slow.length} shown`, renderCommandSampleRows(commandSamples.slow, false))}
      ${panel('Failed Commands', `${commandSamples.failed.length} shown`, renderCommandSampleRows(commandSamples.failed, true))}
    </div>`,
    `<div class="split">
      ${panel('Failure Taxonomy', '', renderSimpleRows(failureRows, 'Failure Type', 'Signals'))}
      ${panel('Context Compaction', `${compactionRows.length} turns shown`, renderCompactionRows(compactionRows))}
    </div>`,
  ].join('');
}

function renderWorkflowControls() {
  const shapeOptions = [
    ['', 'All workflow shapes'],
    ['complete_workflow', 'Complete workflow'],
    ['investigation_only', 'Investigation only'],
    ['edit_without_verification', 'Edit without verification'],
    ['repeated_debug_loop', 'Repeated debug loop'],
    ['answer_only', 'Answer only'],
    ['aborted', 'Aborted/interrupted'],
  ];
  const riskOptions = [
    ['', 'All risk flags'],
    ['patch_without_prior_read_search', 'Patch without prior read/search'],
    ['patch_without_verification', 'Patch without verification'],
    ['repeated_failure_category', 'Repeated failure category'],
    ['many_patch_attempts', 'Many patch attempts'],
    ['many_compactions', 'Many compactions'],
    ['shell_write_outside_workspace', 'Shell write outside workspace'],
    ['final_answer_without_verification_evidence', 'Final answer lacks verification evidence'],
    ['failure_without_followup', 'Failure without follow-up'],
    ['turn_aborted', 'Turn aborted'],
  ];
  const selectOptions = (rows, selected) =>
    rows
      .map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`)
      .join('');
  return panel(
    'Workflow Filters',
    '',
    `
      <div class="workflow-controls">
        <label>
          Workflow Shape
          <select id="workflowShapeFilter">
            ${selectOptions(shapeOptions, state.workflowShape)}
          </select>
        </label>
        <label>
          Risk Flag
          <select id="workflowRiskFilter">
            ${selectOptions(riskOptions, state.workflowRisk)}
          </select>
        </label>
      </div>
    `
  );
}

function filteredWorkflowCommandSamples(sessions) {
  const ids = new Set(sessions.map((session) => session.id));
  const filters = getFilters();
  const keep = (row) => {
    const day = shortDate(row.timestamp);
    if (!ids.has(row.sessionId)) return false;
    if (filters.from && day && day < filters.from) return false;
    if (filters.to && day && day > filters.to) return false;
    if (filters.text && !safeIncludes([row.sessionTitle, row.command, row.kind, row.label, row.snippet].join(' '), filters.text)) return false;
    return true;
  };
  return {
    slow: (state.workflow.slowCommands || []).filter(keep).slice(0, 40),
    failed: (state.workflow.failedCommands || []).filter(keep).slice(0, 40),
  };
}

function filteredWorkflowArtifacts(sessions) {
  if (!state.workflow) return [];
  const ids = new Set(sessions.map((session) => session.id));
  const filters = getFilters();
  return (state.workflow.artifactWrites || [])
    .filter((row) => {
      const day = shortDate(row.timestamp);
      if (!ids.has(row.sessionId)) return false;
      if (filters.from && day && day < filters.from) return false;
      if (filters.to && day && day > filters.to) return false;
      if (state.workflowRisk === 'shell_write_outside_workspace' && !row.outsideWorkspace) return false;
      if (filters.text && !safeIncludes([row.sessionTitle, row.path, row.mechanism, row.command, row.risk].join(' '), filters.text)) return false;
      return true;
    })
    .slice(0, 120);
}

function actionLabel(value) {
  return {
    answer_only: 'Answer Only',
    investigation: 'Investigation',
    implementation: 'Implementation',
    verification_debug: 'Verification/Debug',
    planning_status: 'Planning/Status',
    documentation: 'Documentation',
    runtime_server: 'Runtime/Server',
  }[value] || value || 'Unknown';
}

function operationLabelClient(value) {
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
  }[value] || value || 'Unknown';
}

function workflowShapeLabel(value) {
  return {
    complete_workflow: 'Complete Workflow',
    investigation_only: 'Investigation Only',
    edit_without_verification: 'Edit Without Verification',
    repeated_debug_loop: 'Repeated Debug Loop',
    answer_only: 'Answer Only',
    aborted: 'Aborted/Interrupted',
    implementation: 'Implementation',
    documentation: 'Documentation',
    verification_debug: 'Verification/Debug',
    planning_status: 'Planning/Status',
    runtime_server: 'Runtime/Server',
    other: 'Other',
  }[value] || value || 'Unknown';
}

function qualityBandLabel(value) {
  return {
    strong: 'Strong',
    watch: 'Watch',
    risk: 'Risk',
  }[value] || value || 'Unknown';
}

function qualityColor(score) {
  const value = Number(score || 0);
  if (value >= 85) return 'green';
  if (value >= 65) return 'amber';
  return 'red';
}

function riskFlagLabel(value) {
  return {
    patch_without_prior_read_search: 'Patch Without Prior Read/Search',
    patch_without_verification: 'Patch Without Verification',
    repeated_failure_category: 'Repeated Failure Category',
    many_patch_attempts: 'Many Patch Attempts',
    many_compactions: 'Many Compactions',
    shell_write_outside_workspace: 'Shell Write Outside Workspace',
    final_answer_without_verification_evidence: 'Final Answer Lacks Verification Evidence',
    failure_without_followup: 'Failure Without Follow-Up',
    turn_aborted: 'Turn Aborted',
  }[value] || value || 'Unknown';
}

function failureLabel(value) {
  return {
    search_no_match_or_error: 'Search No-Match/Error',
    test_failure: 'Test Failure',
    build_lint_failure: 'Build/Lint Failure',
    patch_apply_failure: 'Patch Apply Failure',
    server_process_failure: 'Server/Process Failure',
    shell_or_syntax: 'Shell/Syntax',
    runtime_exception: 'Runtime Exception',
    network_or_server: 'Network/Server',
    permission_or_access: 'Permission/Access',
    interruption: 'Interruption',
    timeout: 'Timeout',
    command_failure: 'Command Failure',
    failure_signal: 'Failure Signal',
  }[value] || value || 'Unknown';
}

function renderWorkflowQualityRows(qualityRows, shapeRows) {
  return `
    <div class="split">
      ${renderSimpleRows(qualityRows, 'Quality Band', 'Turns')}
      ${renderSimpleRows(shapeRows, 'Workflow Shape', 'Turns')}
    </div>
  `;
}

function renderQualityPill(turn) {
  return `<span class="pill ${qualityColor(turn.qualityScore)}">${fmt(turn.qualityScore)}%</span>`;
}

function renderRiskPills(turn) {
  if (!turn.riskFlags?.length) return '<span class="pill green">no flags</span>';
  return turn.riskFlags
    .slice(0, 3)
    .map((risk) => `<span class="pill ${risk.severity === 'high' ? 'red' : 'amber'}">${escapeHtml(risk.label || riskFlagLabel(risk.key))}</span>`)
    .join(' ');
}

function renderWorkflowSteps(steps = []) {
  if (!steps.length) return '<span class="muted">none</span>';
  return steps
    .map((step) => {
      const color = step.status === 'complete' ? 'green' : step.status === 'missing' || step.status === 'aborted' ? 'red' : step.status === 'not_applicable' ? '' : 'amber';
      return `<span class="pill ${color}">${escapeHtml(step.label)}</span>`;
    })
    .join(' ');
}

function renderWorkflowTurnRows(turns, limit = 120) {
  const rows = [...turns].sort((a, b) => b.userAt.localeCompare(a.userAt)).slice(0, limit);
  if (!rows.length) return '<div class="empty">No workflow turns match the current filters.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session / Prompt</th>
            <th>Time</th>
            <th>Quality</th>
            <th>Shape</th>
            <th>Timing</th>
            <th>Steps</th>
            <th>Operations</th>
            <th>Patch Verification</th>
            <th>Risks / Failures</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (turn) => `
                <tr>
                  <td>
                    <div class="clickable" data-session="${escapeAttr(turn.sessionId)}">${escapeHtml(turn.sessionTitle || turn.sessionId)}</div>
                    <div class="muted">${escapeHtml(turn.userPreview || '')}</div>
                  </td>
                  <td class="nowrap">${escapeHtml(formatDate(turn.userAt))}</td>
                  <td>
                    ${renderQualityPill(turn)}
                    <div class="muted">${escapeHtml(qualityBandLabel(turn.qualityBand))}</div>
                  </td>
                  <td>
                    <span class="pill">${escapeHtml(workflowShapeLabel(turn.workflowShape))}</span>
                    <div class="muted">${escapeHtml(actionLabel(turn.actionClass))}</div>
                  </td>
                  <td>
                    <div>${escapeHtml(formatDuration(turn.durationMs))}</div>
                    <div class="muted">tool ${escapeHtml(formatDuration(turn.firstToolMs)) || '-'}</div>
                    <div class="muted">patch ${escapeHtml(formatDuration(turn.firstPatchMs)) || '-'}</div>
                  </td>
                  <td>${renderWorkflowSteps(turn.workflowSteps)}</td>
                  <td>${renderOperationPills(turn.operationRows)}</td>
                  <td>${renderVerificationPill(turn)}</td>
                  <td>
                    ${renderRiskPills(turn)}
                    <div>${renderFailurePills(turn)}</div>
                  </td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
    ${turns.length > limit ? `<div class="panel-subtitle">Showing ${limit} of ${turns.length}</div>` : ''}
  `;
}

function renderOperationPills(rows = []) {
  if (!rows.length) return '<span class="muted">none</span>';
  return rows
    .slice(0, 5)
    .map((row) => `<span class="pill amber">${escapeHtml(row.label || operationLabelClient(row.name))} ${fmt(row.count)}</span>`)
    .join(' ');
}

function renderVerificationPill(turn) {
  if (!turn.patchCalls && !turn.patchResults) return '<span class="muted">no patch</span>';
  if (turn.verificationAfterPatch) {
    const parts = [];
    if (turn.testsAfterPatch) parts.push(`test ${fmt(turn.testsAfterPatch)}`);
    if (turn.buildAfterPatch) parts.push(`build ${fmt(turn.buildAfterPatch)}`);
    if (turn.gitAfterPatch) parts.push(`git ${fmt(turn.gitAfterPatch)}`);
    return `<span class="pill green">${escapeHtml(parts.join(', ') || 'verified')}</span>`;
  }
  return '<span class="pill red">no verification</span>';
}

function renderFailurePills(turn) {
  if (!turn.failureRows?.length) return '<span class="muted">none</span>';
  return turn.failureRows
    .slice(0, 3)
    .map((row) => `<span class="pill red">${escapeHtml(failureLabel(row.name))} ${fmt(row.count)}</span>`)
    .join(' ');
}

function renderPatchVerificationRows(turns) {
  if (!turns.length) return '<div class="empty">No patch turns in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Turn</th><th>Patches</th><th>Before Patch</th><th>After Patch</th><th>Failures</th><th>Files</th></tr></thead>
        <tbody>
          ${turns
            .map(
              (turn) => `
                <tr>
                  <td>
                    <div class="clickable" data-session="${escapeAttr(turn.sessionId)}">${escapeHtml(turn.sessionTitle || turn.sessionId)}</div>
                    <div class="muted">${escapeHtml(turn.userPreview || '')}</div>
                  </td>
                  <td>${fmt(turn.patchCalls || turn.patchResults)}</td>
                  <td>${turn.readOrSearchBeforePatch ? '<span class="pill green">read/search first</span>' : '<span class="pill amber">no read/search signal</span>'}</td>
                  <td>${renderVerificationPill(turn)}</td>
                  <td>${renderFailurePills(turn)}</td>
                  <td>${(turn.touchedFileList || []).slice(0, 4).map((item) => `<div class="path">${escapeHtml(item.name)}</div>`).join('')}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderFinalAnswerQualityRows(turns) {
  const rows = [
    { name: 'Has Final Message', count: turns.filter((turn) => turn.finalAnswerQuality?.hasFinalMessage).length },
    { name: 'Mentions Changed Files', count: turns.filter((turn) => turn.finalAnswerQuality?.mentionsChangedFiles).length },
    { name: 'Mentions Verification', count: turns.filter((turn) => turn.finalAnswerQuality?.mentionsVerification).length },
    { name: 'Mentions Risks/Gaps', count: turns.filter((turn) => turn.finalAnswerQuality?.mentionsRisks).length },
    { name: 'Missing Verification Evidence', count: turns.filter((turn) => turn.finalAnswerQuality?.missingVerificationEvidence).length },
  ];
  const risky = turns
    .filter((turn) => turn.finalAnswerQuality?.missingVerificationEvidence)
    .sort((a, b) => b.userAt.localeCompare(a.userAt))
    .slice(0, 40);
  return `
    <div class="split">
      ${renderSimpleRows(rows, 'Signal', 'Turns')}
      ${renderFinalAnswerRiskRows(risky)}
    </div>
  `;
}

function renderFinalAnswerRiskRows(turns) {
  if (!turns.length) return '<div class="empty">No final-answer verification gaps in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Turn</th><th>Final Preview</th></tr></thead>
        <tbody>
          ${turns
            .map(
              (turn) => `
                <tr>
                  <td>
                    <span class="clickable" data-session="${escapeAttr(turn.sessionId)}">${escapeHtml(turn.sessionTitle || turn.sessionId)}</span>
                    <div>${renderQualityPill(turn)} ${renderVerificationPill(turn)}</div>
                  </td>
                  <td><pre>${escapeHtml(turn.finalPreview || '')}</pre></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderArtifactRows(rows) {
  if (!rows.length) return '<div class="empty">No artifact writes in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Artifact</th><th>Mechanism</th><th>Turn</th><th>Quality</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>
                    <div class="path">${escapeHtml(row.path || '')}</div>
                    ${(row.paths || []).slice(1, 4).map((item) => `<div class="path muted">${escapeHtml(item)}</div>`).join('')}
                  </td>
                  <td>
                    <span class="pill amber">${escapeHtml(row.mechanism || '')}</span>
                    ${row.command ? `<pre>${escapeHtml(row.command)}</pre>` : ''}
                  </td>
                  <td>
                    <span class="clickable" data-session="${escapeAttr(row.sessionId)}">${escapeHtml(row.sessionTitle || row.sessionId)}</span>
                    <div class="muted">${escapeHtml(formatDate(row.timestamp))}</div>
                  </td>
                  <td>
                    ${row.outsideWorkspace ? '<span class="pill red">outside workspace</span>' : ''}
                    ${row.verifiedAfterWrite ? '<span class="pill green">verified after write</span>' : '<span class="pill red">no verification</span>'}
                    ${row.patchSuccess === false ? '<span class="pill red">patch failed</span>' : ''}
                  </td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderIssueLoopRows(turns) {
  const rows = turns
    .filter((turn) => turn.issueLoop?.hadFailure)
    .sort((a, b) => {
      const aResolved = turnIssueResolved(a) ? 1 : 0;
      const bResolved = turnIssueResolved(b) ? 1 : 0;
      return aResolved - bResolved || b.failures - a.failures || b.userAt.localeCompare(a.userAt);
    })
    .slice(0, 80);
  if (!rows.length) return '<div class="empty">No failure-to-fix loops in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Turn</th><th>Loop Status</th><th>Corrective Actions</th><th>Failures</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (turn) => `
                <tr>
                  <td>
                    <span class="clickable" data-session="${escapeAttr(turn.sessionId)}">${escapeHtml(turn.sessionTitle || turn.sessionId)}</span>
                    <div class="muted">${escapeHtml(turn.userPreview || '')}</div>
                  </td>
                  <td><span class="pill ${turnIssueResolved(turn) ? 'green' : 'red'}">${escapeHtml(issueLoopLabel(turn.issueLoop.status))}</span></td>
                  <td>
                    ${turn.issueLoop.inspectAfterFailure ? '<span class="pill">inspect</span>' : ''}
                    ${turn.issueLoop.patchAfterFailure ? '<span class="pill amber">patch</span>' : ''}
                    ${turn.issueLoop.verifyAfterFailure ? '<span class="pill green">verify</span>' : ''}
                  </td>
                  <td>${renderFailurePills(turn)}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function issueLoopLabel(value) {
  return {
    none: 'No Failure',
    unresolved_signal: 'Unresolved Signal',
    inspected_after_failure: 'Inspected After Failure',
    patched_after_failure: 'Patched After Failure',
    verification_attempted_after_failure: 'Verification Attempted',
    verified_after_failure: 'Verified After Failure',
  }[value] || value || 'Unknown';
}

function turnIssueResolved(turn) {
  return ['verified_after_failure', 'verification_attempted_after_failure'].includes(turn.issueLoop?.status);
}

function aggregateCommandStats(turns) {
  const map = new Map();
  for (const turn of turns) {
    for (const stat of turn.commandStats || []) {
      if (!map.has(stat.category)) {
        map.set(stat.category, { category: stat.category, label: stat.label, count: 0, ok: 0, fail: 0, avgDurationWeighted: 0, p90DurationMs: 0 });
      }
      const row = map.get(stat.category);
      row.count += stat.count || 0;
      row.ok += stat.ok || 0;
      row.fail += stat.fail || 0;
      row.avgDurationWeighted += (stat.avgDurationMs || 0) * (stat.count || 0);
      row.p90DurationMs = Math.max(row.p90DurationMs, stat.p90DurationMs || 0);
    }
  }
  return [...map.values()]
    .map((row) => ({
      ...row,
      failRate: row.count ? Number(((row.fail / row.count) * 100).toFixed(1)) : 0,
      avgDurationMs: row.count ? Math.round(row.avgDurationWeighted / row.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function renderCommandStats(rows) {
  if (!rows.length) return '<div class="empty">No command telemetry in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Category</th><th>Commands</th><th>OK</th><th>Failed</th><th>Fail Rate</th><th>Avg Duration</th><th>Worst P90</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${escapeHtml(row.label || row.category)}</td>
                  <td>${fmt(row.count)}</td>
                  <td><span class="pill green">${fmt(row.ok)}</span></td>
                  <td><span class="pill ${row.fail ? 'red' : ''}">${fmt(row.fail)}</span></td>
                  <td>${escapeHtml(row.failRate)}%</td>
                  <td>${escapeHtml(formatDuration(row.avgDurationMs))}</td>
                  <td>${escapeHtml(formatDuration(row.p90DurationMs))}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderCommandSampleRows(rows, includeFailure) {
  if (!rows.length) return '<div class="empty">No command samples in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Command</th>
            <th>${includeFailure ? 'Failure' : 'Duration'}</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>
                    <span class="clickable" data-session="${escapeAttr(row.sessionId)}">${escapeHtml(row.sessionTitle || row.sessionId)}</span>
                    <div class="muted">${escapeHtml(formatDate(row.timestamp))}</div>
                  </td>
                  <td>
                    <span class="pill amber">${escapeHtml(row.label || row.category || '')}</span>
                    <pre>${escapeHtml(row.command || '')}</pre>
                  </td>
                  <td>
                    ${includeFailure ? `<span class="pill red">${escapeHtml(failureLabel(row.kind || row.failureKind))}</span>` : `<span class="pill">${escapeHtml(formatDuration(row.durationMs))}</span>`}
                    ${row.exitCode !== undefined && row.exitCode !== null ? `<div class="muted">exit ${escapeHtml(row.exitCode)}</div>` : ''}
                    ${row.snippet ? `<pre>${escapeHtml(row.snippet)}</pre>` : ''}
                  </td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderCompactionRows(turns) {
  if (!turns.length) return '<div class="empty">No compaction records in scope.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Session</th><th>Time</th><th>Compactions</th><th>Tokens</th></tr></thead>
        <tbody>
          ${turns
            .map(
              (turn) => `
                <tr>
                  <td>
                    <span class="clickable" data-session="${escapeAttr(turn.sessionId)}">${escapeHtml(turn.sessionTitle || turn.sessionId)}</span>
                    <div class="muted">${escapeHtml(turn.userPreview || '')}</div>
                  </td>
                  <td class="nowrap">${escapeHtml(formatDate(turn.userAt))}</td>
                  <td>${fmt(turn.compactions)}</td>
                  <td>${fmt(turn.tokenTotal)}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSearch() {
  const types = state.overview.facets.payloadType || [];
  const typeOptions = optionHtml('', 'All record types') + types.map((item) => optionHtml(item.name, item.name, item.count)).join('');
  const results = state.search.results;
  const body = `
    <div class="search-row">
      <label>
        Query
        <input id="searchTerm" type="search" value="${escapeAttr(state.search.term)}" placeholder="command, path, message, error">
      </label>
      <label>
        Record Type
        <select id="searchType">${typeOptions}</select>
      </label>
      <button type="button" data-run-search="1">Search</button>
    </div>
    <div style="height:12px"></div>
    ${renderSearchResults(results)}
  `;
  els.mainPanel.innerHTML = panel('Search', results ? `${results.results.length} results` : '', body);
  const select = document.querySelector('#searchType');
  if (select) select.value = state.search.type;
}

function renderSearchResults(results) {
  if (!results) return '<div class="empty">No search has run.</div>';
  if (!results.results.length) return '<div class="empty">No matches.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Session</th><th>Time</th><th>Type</th><th>Snippet</th></tr></thead>
        <tbody>
          ${results.results
            .map(
              (row) => `
                <tr>
                  <td><span class="clickable" data-session="${escapeAttr(row.sessionId)}">${escapeHtml(row.sessionTitle)}</span></td>
                  <td class="nowrap">${escapeHtml(formatDate(row.timestamp))}</td>
                  <td><span class="pill">${escapeHtml(row.payloadType)}</span></td>
                  <td><pre>${escapeHtml(row.snippet)}</pre></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function groupSessions(sessions, keyFn, rowFn) {
  const map = new Map();
  for (const session of sessions) {
    const key = keyFn(session);
    if (!map.has(key)) map.set(key, { key, sessions: [] });
    map.get(key).sessions.push(session);
  }
  return [...map.values()]
    .map(rowFn)
    .sort((a, b) => b.sessions - a.sessions || b.toolCalls - a.toolCalls || a.label.localeCompare(b.label));
}

function sum(rows, fn) {
  return rows.reduce((total, row) => total + Number(fn(row) || 0), 0);
}

function renderGroupTable(groups, label) {
  if (!groups.length) return '<div class="empty">No groups match the current filters.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>${escapeHtml(label)}</th><th>Sessions</th><th>Tool Calls</th><th>Patches</th><th>Tokens</th><th>Failures</th></tr></thead>
        <tbody>
          ${groups
            .map(
              (group) => `
                <tr>
                  <td><div class="path">${escapeHtml(group.label)}</div></td>
                  <td>${fmt(group.sessions)}</td>
                  <td>${fmt(group.toolCalls)}</td>
                  <td>${fmt(group.patches)}</td>
                  <td>${fmt(group.tokens)}</td>
                  <td>${fmt(group.failures)}</td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderDetailPanel() {
  if (!state.selectedSessionId) {
    return panel('Session Detail', '', '<div class="empty">Select a session.</div>');
  }
  if (!state.detail || state.detail.session.id !== state.selectedSessionId) {
    return panel('Session Detail', '', '<div class="empty">Loading session...</div>');
  }

  const session = state.detail.session;
  const tabs = ['timeline', 'conversation', 'tools', 'tokens', 'fields']
    .map(
      (tab) =>
        `<button type="button" data-detail-tab="${tab}" class="${state.detailTab === tab ? 'active' : ''}">${escapeHtml(tab[0].toUpperCase() + tab.slice(1))}</button>`
    )
    .join('');
  const header = `
    <div class="tabs">${tabs}</div>
    <div style="height:10px"></div>
    <div class="path">${escapeHtml(session.filePath)}</div>
    <div style="height:10px"></div>
  `;
  return panel(
    session.title || session.id,
    `${escapeHtml(shortDate(session.firstTimestamp))} | ${fmt(session.counts.records)} records`,
    header + renderDetailTab()
  );
}

function renderDetailTab() {
  const detail = state.detail;
  if (!detail) return '';
  if (state.detailTab === 'conversation') return renderConversation(detail.conversation);
  if (state.detailTab === 'tools') return renderTools(detail.tools);
  if (state.detailTab === 'tokens') return renderTokenEvents(detail.tokens);
  if (state.detailTab === 'fields') return renderFields(detail);
  return renderTimeline(detail.timeline);
}

function renderTimeline(events) {
  const visible = events.slice(0, 350);
  if (!visible.length) return '<div class="empty">No timeline events.</div>';
  return `
    <div class="timeline">
      ${visible.map(renderTimelineEvent).join('')}
    </div>
    ${events.length > visible.length ? `<div class="panel-subtitle">Showing ${visible.length} of ${events.length} events. Use the detail tabs for focused views.</div>` : ''}
  `;
}

function renderTimelineEvent(event) {
  const failed = event.failed || String(event.kind || '').includes('failed');
  return `
    <article class="timeline-event">
      <div class="event-time">
        <div>${escapeHtml(formatDate(event.timestamp))}</div>
        <div>line ${fmt(event.lineNo)}</div>
        ${event.turnId ? `<div>${escapeHtml(event.turnId)}</div>` : ''}
      </div>
      <div>
        <div class="event-title">
          <span>${escapeHtml(event.title || event.payloadType)}</span>
          <span class="pill ${failed ? 'red' : ''}">${escapeHtml(event.payloadType)}</span>
          ${event.name ? `<span class="pill amber">${escapeHtml(event.name)}</span>` : ''}
        </div>
        ${event.label ? `<div class="muted">${escapeHtml(event.label)}</div>` : ''}
        ${event.workdir ? `<div class="path">${escapeHtml(event.workdir)}</div>` : ''}
        ${event.text ? `<div class="event-text"><pre>${escapeHtml(event.text)}</pre></div>` : ''}
      </div>
    </article>
  `;
}

function renderConversation(rows) {
  if (!rows.length) return '<div class="empty">No conversation records.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Role</th><th>Text</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td class="nowrap">${escapeHtml(formatDate(row.timestamp))}</td>
                  <td><span class="pill">${escapeHtml(row.role)}</span></td>
                  <td><pre>${escapeHtml(row.text)}</pre></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTools(rows) {
  if (!rows.length) return '<div class="empty">No tool calls.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Tool</th><th>Arguments</th><th>Output</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td class="nowrap">${escapeHtml(formatDate(row.timestamp))}</td>
                  <td>
                    <span class="pill ${row.failed ? 'red' : 'amber'}">${escapeHtml(row.name)}</span>
                    ${row.workdir ? `<div class="path">${escapeHtml(row.workdir)}</div>` : ''}
                    ${row.exitCode !== undefined && row.exitCode !== null ? `<div class="muted">exit ${escapeHtml(row.exitCode)}</div>` : ''}
                    ${row.durationMs ? `<div class="muted">${escapeHtml(formatDuration(row.durationMs))}</div>` : ''}
                  </td>
                  <td><pre>${escapeHtml(row.text || '')}</pre></td>
                  <td><pre>${escapeHtml(row.output || '')}</pre></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTokenEvents(rows) {
  if (!rows.length) return '<div class="empty">No token events.</div>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Total</th><th>Total Usage</th><th>Last Usage</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td class="nowrap">${escapeHtml(formatDate(row.timestamp))}</td>
                  <td>${fmt(row.total)}</td>
                  <td><pre>${escapeHtml(JSON.stringify(row.totalUsage, null, 2))}</pre></td>
                  <td><pre>${escapeHtml(JSON.stringify(row.lastUsage, null, 2))}</pre></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderFields(detail) {
  const session = detail.session;
  const rows = [
    ['ID', session.id],
    ['File', session.filePath],
    ['Working directory', session.cwd],
    ['Repository', session.repositoryUrl],
    ['Branch', session.branch],
    ['Commit', session.commitHash],
    ['Model', session.model],
    ['Effort', session.effort],
    ['CLI', session.cliVersion],
    ['Thread key', session.threadKey],
    ['Thread reason', session.threadReason],
    ['Approval policy', session.approvalPolicy],
    ['Sandbox policy', session.sandboxPolicy],
    ['Timezone', session.timezone],
  ];
  return `
    ${renderKeyValueRows(rows)}
    <div style="height:12px"></div>
    ${renderSimpleRows(detail.payloadTypeCounts, 'Payload Type', 'Records')}
  `;
}

function renderKeyValueRows(rows) {
  return `
    <div class="table-wrap">
      <table>
        <tbody>
          ${rows
            .filter(([, value]) => value)
            .map(
              ([key, value]) => `
                <tr>
                  <th>${escapeHtml(key)}</th>
                  <td><div class="path">${escapeHtml(value)}</div></td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.detail = null;
  render();
  try {
    state.detail = await apiGet(`/api/session/${encodeURIComponent(sessionId)}`);
    render();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function runSearch() {
  const term = document.querySelector('#searchTerm')?.value || '';
  const type = document.querySelector('#searchType')?.value || '';
  state.search.term = term;
  state.search.type = type;
  setStatus('Searching session logs...');
  try {
    const params = new URLSearchParams({ q: term, type, limit: '120' });
    if (els.threadFilter.value) params.set('thread', els.threadFilter.value);
    state.search.results = await apiGet(`/api/search?${params.toString()}`);
    setStatus('');
    render();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function render() {
  const overview = state.overview;
  if (!overview) return;
  const sessions = filteredSessions();
  const threads = filteredThreads(sessions);

  els.sourceLine.textContent = `${overview.sessionsRoot} | indexed ${formatDate(overview.generatedAt)} | ${formatBytes(overview.totals.bytes)} | ${fmt(overview.totals.sessions)} sessions`;
  renderMetrics(sessions, threads);
  renderUseCaseNav();
  renderFacets(sessions);

  if (state.view === 'workflow') renderWorkflow(sessions);
  else if (state.view === 'threads') renderThreads(sessions, threads);
  else if (state.view === 'transcripts') renderTranscripts(sessions);
  else if (state.view === 'commands') renderCommands(sessions);
  else if (state.view === 'projects') renderProjects(sessions);
  else if (state.view === 'repositories') renderRepositories(sessions);
  else if (state.view === 'files') renderFiles(sessions);
  else if (state.view === 'patches') renderPatches(sessions);
  else if (state.view === 'tokens') renderTokens(sessions);
  else if (state.view === 'failures') renderFailures(sessions);
  else if (state.view === 'search') renderSearch();
  else renderOverview(sessions, threads);
}

let filterTimer = null;
function scheduleRender() {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(render, 120);
}

for (const input of [
  els.textFilter,
  els.threadFilter,
  els.cwdFilter,
  els.repoFilter,
  els.modelFilter,
  els.toolFilter,
  els.dateFromFilter,
  els.dateToFilter,
  els.failureFilter,
]) {
  input.addEventListener('input', scheduleRender);
  input.addEventListener('change', scheduleRender);
}

els.refreshBtn.addEventListener('click', () => loadOverview(true));

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    state.view = viewButton.dataset.view;
    render();
    return;
  }

  const sessionButton = event.target.closest('[data-session]');
  if (sessionButton) {
    const sessionId = sessionButton.dataset.session;
    if (!['transcripts', 'commands', 'patches', 'tokens', 'failures'].includes(state.view)) {
      state.view = 'transcripts';
    }
    selectSession(sessionId);
    return;
  }

  const filterButton = event.target.closest('[data-set-filter]');
  if (filterButton) {
    const name = filterButton.dataset.setFilter;
    const value = filterButton.dataset.filterValue || '';
    if (name === 'thread') els.threadFilter.value = value;
    if (name === 'cwd') els.cwdFilter.value = value;
    if (name === 'repo') els.repoFilter.value = value;
    if (name === 'tool') els.toolFilter.value = value;
    render();
    return;
  }

  const detailTab = event.target.closest('[data-detail-tab]');
  if (detailTab) {
    state.detailTab = detailTab.dataset.detailTab;
    render();
    return;
  }

  const searchButton = event.target.closest('[data-run-search]');
  if (searchButton) {
    runSearch();
  }
});

document.addEventListener('change', (event) => {
  if (event.target?.id === 'workflowShapeFilter') {
    state.workflowShape = event.target.value;
    render();
  }
  if (event.target?.id === 'workflowRiskFilter') {
    state.workflowRisk = event.target.value;
    render();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target?.id === 'searchTerm') {
    runSearch();
  }
});

loadOverview();
