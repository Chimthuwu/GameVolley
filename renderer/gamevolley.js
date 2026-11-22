// gamevolley.js — the GameVolley workspace front-end.
//
// Talks to the main process through the `pv` bridge (never touches fs/spawn
// directly). Drives the three-role workflow (Creative Director -> Developer ->\n// Critic), shows live agent activity, and positions the embedded game preview.
(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  const body = document.body;
  let activeProject = null;     // { name, path }
  let building = false;
  let eventSink = null;          // registered gameOnEvent callback
  let isFullscreen = false;      // Track fullscreen state for persistence

  // ---------- fullscreen persistence ----------
  function getFullscreenState() {
    try { return JSON.parse(localStorage.getItem('gv:fullscreen') || '{}'); } catch { return {}; }
  }
  function saveFullscreenState(state) {
    try { localStorage.setItem('gv:fullscreen', JSON.stringify(state)); } catch {}
  }
  function applyPersistedFullscreen() {
    const state = getFullscreenState();
    isFullscreen = !!state.enabled;
    // If we have a project open and fullscreen was enabled, re-enter fullscreen.
    if (isFullscreen && activeProject) {
      // Defer until layout is ready.
      requestAnimationFrame(() => {
        try { pv.previewFullscreen(); } catch {}
        // Update button state if it exists.
        const btn = $('gvFull');
        if (btn) btn.classList.add('active');
      });
    }
  }

  // ---------- view switching ----------
  function setView(v) {
    body.classList.toggle('view-game', v === 'game');
    body.classList.toggle('view-volley', v === 'volley');
    // Visibility is driven entirely by the body.view-game / body.view-volley class.
    // The .hidden class uses !important, so it must be removed here or #gameRoot
    // would stay hidden forever despite the view-game grid rule.
    const gv = $('gameRoot'); if (gv) gv.classList.remove('hidden');
    const g = $('tabGame'), t = $('tabVolley');
    if (g) g.classList.toggle('tab-active', v === 'game');
    if (t) t.classList.toggle('tab-active', v === 'volley');
    if (v === 'game') requestAnimationFrame(layoutPreview);
  }

  // ---------- preview positioning ----------
  // The WebContentsView lives in the main process; we hand it the on-screen rect
  // of the preview area so it overlays exactly. Coordinates are window-relative,
  // which (frameless window, titlebar inside the renderer) equals viewport coords.
  function layoutPreview() {
    const el = $('gvPreviewArea');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return; // hidden / not laid out yet
    if (window.pv && pv.previewSetBounds) {
      try { pv.previewSetBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }); } catch {}
    }
  }
  window.addEventListener('resize', layoutPreview);

  // ---------- activity log ----------
  // Streaming deltas append into ONE live line per role (closed by the next
  // non-output event) instead of one log line per token chunk, which turned
  // the panel into unreadable confetti.
  let liveLine = null;
  let liveRole = null;
  const LIVE_MAX = 4000;

  function closeLiveLine() { liveLine = null; liveRole = null; }

  function addActivity(text, cls) {
    const log = $('gvActivity');
    if (!log) return;
    const line = document.createElement('div');
    line.className = 'gv-log-line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    log.appendChild(line);
    while (log.children.length > 400) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function appendStreamDelta(role, text) {
    const log = $('gvActivity');
    if (!log) return;
    if (!liveLine || liveRole !== role) {
      closeLiveLine();
      liveRole = role;
      liveLine = document.createElement('div');
      liveLine.className = 'gv-log-line out gv-stream';
      const tag = document.createElement('span');
      tag.className = 'gv-stream-tag';
      tag.textContent = `${role}: `;
      const body = document.createElement('span');
      body.textContent = text;
      liveLine.appendChild(tag);
      liveLine.appendChild(body);
      log.appendChild(liveLine);
    } else {
      let body = liveLine.lastChild;
      if (body.textContent.length > LIVE_MAX) body.textContent = body.textContent.slice(-LIVE_MAX) + '…';
      else body.textContent += text;
    }
    // Scroll ONLY the log container. scrollIntoView() would also scroll
    // documentElement (see the vanished-titlebar bug) — never use it here.
    log.scrollTop = log.scrollHeight;
  }
  function setStatus(text, cls) {
      const s = $('gvStatus');
      if (!s) return;
      s.textContent = text || '';
      s.className = 'gv-status' + (cls ? ' ' + cls : '');
    }

    // ---------- agent cards ----------
    const agentCardState = {
      director: { status: 'idle', startTime: null, output: '', liveLine: null },
      developer: { status: 'idle', startTime: null, output: '', liveLine: null },
      critic: { status: 'idle', startTime: null, output: '', liveLine: null },
    };

    function resetAgentCards() {
      for (const role of ['director', 'developer', 'critic']) {
        agentCardState[role] = { status: 'idle', startTime: null, output: '', liveLine: null };
        updateAgentCard(role);
      }
    }

    function updateAgentCard(role) {
      const state = agentCardState[role];
      const card = document.querySelector(`.gv-agent-card[data-role="${role}"]`);
      if (!card) return;

      const badge = card.querySelector('.gv-agent-status-badge');
      const elapsedEl = card.querySelector('.gv-agent-elapsed');
      const outputEl = card.querySelector('.gv-agent-output');
      const toggle = card.querySelector('.gv-agent-toggle');

      if (badge) {
        badge.className = 'gv-agent-status-badge ' + state.status;
        badge.textContent = state.status.charAt(0).toUpperCase() + state.status.slice(1);
        badge.dataset.status = state.status;
      }

      if (elapsedEl) {
        if (state.startTime && state.status === 'working') {
          const elapsed = Date.now() - state.startTime;
          const secs = Math.floor(elapsed / 1000);
          const mins = Math.floor(secs / 60);
          elapsedEl.textContent = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
        } else if (state.status === 'done') {
          elapsedEl.textContent = 'Done';
        } else if (state.status === 'error') {
          elapsedEl.textContent = 'Error';
        } else {
          elapsedEl.textContent = '—';
        }
      }

      if (outputEl && state.output) {
        outputEl.textContent = state.output;
      }
    }

    function startAgentTimer(role) {
      const state = agentCardState[role];
      state.startTime = Date.now();
      state.status = 'working';
      state.output = '';
      updateAgentCard(role);
      // Update elapsed time every second while working
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => {
        if (agentCardState[role].status === 'working') {
          updateAgentCard(role);
        } else {
          clearInterval(state.timer);
          state.timer = null;
        }
      }, 1000);
    }

    function stopAgentTimer(role, finalStatus) {
      const state = agentCardState[role];
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      state.status = finalStatus;
      updateAgentCard(role);
    }

    function appendAgentOutput(role, text) {
      const state = agentCardState[role];
      state.output += text;
      // Keep output bounded
      if (state.output.length > 8000) {
        state.output = '…' + state.output.slice(-8000);
      }
      const card = document.querySelector(`.gv-agent-card[data-role="${role}"]`);
      if (card) {
        const outputEl = card.querySelector('.gv-agent-output');
        if (outputEl) outputEl.textContent = state.output;
      }
    }

    function toggleAgentOutput(role) {
      const card = document.querySelector(`.gv-agent-card[data-role="${role}"]`);
      if (!card) return;
      const outputEl = card.querySelector('.gv-agent-output');
      const toggle = card.querySelector('.gv-agent-toggle');
      if (!outputEl || !toggle) return;
      const expanded = !outputEl.classList.contains('hidden');
      outputEl.classList.toggle('hidden', expanded);
      toggle.setAttribute('aria-expanded', String(!expanded));
    }

    // Wire up toggle buttons
    document.addEventListener('click', (e) => {
      const toggle = e.target.closest('.gv-agent-toggle');
      if (toggle) {
        const card = toggle.closest('.gv-agent-card');
        if (card) toggleAgentOutput(card.dataset.role);
      }
    });

    // ---------- project tree / checkpoints ----------
  async function refreshTree() {
    const box = $('gvProjects');
    if (!box) return;
    if (!activeProject) { box.innerHTML = '<span class="gv-muted">No project open</span>'; return; }
    box.innerHTML = '';
    try {
      const files = await pv.projectListFiles('');
      for (const f of files.slice(0, 200)) {
        const row = document.createElement('div');
        row.className = 'gv-file' + (f.type === 'dir' ? ' dir' : '');
        row.textContent = (f.type === 'dir' ? '📁 ' : '📄 ') + f.path;
        box.appendChild(row);
      }
      if (files.length === 0) box.innerHTML = '<span class="gv-muted">Empty project</span>';
    } catch (e) {
      box.innerHTML = '<span class="gv-muted">Cannot list files</span>';
    }
  }

  async function refreshCheckpoints() {
    const box = $('gvCheckpoints');
    if (!box) return;
    if (!activeProject) { box.innerHTML = '<span class="gv-muted">None yet</span>'; return; }
    let list = [];
    try { list = await pv.checkpointList(); } catch {}
    if (!list || list.length === 0) { box.innerHTML = '<span class="gv-muted">None yet</span>'; return; }
    box.innerHTML = '';
    for (const c of list.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'gv-cp';
      const label = document.createElement('span');
      label.textContent = `${c.label || c.id} (${c.kind})`;
      const btn = document.createElement('button');
      btn.className = 'gv-cp-restore';
      btn.textContent = '↩ Restore';
      btn.onclick = async () => {
        setStatus('Restoring checkpoint…');
        await pv.checkpointRestore(c.id);
        setStatus('Restored. Reload preview to see it.');
        await pv.previewReload();
        refreshTree();
      };
      row.append(label, btn);
      box.appendChild(row);
    }
  }

  // ---------- roles ----------
  async function loadRoles() {
    let ps = null;
    try {
      ps = await pv.providersList();
      fillSelect($('gvDirector'), ps.map((p) => [p.id, p.name]));
      fillSelect($('gvCritic'), ps.map((p) => [p.id, p.name]));
    } catch {}
    try {
      const cs = await pv.codingStatus();
      const dev = $('gvDeveloper');
      dev.innerHTML = '';
      const entries = Object.entries(cs || {});
      if (entries.length === 0) {
        const o = document.createElement('option');
        o.textContent = 'No coding agent installed';
        dev.appendChild(o);
      }
      for (const [id, st] of entries) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id + (st.available ? '' : ' (not installed)');
        if (!st.available) o.disabled = true;
        dev.appendChild(o);
      }
    } catch {}
    // AI providers as Developer too ("prov:<id>"): they write the files directly,
    // no coding CLI needed. Listed under a separator after the installed CLIs.
    try {
      const dev = $('gvDeveloper');
      if (dev && ps && ps.length) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '── AI providers (write files directly) ──';
        dev.appendChild(sep);
        for (const p of ps) {
          const o = document.createElement('option');
          o.value = `prov:${p.id}`;
          o.textContent = `${p.name} — AI builds the files`;
          dev.appendChild(o);
        }
      }
    } catch { /* CLI list still works */ }
    // Restore last selections.
    const d = store.get('gvDirector', 'openrouter');
    const c = store.get('gvCritic', 'openrouter');
    const a = store.get('gvDeveloper', 'claude');
    if ($('gvDirector').querySelector(`option[value="${d}"]`)) $('gvDirector').value = d;
    if ($('gvCritic').querySelector(`option[value="${c}"]`)) $('gvCritic').value = c;
    if ($('gvDeveloper').querySelector(`option[value="${a}"]`)) $('gvDeveloper').value = a;
    // Model fields: blank = let the backend pick (first free model for Director/Critic,
    // the CLI's own default for the Developer agent).
    $('gvDirectorModel').value = store.get('gvDirectorModel', '');
    $('gvCriticModel').value = store.get('gvCriticModel', '');
    $('gvDeveloperModel').value = store.get('gvDeveloperModel', '');
    // Provider change re-points the model autocomplete's rows (same mechanism Volley uses):
    // openrouter shows the full OpenRouter catalog, other providers show their own model lists.
    const swapRows = (input, provId) => {
      try { window.__vpApplyProviderRows && window.__vpApplyProviderRows(input, provId); } catch { /* autocomplete stays on the default rows */ }
    };
    $('gvDirector').addEventListener('change', () => swapRows($('gvDirectorModel'), $('gvDirector').value));
    $('gvCritic').addEventListener('change', () => swapRows($('gvCriticModel'), $('gvCritic').value));
    // Developer select: provider-developers use the provider's model namespace,
    // CLIs use their own — swap the placeholder so the field reads right either way.
    const devModel = $('gvDeveloperModel');
    const syncDevModelRows = () => {
      const v = $('gvDeveloper').value || '';
      if (v.startsWith('prov:')) {
        // Same autocomplete experience as Director/Critic: the provider's real model list.
        devModel.placeholder = `model for ${v.slice(5)} · blank = auto (prefers free)`;
        try { window.__vpApplyProviderRows && window.__vpApplyProviderRows(devModel, v.slice(5)); } catch { /* keep default rows */ }
      } else {
        // CLI agents take their own model ids (not OpenRouter ones) — no fake suggestions.
        devModel.placeholder = 'CLI model · blank = agent default';
        try { window.__vpSetModelRows && window.__vpSetModelRows(devModel, []); } catch { /* keep default rows */ }
      }
    };
    $('gvDeveloper').addEventListener('change', syncDevModelRows);
    syncDevModelRows();
    // Persist model choices as soon as they're set (not just on build).
    for (const id of ['gvDirectorModel', 'gvCriticModel', 'gvDeveloperModel']) {
      $(id).addEventListener('change', () => store.set(id, $(id).value.trim()));
    }
  }

  function fillSelect(sel, pairs) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const [val, label] of pairs) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      sel.appendChild(o);
    }
  }

  function currentRoles() {
    return {
      creativeDirector: { provider: $('gvDirector').value, model: $('gvDirectorModel').value.trim() || null },
      critic: { provider: $('gvCritic').value, model: $('gvCriticModel').value.trim() || null },
      developer: { agent: $('gvDeveloper').value, model: $('gvDeveloperModel').value.trim() || null },
    };
  }

  // ---------- project open / create ----------
  async function chooseDir() {
    try { return await pv.openDir(); } catch { return null; }
  }

  async function openExisting() {
    const dir = await chooseDir();
    if (!dir) return;
    await pv.projectOpen(dir);
    activeProject = await pv.projectGetActive();
    onProjectOpened();
  }

  async function onProjectOpened() {
    $('gvProjectName').textContent = activeProject ? activeProject.name : 'No project open';
    await refreshTree();
    await refreshCheckpoints();
    setStatus('Project open. Create or Improve when ready.');
    // If it already has a playable entry, show it.
    try { const r = await pv.previewLoad(); if (r && r.ok) addActivity('Loaded existing game into preview.', 'ok'); }
    catch (e) { /* nothing playable yet */ }
  }

  async function startCreate() {
    const idea = $('gvIdea').value.trim();
    if (!idea) { setStatus('Describe the game you want first.', 'err'); return; }
    const dir = await chooseDir();
    if (!dir) return;
    await pv.projectCreate(dir, { idea });
    activeProject = await pv.projectGetActive();
    await refreshTree();
    $('gvProjectName').textContent = activeProject.name;
    store.set('gvDirector', $('gvDirector').value);
    store.set('gvCritic', $('gvCritic').value);
    store.set('gvDeveloper', $('gvDeveloper').value);
    store.set('gvDirectorModel', $('gvDirectorModel').value.trim());
    store.set('gvCriticModel', $('gvCriticModel').value.trim());
    store.set('gvDeveloperModel', $('gvDeveloperModel').value.trim());
    beginBuild({ mode: 'create', idea, projectPath: dir });
  }

  async function startImprove() {
    const idea = $('gvIdea').value.trim();
    if (!idea) { setStatus('Tell GameVolley what to change.', 'err'); return; }
    if (!activeProject) { setStatus('Open a project first.', 'err'); return; }
    beginBuild({ mode: 'improve', idea, projectPath: activeProject.path });
  }

  async function startFix() {
    const idea = $('gvIdea').value.trim();
    if (!idea) { setStatus('Describe the bug.', 'err'); return; }
    if (!activeProject) { setStatus('Open a project first.', 'err'); return; }
    beginBuild({ mode: 'fix', report: idea, projectPath: activeProject.path });
  }

  async function beginBuild(cfg) {
      if (building) { setStatus('A build is already running. Stop it first.', 'err'); return; }
      building = true;
      resetAgentCards();
      $('gvStop').classList.remove('hidden');
      $('gvCreate').disabled = true;
      setStatus('Starting…');
      addActivity(`▶ ${cfg.mode === 'create' ? 'Creating' : cfg.mode === 'improve' ? 'Improving' : 'Fixing'}: ${cfg.idea || cfg.report}`, 'cmd');
      try {
        const res = await pv.agentStart({ ...cfg, roles: currentRoles(), maxRounds: 3 });
        if (!res || !res.ok) setStatus(res && res.message ? res.message : 'Could not start.', 'err');
      } catch (e) {
        setStatus('Error: ' + (e.message || e), 'err');
        building = false;
        $('gvStop').classList.add('hidden');
        $('gvCreate').disabled = false;
      }
    }

    async function stopBuild() {
      try { await pv.agentCancel(); } catch {}
      setStatus('Stopping…');
    }

    // ---------- live events from the orchestration ----------
    function handleEvent(ev) {
      if (!ev || !ev.type) return;
      switch (ev.type) {
        case 'progress':
          closeLiveLine();
          setStatus(`Phase: ${ev.phase} (round ${ev.round}/${ev.maxRounds})`);
          break;
        case 'agent:status':
          closeLiveLine();
          addActivity(`${roleLabel(ev.role)}: ${ev.status} — ${ev.message || ''}`, ev.status === 'error' ? 'err' : '');
          // Update agent card
          if (ev.role === 'director' || ev.role === 'developer' || ev.role === 'critic') {
            if (ev.status === 'working') {
              startAgentTimer(ev.role);
            } else if (ev.status === 'done') {
              stopAgentTimer(ev.role, 'done');
            } else if (ev.status === 'error') {
              stopAgentTimer(ev.role, 'error');
            }
          }
          break;
        case 'agent:output':
          // Token-chunk deltas stream into one live line per role.
          appendStreamDelta(ev.role, ev.text);
          // Also append to agent card
          if (ev.role === 'director' || ev.role === 'developer' || ev.role === 'critic') {
            appendAgentOutput(ev.role, ev.text);
          }
          break;
        case 'stage':
          closeLiveLine();
          addActivity(`— ${ev.stage}${ev.detail ? ` (${ev.detail})` : ''}`, 'cmd');
          break;
        case 'project:changed':
          closeLiveLine();
          addActivity(`  ✓ ${ev.operation} ${ev.path}`, 'file');
          break;
        case 'preview:load':
          $('gvPreviewEmpty') && $('gvPreviewEmpty').classList.add('hidden');
          addActivity('Preview loading…', 'ok');
          layoutPreview();
          break;
        case 'preview:ready':
          setStatus('Game is live in the preview ▶', 'ok');
          addActivity('Preview ready.', 'ok');
          break;
        case 'preview:error':
          addActivity('Preview error: ' + (ev.message || ev.code || 'unknown'), 'err');
          setStatus('Preview failed to load.', 'err');
          break;
        case 'review:result':
          addActivity(`  ⚠ [${ev.severity}] ${ev.message}`, ev.severity === 'HIGH' ? 'err' : 'warn');
          break;
        case 'game:done': {
          const r = ev.result || {};
          $('gvStop').classList.add('hidden');
          $('gvCreate').disabled = false;
          building = false;
          // Reset all agent cards to idle after a brief moment
          setTimeout(resetAgentCards, 2000);
          const issues = (r.knownIssues || []).map((m) => '• ' + m).join('\n');
          addActivity(`✔ Build complete in ${r.rounds || '?'} round(s).${issues ? '\nRemaining issues:\n' + issues : ''}`, 'ok');
          setStatus('Done — play it above.', 'ok');
          break;
        }
        case 'error':
          addActivity('Error: ' + ev.message, 'err');
          setStatus('Error: ' + ev.message, 'err');
          break;
        case 'agent:idle':
          $('gvStop').classList.add('hidden');
          $('gvCreate').disabled = false;
          building = false;
          break;
      }
    }

    function roleLabel(role) {
        return { director: '🎬 Director', developer: '🛠 Developer', critic: '🔍 Critic' }[role] || role;
      }

      // ---------- wiring ----------
      function wire() {
        $('tabGame').onclick = () => setView('game');
        $('tabVolley').onclick = () => setView('volley');
        $('gvNew').onclick = startCreate;
        $('gvOpen').onclick = openExisting;
        $('gvCreate').onclick = startCreate;
        $('gvImprove').onclick = startImprove;
        $('gvFix').onclick = startFix;
        $('gvStop').onclick = stopBuild;
        $('gvReload').onclick = () => { try { pv.previewReload(); } catch {} };
        $('gvFull').onclick = () => {
          try {
            pv.previewFullscreen();
            isFullscreen = !isFullscreen;
            saveFullscreenState({ enabled: isFullscreen });
            $('gvFull').classList.toggle('active', isFullscreen);
            // Re-layout after fullscreen transition.
            setTimeout(layoutPreview, 300);
          } catch {}
        };
        $('gvOpenFolder').onclick = () => { try { pv.projectOpenFolder(); } catch {} };
        layoutPreview();
      }

      async function boot() {
        wire();
        // Default to the GameVolley workspace. Volley remains one click away.
        setView('game');
        try { await loadRoles(); } catch {}
        // Subscribe to streaming orchestration events.
        if (window.pv && pv.gameOnEvent) {
          pv.gameOnEvent((ev) => handleEvent(ev));
        }
        // Reflect any project already open from a previous session.
        try {
          activeProject = await pv.projectGetActive();
          if (activeProject) onProjectOpened();
        } catch {}
        // Restore fullscreen state if it was enabled.
        applyPersistedFullscreen();
      }

      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();

      // Expose a tiny API for the smoke test / debugging.
      window.__gamevolley = { setView, layoutPreview, currentRoles, handleEvent };
    })();
