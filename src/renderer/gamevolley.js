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
    if (window.__gvHistory && window.__gvHistory.isOpen()) return; // preview is parked off-screen
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
    const LOG_MAX_LINES = 500; // Bounded log size

    // Filter state
    let activityRoleFilter = ''; // 'director', 'developer', 'critic', 'system', or ''
    let activitySearchQuery = '';

    function closeLiveLine() { liveLine = null; liveRole = null; }

    function getLineRole(line) {
      // Determine the role from the line's content/classes
      const text = line.textContent;
      if (line.classList.contains('gv-stream')) {
        const tag = line.querySelector('.gv-stream-tag');
        if (tag) {
          const roleText = tag.textContent.trim().toLowerCase();
          if (roleText.startsWith('director')) return 'director';
          if (roleText.startsWith('developer')) return 'developer';
          if (roleText.startsWith('critic')) return 'critic';
        }
      }
      // Check for role prefixes in the text
      if (text.startsWith('🎬 Director') || text.startsWith('Director:')) return 'director';
      if (text.startsWith('🛠 Developer') || text.startsWith('Developer:')) return 'developer';
      if (text.startsWith('🔍 Critic') || text.startsWith('Critic:')) return 'critic';
      // System messages (commands, file ops, status, errors without role prefix)
      return 'system';
    }

    function matchesFilters(line) {
      if (activityRoleFilter) {
        const lineRole = getLineRole(line);
        if (lineRole !== activityRoleFilter) return false;
      }
      if (activitySearchQuery) {
        const text = line.textContent.toLowerCase();
        if (!text.includes(activitySearchQuery)) return false;
      }
      return true;
    }

    function applyFilters() {
      const log = $('gvActivity');
      if (!log) return;
      for (const line of log.children) {
        if (line.classList.contains('gv-log-line')) {
          line.classList.toggle('hidden-by-filter', !matchesFilters(line));
        }
      }
    }

    function addActivity(text, cls, role) {
      const log = $('gvActivity');
      if (!log) return;
      const line = document.createElement('div');
      line.className = 'gv-log-line' + (cls ? ' ' + cls : '');
      if (role) line.dataset.role = role;
      line.textContent = text;
      log.appendChild(line);
      // Apply current filters to the new line
      if (!matchesFilters(line)) line.classList.add('hidden-by-filter');
      // Bound the log size
      while (log.children.length > LOG_MAX_LINES) log.removeChild(log.firstChild);
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
        liveLine.dataset.role = role;
        const tag = document.createElement('span');
        tag.className = 'gv-stream-tag';
        tag.textContent = `${roleLabel(role)}: `;
        const body = document.createElement('span');
        body.textContent = text;
        liveLine.appendChild(tag);
        liveLine.appendChild(body);
        log.appendChild(liveLine);
        // Apply current filters
        if (!matchesFilters(liveLine)) liveLine.classList.add('hidden-by-filter');
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

    // Wire up activity controls
    function wireActivityControls() {
      const roleFilter = $('gvActivityRoleFilter');
      const searchInput = $('gvActivitySearch');
      const clearBtn = $('gvActivityClear');

      if (roleFilter) {
        roleFilter.addEventListener('change', () => {
          activityRoleFilter = roleFilter.value;
          applyFilters();
        });
      }
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          activitySearchQuery = searchInput.value.toLowerCase();
          applyFilters();
        });
      }
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          const log = $('gvActivity');
          if (log) {
            log.innerHTML = '';
            closeLiveLine();
          }
        });
      }
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
          clearChanges();
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

        // ---------- changes & diff panel ----------
        const changesLog = $('gvChanges');
        const changesClearBtn = $('gvChangesClear');
        const MAX_CHANGES = 50;

        function addChange(path, operation, diff) {
          if (!changesLog) return;
          // Remove empty state if present
          const emptyState = changesLog.querySelector('.gv-muted');
          if (emptyState) emptyState.remove();

          const item = document.createElement('div');
          item.className = 'gv-change-item';
          const opClass = operation === 'created' ? 'created' : operation === 'modified' ? 'modified' : 'deleted';
          let diffHtml = '';
          if (diff) {
            const lines = diff.split('\n').slice(0, 30).map(line => {
              if (line.startsWith('+')) return `<div class="gv-change-diff-line added">${escapeHtml(line)}</div>`;
              if (line.startsWith('-')) return `<div class="gv-change-diff-line removed">${escapeHtml(line)}</div>`;
              return `<div class="gv-change-diff-line context">${escapeHtml(line)}</div>`;
            }).join('');
            diffHtml = `<div class="gv-change-diff">${lines}</div>`;
          }
          item.innerHTML = `
            <div class="gv-change-path">${escapeHtml(path)}</div>
            <span class="gv-change-op ${opClass}">${operation}</span>
            ${diffHtml}
          `;
          changesLog.insertBefore(item, changesLog.firstChild);
          // Limit number of changes shown
          while (changesLog.children.length > MAX_CHANGES) {
            changesLog.removeChild(changesLog.lastChild);
          }
        }

        function clearChanges() {
          if (!changesLog) return;
          changesLog.innerHTML = '<span class="gv-muted">No changes yet</span>';
        }

        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }

        // Wire up clear button
        if (changesClearBtn) {
          changesClearBtn.onclick = clearChanges;
        }

        // ---------- project tree / checkpoints ----------
  // ---------- project tree / checkpoints ----------
    async function refreshTree() {
      const box = $('gvProjects');
      const searchInput = $('gvProjectsSearch');
      if (!box) return;
      if (!activeProject) { box.innerHTML = '<span class="gv-muted">No project open</span>'; return; }
      box.innerHTML = '';
      try {
        const files = await pv.projectListFiles('');
        // Build tree structure
        const root = buildFileTree(files);
        renderTree(root, box);
        // Wire up search
        if (searchInput) {
          searchInput.oninput = () => filterTree(searchInput.value.toLowerCase());
        }
      } catch (e) {
        box.innerHTML = '<span class="gv-muted">Cannot list files</span>';
      }
    }

    function buildFileTree(files) {
      const root = { name: '', path: '', type: 'dir', children: new Map() };
      for (const f of files) {
        const parts = f.path.split('/').filter(Boolean);
        let node = root;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const isLast = i === parts.length - 1;
          const fullPath = parts.slice(0, i + 1).join('/');
          if (!node.children.has(part)) {
            node.children.set(part, {
              name: part,
              path: fullPath,
              type: isLast ? f.type : 'dir',
              children: new Map(),
              loaded: false,
              element: null
            });
          }
          node = node.children.get(part);
          if (isLast) {
            node.type = f.type;
          }
        }
      }
      return root;
    }

    function renderTree(node, container, depth = 0) {
      // Sort: directories first, then files, alphabetically
      const entries = Array.from(node.children.entries()).sort((a, b) => {
        const aIsDir = a[1].type === 'dir';
        const bIsDir = b[1].type === 'dir';
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a[0].localeCompare(b[0]);
      });

      for (const [name, child] of entries) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'gv-tree-node';
        nodeEl.dataset.path = child.path;

        const isDir = child.type === 'dir';
        const hasChildren = isDir && child.children.size > 0;

        const header = document.createElement('div');
        header.className = 'gv-tree-node-header';
        if (depth > 0) header.style.paddingLeft = `${6 + depth * 8}px`;

        const toggle = document.createElement('span');
        toggle.className = 'gv-tree-toggle' + (hasChildren ? '' : ' hidden');
        toggle.textContent = '▶';
        toggle.dataset.path = child.path;
        if (hasChildren) toggle.classList.add('collapsed');

        const icon = document.createElement('span');
        icon.className = 'gv-tree-icon';
        icon.textContent = isDir ? '📁' : getFileIcon(child.name);

        const name = document.createElement('span');
        name.className = 'gv-tree-name' + (isDir ? ' dir' : '');
        name.textContent = child.name;

        header.append(toggle, icon, name);
        nodeEl.appendChild(header);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'gv-tree-children';
        childrenContainer.dataset.path = child.path;
        nodeEl.appendChild(childrenContainer);

        container.appendChild(nodeEl);
        child.element = { header, childrenContainer, toggle };

        // Click handler for toggle
        if (hasChildren) {
          header.onclick = (e) => {
            if (e.target === toggle || e.target === header) {
              toggleTreeNode(child.path);
            }
          };
        }
      }
    }

    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      const icons = {
        js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
        html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', sass: '🎨',
        json: '📋', md: '📝', txt: '📄',
        png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼', svg: '🖼',
        mp3: '🎵', wav: '🎵', ogg: '🎵',
        mp4: '🎬', webm: '🎬',
        py: '🐍', rs: '🦀', go: '🐹', java: '☕', cpp: '⚙', c: '⚙', h: '⚙',
        sh: '💻', bat: '💻', cmd: '💻',
        yml: '⚙', yaml: '⚙', toml: '⚙', ini: '⚙', cfg: '⚙',
      };
      return icons[ext] || '📄';
    }

    async function toggleTreeNode(path) {
      // Find the node data
      const nodeEl = document.querySelector(`.gv-tree-node[data-path="${escapeSelector(path)}"]`);
      if (!nodeEl) return;
      const childrenContainer = nodeEl.querySelector('.gv-tree-children');
      const toggle = nodeEl.querySelector('.gv-tree-toggle');
      if (!childrenContainer || !toggle) return;

      const isExpanded = childrenContainer.classList.contains('expanded');
      if (isExpanded) {
        childrenContainer.classList.remove('expanded');
        toggle.classList.add('collapsed');
        return;
      }

      // Expand - load children if not loaded
      if (!childrenContainer.dataset.loaded) {
        childrenContainer.innerHTML = '<div class="gv-muted" style="padding: 4px 8px; font-size: 11px;">Loading…</div>';
        try {
          const files = await pv.projectListFiles(path);
          // Build children tree
          const childNode = { name: '', path, type: 'dir', children: new Map() };
          for (const f of files) {
                      const relPath = f.path.startsWith(path + '/') ? f.path.slice(path.length + 1) : f.path;
                      const parts = relPath.split('/').filter(Boolean);
                      let node = childNode;
                      for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        const isLast = i === parts.length - 1;
                        const fullPath = path + '/' + parts.slice(0, i + 1).join('/');
                        if (!node.children.has(part)) {
                          node.children.set(part, {
                            name: part,
                            path: fullPath,
                            type: isLast ? f.type : 'dir',
                            children: new Map(),
                            loaded: false,
                            element: null
                          });
                        }
                        node = node.children.get(part);
                        if (isLast) node.type = f.type;
                      }
                    }
                    renderTree(childNode, childrenContainer, 1);
          childrenContainer.dataset.loaded = 'true';
        } catch (e) {
          childrenContainer.innerHTML = '<div class="gv-muted" style="padding: 4px 8px; font-size: 11px;">Error loading</div>';
        }
      }
      childrenContainer.classList.add('expanded');
      toggle.classList.remove('collapsed');
    }

    function filterTree(query) {
      const box = $('gvProjects');
      if (!box) return;
      const nodes = box.querySelectorAll('.gv-tree-node');
      nodes.forEach(node => {
        const nameEl = node.querySelector('.gv-tree-name');
        if (!nameEl) return;
        const name = nameEl.textContent.toLowerCase();
        const path = node.dataset.path.toLowerCase();
        const match = query === '' || name.includes(query) || path.includes(query);
        node.style.display = match ? '' : 'none';
        // If a child matches, show parent too
        if (match && query !== '') {
          let parent = node.parentElement.closest('.gv-tree-node');
          while (parent) {
            parent.style.display = '';
            parent = parent.parentElement.closest('.gv-tree-node');
          }
        }
      });
    }

    function escapeSelector(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        if (building) { setStatus('Stop the running build before restoring.', 'err'); return; }
        const question = `Restore "${c.label || c.id}"?\n\nFiles added or changed since then will be taken out of the project and kept in a recovery folder, not deleted. A "before restore" checkpoint is saved so you can switch back.`;
        if (!window.confirm(question)) return;
        setStatus('Restoring checkpoint…');
        let res;
        try { res = await pv.checkpointRestore(c.id); }
        catch (e) { res = { ok: false, message: e.message || String(e) }; }
        if (!res || !res.ok) { setStatus((res && res.message) || 'Restore failed.', 'err'); return; }
        addActivity(`↩ ${res.message || 'Restored.'}`, 'ok', 'system');
        setStatus('Restored. See Agent activity for details.', 'ok');
        await pv.previewReload();
        refreshTree();
        refreshCheckpoints();
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
    // Max rounds (1-5, backend clamps further): restored, persisted, sent per build.
    const roundsSel = $('gvRounds');
    if (roundsSel) {
      for (let n = 1; n <= 5; n++) {
        const o = document.createElement('option');
        o.value = String(n); o.textContent = `${n} round${n === 1 ? '' : 's'}`;
        roundsSel.appendChild(o);
      }
      roundsSel.value = String(Math.min(5, Math.max(1, Math.floor(Number(store.get('gvMaxRounds', '3')) || 3))));
      roundsSel.addEventListener('change', () => store.set('gvMaxRounds', roundsSel.value));
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
    try { const r = await pv.previewLoad(); if (r && r.ok) addActivity('Loaded existing game into preview.', 'ok', 'system'); }
    catch (e) { /* nothing playable yet */ }
  }

  async function startCreate() {
    const idea = $('gvIdea').value.trim();
    if (!idea) { setStatus('Describe the game you want first.', 'err'); return; }
    const dir = await chooseDir();
    if (!dir) return;
    try {
      await pv.projectCreate(dir, { idea });
    } catch (e) {
      // Electron wraps main-process errors; show the user just the reason.
      const why = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      addActivity(why, 'err', 'system');
      setStatus(why, 'err');
      return;
    }
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
      addActivity(`▶ ${cfg.mode === 'create' ? 'Creating' : cfg.mode === 'improve' ? 'Improving' : 'Fixing'}: ${cfg.idea || cfg.report}`, 'cmd', 'system');
      try {
        const maxRounds = Math.min(5, Math.max(1, Math.floor(Number(store.get('gvMaxRounds', '3')) || 3)));
        const res = await pv.agentStart({ ...cfg, roles: currentRoles(), maxRounds });
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
                  addActivity(`${roleLabel(ev.role)}: ${ev.status} — ${ev.message || ''}`, ev.status === 'error' ? 'err' : '', ev.role);
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
          addActivity(`— ${ev.stage}${ev.detail ? ` (${ev.detail})` : ''}`, 'cmd', 'system');
          break;
        case 'project:changed':
                closeLiveLine();
                addActivity(`  ✓ ${ev.operation} ${ev.path}`, 'file', 'system');
                // Update changes & diff panel
                addChange(ev.path, ev.operation, ev.diff);
                break;
        case 'preview:load':
                  $('gvPreviewEmpty') && $('gvPreviewEmpty').classList.add('hidden');
                  addActivity('Preview loading…', 'ok', 'system');
                  layoutPreview();
                  break;
                case 'preview:ready':
                  setStatus('Game is live in the preview ▶', 'ok');
                  addActivity('Preview ready.', 'ok', 'system');
                  break;
                case 'preview:error':
                  addActivity('Preview error: ' + (ev.message || ev.code || 'unknown'), 'err', 'system');
                  setStatus('Preview failed to load.', 'err');
          break;
        case 'restored':
          closeLiveLine();
          addActivity(`↩ ${ev.message || 'Rolled back.'}`, 'warn', 'system');
          break;
        case 'review:result':
                  addActivity(`  ⚠ [${ev.severity}] ${ev.message}`, ev.severity === 'HIGH' ? 'err' : 'warn', 'critic');
                  break;
                case 'game:done': {
                  const r = ev.result || {};
                  $('gvStop').classList.add('hidden');
                  $('gvCreate').disabled = false;
                  building = false;
                  // Reset all agent cards to idle after a brief moment
                  setTimeout(resetAgentCards, 2000);
                  const issues = (r.knownIssues || []).map((m) => '• ' + m).join('\n');
                  const remaining = issues ? '\nRemaining issues:\n' + issues : '';
                  // A build that runs out of rounds also ends in game:done, with completed: false.
                  if (r.completed === false) {
                    const why = r.reason ? `\n${r.reason}` : '';
                    addActivity(`✖ Build didn’t pass after ${r.rounds || '?'} round(s).${why}${remaining}`, 'err', 'system');
                    setStatus('Didn’t pass review — see Agent activity.', 'err');
                  } else {
                    addActivity(`✔ Build complete in ${r.rounds || '?'} round(s).${remaining}`, 'ok', 'system');
                    setStatus('Done — play it above.', 'ok');
                  }
                  break;
                }
                case 'error':
                  addActivity('Error: ' + ev.message, 'err', 'system');
                  setStatus('Error: ' + ev.message, 'err');
          break;
        case 'agent:idle':
          $('gvStop').classList.add('hidden');
          $('gvCreate').disabled = false;
          building = false;
          window.__gvHistory && window.__gvHistory.refresh();
          break;
      }
    }

    function roleLabel(role) {
        return { director: '🎬 Director', developer: '🛠 Developer', critic: '🔍 Critic' }[role] || role;
      }

      // Chromium opens a file dropped outside a drop zone in this window. The main
      // process blocks that navigation; this also shows the "can't drop here" cursor.
      function refuseStrayFileDrops() {
        for (const type of ['dragover', 'drop']) {
          window.addEventListener(type, (e) => {
            if (e.defaultPrevented || !e.dataTransfer) return; // a real drop zone took it
            if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
            if (e.target && e.target.matches && e.target.matches('input[type="file"]')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
          });
        }
      }

      // ---------- wiring ----------
      function wire() {
        refuseStrayFileDrops();
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
        if (window.GvHistoryUI) {
          window.__gvHistory = window.GvHistoryUI.create({
            layoutPreview,
            isBuilding: () => building,
            async openProject(dir) {
              await pv.projectOpen(dir);
              activeProject = await pv.projectGetActive();
              setView('game');
              await onProjectOpened();
            },
          });
        }
        layoutPreview();
      }

      async function boot() {
              wire();
              wireActivityControls();
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
