// gamevolley-history.js — the Build History screen.
//
// Lists every saved Create / Improve / Fix run and shows the whole conversation:
// your request, the Director's brief, each agent's messages, the Critic's findings
// and how it ended. Saved data is model/user text, so it is only ever inserted
// with textContent.
(function () {
  const MODE_LABEL = { create: 'Create game', improve: 'Improve', fix: 'Fix bug' };
  const STATUS_LABEL = {
    completed: 'Completed', unfinished: 'Didn’t pass review', failed: 'Failed',
    stopped: 'Stopped', interrupted: 'Interrupted', running: 'Running now',
  };
  const ROLE_LABEL = { director: '🎬 Director', developer: '🛠 Developer', critic: '🔍 Critic' };

  const roleLabel = (r) => ROLE_LABEL[r] || r || 'System';
  const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const firstLine = (s) => (String(s || '').split('\n').find((l) => l.trim()) || '(no request text)').trim().slice(0, 160);

  function duration(run) {
    if (!run.endedAt) return '';
    const s = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  function modelsLine(roles = {}) {
    return ['director', 'developer', 'critic']
      .filter((k) => roles[k] && roles[k].provider)
      .map((k) => `${roleLabel(k)}: ${roles[k].provider}${roles[k].model ? ` (${roles[k].model})` : ''}`)
      .join('  ·  ');
  }

  function lineFor(e) {
    if (e.kind === 'status') return `${roleLabel(e.role)}: ${e.status}${e.text ? ` — ${e.text}` : ''}`;
    if (e.kind === 'finding') return `⚠ [${e.severity}] ${e.text}`;
    if (e.kind === 'file') return `✓ ${e.text}`;
    if (e.kind === 'phase') return `— ${e.text}`;
    if (e.kind === 'error') return `✖ ${e.role ? `${roleLabel(e.role)}: ` : ''}${e.text}`;
    return e.text;
  }

  function resultText(run) {
    const out = [STATUS_LABEL[run.status] || run.status];
    const r = run.result;
    if (r) {
      if (r.verdict) out.push(`Critic verdict: ${r.verdict}`);
      if (r.rounds) out.push(`Rounds used: ${r.rounds}`);
      if (r.reason) out.push(r.reason);
      if (r.knownIssues && r.knownIssues.length) out.push(`Remaining issues:\n${r.knownIssues.map((i) => `• ${i}`).join('\n')}`);
    }
    if (run.error) out.push(`Error: ${run.error}`);
    if (run.status === 'interrupted') out.push('The app closed before this build finished. Everything up to that point is saved below.');
    if (run.status === 'running') out.push('This build is still going. This page updates when it ends.');
    return out.join('\n');
  }

  // The Director's streamed text is the brief itself, so show it only once.
  const shownEntries = (run) => run.entries.filter((e) => !(run.brief && e.kind === 'output' && e.role === 'director'));

  function transcript(run) {
    const parts = [
      `${MODE_LABEL[run.mode] || run.mode} — ${run.projectName}`,
      `${when(run.startedAt)}${duration(run) ? ` (${duration(run)})` : ''}`,
      run.projectPath,
      modelsLine(run.roles),
      `\n## Your request\n${run.instruction}`,
    ];
    if (run.brief) parts.push(`\n## Director's brief\n${run.brief}`);
    parts.push('\n## What happened');
    for (const e of shownEntries(run)) parts.push(e.kind === 'output' ? `\n### ${roleLabel(e.role)}\n${e.text}\n` : lineFor(e));
    parts.push(`\n## Result\n${resultText(run)}`);
    return parts.join('\n');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function block(title, text, open) {
    const d = el('details', 'gv-history-msg');
    d.open = !!open;
    d.append(el('summary', '', title), el('pre', '', text));
    return d;
  }

  function create(host) {
    const $ = (id) => document.getElementById(id);
    const screen = $('gvHistory');
    const openBtn = $('gvHistoryBtn');
    if (!screen || !openBtn) return { isOpen: () => false, refresh() {} };

    let open = false;
    let selectedId = null;
    let current = null;      // the full run being shown
    let listRequest = 0;     // drops out-of-order search responses

    // The game preview is a native view drawn above the page, so it would cover
    // this screen. Park it off to the side at the same size: a build in progress
    // can still playtest and screenshot it.
    function parkPreview() {
      const area = $('gvPreviewArea');
      const r = area ? area.getBoundingClientRect() : { width: 0, height: 0 };
      try {
        window.pv.previewSetBounds({
          x: window.innerWidth + 100, y: 0,
          width: Math.round(r.width) || 800, height: Math.round(r.height) || 600,
        });
      } catch {}
    }

    function setMsg(text, cls) {
      const m = $('gvHistoryMsg');
      m.textContent = text || '';
      m.className = 'gv-status' + (cls ? ' ' + cls : '');
    }

    function showEmpty(text) {
      current = null;
      $('gvHistoryActions').classList.add('hidden');
      $('gvHistoryView').replaceChildren(el('div', 'gv-muted', text));
    }

    function markSelected() {
      for (const item of $('gvHistoryList').children) {
        item.classList.toggle('selected', item.dataset.id === selectedId);
      }
    }

    function render(run) {
      current = run;
      $('gvHistoryActions').classList.remove('hidden');
      $('gvHistoryDelete').disabled = run.status === 'running';
      const nodes = [
        el('div', 'gv-history-meta', `${MODE_LABEL[run.mode] || run.mode} · ${run.projectName} · ${when(run.startedAt)}${duration(run) ? ` · took ${duration(run)}` : ''}`),
        el('div', 'gv-history-meta', run.projectPath),
        el('div', 'gv-history-meta', modelsLine(run.roles)),
        block('Result', resultText(run), true),
        block('Your request', run.instruction, run.instruction.length < 1500),
      ];
      if (run.brief) nodes.push(block('🎬 Director’s brief', run.brief, true));
      for (const e of shownEntries(run)) {
        if (e.kind === 'output') nodes.push(block(`${roleLabel(e.role)} — full message`, e.text, false));
        else nodes.push(el('div', `gv-history-line ${e.kind} ${e.severity || ''}`.trim(), lineFor(e)));
      }
      const view = $('gvHistoryView');
      view.replaceChildren(...nodes);
      view.scrollTop = 0;
    }

    async function select(id) {
      selectedId = id;
      markSelected();
      setMsg('');
      let run = null;
      try { run = await window.pv.agentHistoryRead(id); } catch {}
      if (selectedId !== id) return;
      if (run) render(run);
      else showEmpty('That run could not be read.');
    }

    async function loadList() {
      const ticket = ++listRequest;
      const query = $('gvHistorySearch').value;
      let runs;
      try {
        runs = await window.pv.agentHistoryList(query);
        if (!Array.isArray(runs)) runs = [];
      } catch (e) {
        showEmpty('Could not load history: ' + (e.message || e));
        return;
      }
      if (ticket !== listRequest) return;
      const items = runs.map((r) => {
        const item = el('button', 'gv-history-item');
        item.type = 'button';
        item.dataset.id = r.id;
        const meta = el('div', 'gv-history-item-meta');
        meta.append(
          el('span', `gv-history-badge ${r.status}`, STATUS_LABEL[r.status] || r.status),
          el('span', '', `${MODE_LABEL[r.mode] || r.mode} · ${r.projectName}`),
          el('span', '', when(r.startedAt)),
        );
        item.append(el('div', 'gv-history-item-title', firstLine(r.instruction)), meta);
        item.onclick = () => select(r.id);
        return item;
      });
      $('gvHistoryList').replaceChildren(...items);
      if (!runs.length) {
        selectedId = null;
        showEmpty(query ? 'No runs match that search.' : 'No builds yet. Every Create, Improve and Fix you run from now on is saved here.');
        return;
      }
      await select(runs.some((r) => r.id === selectedId) ? selectedId : runs[0].id);
    }

    async function show() {
      open = true;
      parkPreview();
      screen.classList.remove('hidden');
      $('gvHistorySearch').value = '';
      selectedId = null;
      await loadList();
      $('gvHistorySearch').focus({ preventScroll: true });
    }

    function hide() {
      if (!open) return;
      open = false;
      screen.classList.add('hidden');
      host.layoutPreview();
    }

    openBtn.onclick = show;
    $('gvHistoryClose').onclick = hide;
    $('gvHistorySearch').oninput = loadList;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    // Leaving for the other workspace closes this screen so it can't linger hidden.
    const volleyTab = $('tabVolley');
    if (volleyTab) volleyTab.addEventListener('click', hide);
    window.addEventListener('resize', () => { if (open) parkPreview(); });

    $('gvHistoryOpenProject').onclick = async () => {
      if (!current) return;
      if (host.isBuilding()) { setMsg('Stop the running build before switching projects.', 'err'); return; }
      const dir = current.projectPath;
      hide();
      try { await host.openProject(dir); }
      catch (e) { await show(); setMsg(e.message || String(e), 'err'); }
    };
    $('gvHistoryReuse').onclick = () => {
      if (!current) return;
      $('gvIdea').value = current.instruction;
      hide();
      $('gvIdea').focus({ preventScroll: true });
    };
    $('gvHistoryCopy').onclick = async () => {
      if (!current) return;
      try { await window.pv.copy(transcript(current)); setMsg('Copied.', 'ok'); }
      catch { setMsg('Could not copy.', 'err'); }
    };
    $('gvHistoryDelete').onclick = async () => {
      if (!current) return;
      if (!window.confirm('Delete this run from history? This can’t be undone. Your game files are not touched.')) return;
      const res = await window.pv.agentHistoryDelete(current.id);
      if (!res || !res.ok) { setMsg((res && res.message) || 'Could not delete.', 'err'); return; }
      selectedId = null;
      await loadList();
    };

    return {
      isOpen: () => open,
      refresh() { if (open) loadList(); },
      show,
      hide,
    };
  }

  window.GvHistoryUI = { create, transcript };
})();
