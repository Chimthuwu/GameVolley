// app-core.js — Shared UI core for both Electron renderer and web
// This file is processed by build-shared.mjs with conditional blocks:
//   // @if:renderer ... // @endif  — only in Electron build
//   // @if:web ... // @endif      — only in web build
//   // @platform:renderer ...    — single line only in Electron build
//   // @platform:web ...         — single line only in web build

// ---- Store utilities --------------------------------------------------------
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---- Toast system -----------------------------------------------------------
function toast(msg, ms = 6000) {
  const box = document.getElementById('toasts');
  if (!box) return;
  while (box.children.length >= 3) box.firstElementChild.remove();
  const t = document.createElement('div');
  t.className = 'toast-item';
  t.textContent = msg;
  t.onclick = () => t.remove();
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---- Theme system -----------------------------------------------------------
const THEME_BASE_HSL = {
  '--neon-cyan': [183, 100, 46],
  '--neon-magenta': [344, 83, 52],
  '--neon-green': [156, 100, 45],
  '--neon-purple': [275, 83, 52],
};
const THEME_SURFACE_HSL = {
  '--bg': [252, 50, 4],
  '--bg-glow': [251, 65, 17],
  '--card': [252, 49, 10],
  '--titlebar-from': [253, 60, 6],
  '--panel': [275, 55, 8],
  '--panel-hi': [263, 66, 17],
};

function applyTheme({ hue, sat, contrast }) {
  const root = document.documentElement.style;
  const satF = sat / 100;
  const satOf = (s, l) => {
    const s2 = Math.min(100, Math.max(0, s * satF));
    const l2 = satF > 1 ? l - (l - 50) * (satF - 1) * 0.35 : l;
    return [s2, Math.min(100, Math.max(0, l2))];
  };
  const conF = contrast / 100;
  const conOf = (l) => {
    const v = ((l / 100) - 0.5) * conF + 0.5;
    return Math.min(100, Math.max(0, v * 100));
  };
  for (const [name, [h, s, l]] of Object.entries(THEME_BASE_HSL)) {
    const newH = ((h + hue) % 360 + 360) % 360;
    const [newS, newL] = satOf(s, conOf(l));
    root.setProperty(name, `hsl(${newH.toFixed(0)}, ${newS.toFixed(0)}%, ${newL.toFixed(0)}%)`);
  }
  for (const [name, [h, s, l]] of Object.entries(THEME_SURFACE_HSL)) {
    const newH = ((h + hue) % 360 + 360) % 360;
    const [newS, newL] = satOf(s, conOf(l));
    root.setProperty(name, `hsl(${newH.toFixed(0)}, ${newS.toFixed(0)}%, ${newL.toFixed(0)}%)`);
  }
  const fh = ((252 + hue) % 360 + 360) % 360;
  const [fs, fl] = satOf(50, conOf(4));
  root.setProperty('--field', `hsla(${fh.toFixed(0)}, ${fs.toFixed(0)}%, ${fl.toFixed(0)}%, 0.7)`);
  const wh = ((270 + hue) % 360 + 360) % 360;
  const [ws, wl] = satOf(71, conOf(27));
  root.setProperty('--bg-wash', `hsla(${wh.toFixed(0)}, ${ws.toFixed(0)}%, ${Math.min(40, wl).toFixed(0)}%, 0.35)`);
  const [ph, ps0] = THEME_BASE_HSL['--neon-purple'];
  const h2 = ((ph + hue) % 360 + 360) % 360;
  const [s2, l2] = satOf(ps0, 50);
  root.setProperty('--line', `hsla(${h2.toFixed(0)}, ${s2.toFixed(0)}%, ${l2.toFixed(0)}%, 0.3)`);
  root.setProperty('--line-glow', `hsla(${h2.toFixed(0)}, ${s2.toFixed(0)}%, ${l2.toFixed(0)}%, 0.8)`);
  document.dispatchEvent(new Event('vp-theme'));
}

// ---- Escape HTML ------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
}

// ---- Settings management ----------------------------------------------------
const SETTINGS_KEY = 'vpSettings';
const loadSettings = () => { try { return JSON.parse(store.get(SETTINGS_KEY, '{}')) || {}; } catch { return {}; } };
const saveSettings = (o) => store.set(SETTINGS_KEY, JSON.stringify(o));

// ---- Model autocomplete -----------------------------------------------------
let MODEL_ROWS = [];
let MODEL_ROWS_BY_INPUT = new WeakMap();

async function setupModelAutocomplete(input) {
  const list = document.createElement('div');
  list.className = 'model-ac hidden';
  document.body.appendChild(list);
  let items = [], pickIdx = -1, allModelsMode = false, freshFocus = false;
  if (!MODEL_ROWS_BY_INPUT.has(input)) MODEL_ROWS_BY_INPUT.set(input, { rows: [], allRows: null });
  const rowsFor = () => MODEL_ROWS_BY_INPUT.get(input);

  const close = () => { list.classList.add('hidden'); pickIdx = -1; };
  const choose = (row) => {
    input.value = row.id;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close(); input.blur();
  };

  function render() {
    const q = freshFocus ? '' : input.value.trim().toLowerCase();
    const source = allModelsMode && rowsFor().allRows ? rowsFor().allRows : rowsFor().rows;
    items = source.filter((row) => !q || row.id.toLowerCase().includes(q));
    if (!allModelsMode) items = items.slice(0, 300);
    pickIdx = -1;
    list.textContent = '';
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'model-ac-more';
    more.textContent = allModelsMode ? '← Back to free & low-cost models' : '＋ More models · show all (including paid)';
    more.addEventListener('mousedown', (e) => e.preventDefault());
    more.addEventListener('click', async () => {
      input.value = '';
      if (allModelsMode) { allModelsMode = false; render(); return; }
      allModelsMode = true;
      more.disabled = true; more.textContent = 'Loading full model catalog…';
      try { rowsFor().allRows = (await pv.models({ all: true })) || []; }
      catch { allModelsMode = false; toast('Could not load the full model list.', 6000); }
      render();
    });
    list.appendChild(more);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'model-ac-empty';
      empty.textContent = q ? 'No matching models' : 'No models available (offline?)';
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      const item = document.createElement('div');
      item.className = 'model-ac-item';
      item.dataset.i = String(i);
      const id = document.createElement('span');
      id.className = 'model-ac-id';
      id.textContent = row.id;
      const badge = document.createElement('span');
      if (row.isFree) { badge.className = 'ac-badge free'; badge.textContent = 'FREE'; }
      else if (row.isStealth) { badge.className = 'ac-badge stealth'; badge.textContent = 'STEALTH'; }
      else if (row.perM) { badge.className = 'ac-badge'; badge.textContent = '$' + row.perM.toFixed(2) + '/M'; }
      item.append(id, badge);
      list.appendChild(item);
    }
    const r = input.getBoundingClientRect();
    list.style.left = r.left + 'px';
    list.style.top = r.bottom + 2 + 'px';
    list.style.minWidth = r.width + 'px';
  }

  const open = () => { render(); list.classList.remove('hidden'); };
  const updatePick = () => {
    [...list.querySelectorAll('.model-ac-item')].forEach((el, i) => {
      el.classList.toggle('picked', i === pickIdx);
      if (i === pickIdx) el.scrollIntoView({ block: 'nearest' });
    });
  };

  input.addEventListener('focus', () => { freshFocus = true; open(); });
  input.addEventListener('input', () => { freshFocus = false; open(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  window.addEventListener('scroll', (e) => { if (!list.contains(e.target)) close(); }, true);
  window.addEventListener('resize', close);
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const it = e.target.closest('.model-ac-item');
    if (it) choose(items[+it.dataset.i]);
  });
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); pickIdx = Math.min(items.length - 1, pickIdx + 1); updatePick(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pickIdx = Math.max(-1, pickIdx - 1); updatePick(); }
    else if (e.key === 'Enter' && pickIdx >= 0) { e.preventDefault(); choose(items[pickIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  if (!window.__defaultModelRows) window.__defaultModelRows = pv.models().catch(() => []);
  try { rowsFor().rows = (await window.__defaultModelRows) || []; } catch {}
}

// Provider-aware row swapping (used by GameVolley role fields)
window.__vpApplyProviderRows = async (input, providerId) => {
  if (!input || !MODEL_ROWS_BY_INPUT.has(input)) return;
  if (providerId === 'openrouter') {
    if (!window.__defaultModelRows) window.__defaultModelRows = pv.models().catch(() => []);
    try { MODEL_ROWS_BY_INPUT.get(input).rows = (await window.__defaultModelRows) || []; } catch {}
  } else {
    MODEL_ROWS_BY_INPUT.get(input).rows = await loadProviderModels(providerId);
  }
};

window.__vpSetModelRows = (input, rows) => {
  if (!input || !MODEL_ROWS_BY_INPUT.has(input)) return;
  MODEL_ROWS_BY_INPUT.get(input).rows = rows || [];
};

// ---- Multi-provider support -------------------------------------------------
let PROVIDER_LIST = [];
const PROVIDER_MODEL_CACHE = {};
const PROVIDER_PAIRS = {
  author: 'authorProvider', critic: 'criticProvider',
  setWriter: 'setWriterProvider', setCritic: 'setCriticProvider', setFallback: 'setFallbackProvider',
};

async function loadProviderModels(id) {
  if (PROVIDER_MODEL_CACHE[id]) return PROVIDER_MODEL_CACHE[id];
  try { PROVIDER_MODEL_CACHE[id] = await pv.providerModels(id); } catch { PROVIDER_MODEL_CACHE[id] = []; }
  return PROVIDER_MODEL_CACHE[id];
}

async function populateProviderSelects() {
  if (!PROVIDER_LIST.length) { try { PROVIDER_LIST = (await pv.providersList()) || []; } catch { PROVIDER_LIST = []; } }
  for (const selId of Object.values(PROVIDER_PAIRS)) {
    const sel = document.getElementById(selId);
    if (!sel || sel.options.length) continue;
    for (const p of PROVIDER_LIST) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    }
  }
  const set = (selId, key) => { const sel = document.getElementById(selId); if (sel) sel.value = store.get(key, 'openrouter'); };
  set('authorProvider', 'authorProvider'); set('criticProvider', 'criticProvider');
  set('setWriterProvider', 'authorProvider'); set('setCriticProvider', 'criticProvider'); set('setFallbackProvider', 'fallbackProvider');
  await applyAllProviderRows();
}

async function applyProviderToField(input, providerId) {
  if (!input || !MODEL_ROWS_BY_INPUT.has(input)) return;
  if (providerId === 'openrouter') {
    if (!window.__defaultModelRows) window.__defaultModelRows = pv.models().catch(() => []);
    try { MODEL_ROWS_BY_INPUT.get(input).rows = (await window.__defaultModelRows) || []; } catch {}
  } else {
    MODEL_ROWS_BY_INPUT.get(input).rows = await loadProviderModels(providerId);
  }
}

async function applyAllProviderRows() {
  for (const [inputId, selId] of Object.entries(PROVIDER_PAIRS)) {
    const input = document.getElementById(inputId), sel = document.getElementById(selId);
    if (input && sel) await applyProviderToField(input, sel.value);
  }
}

function wireProviderSelect(inputId, selId, storeKey) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.addEventListener('change', async () => {
    store.set(storeKey, sel.value);
    await applyProviderToField(document.getElementById(inputId), sel.value);
  });
}

// ---- Model pairs ------------------------------------------------------------
const PAIRS_KEY = 'vpModelPairs';
const RECOMMENDED_PAIRS = [
  { name: 'Balanced value — DeepSeek v3.1 + Llama 3.3 70B', author: 'deepseek/deepseek-chat-v3.1', critic: 'meta-llama/llama-3.3-70b-instruct', note: 'The pair this app shipped with. A couple of cents per volley; neither model sees images, so attachments are described for the Reviewer instead.' },
  { name: 'Free & capable — Gemma 4 31B + Nemotron 3.5 VL', author: 'google/gemma-4-31b-it:free', critic: 'nvidia/nemotron-3.5-super-vl:free', note: 'Best free pair: $0, both vision-capable, very long context. The free pool queues at busy times, so expect occasional waiting.' },
  { name: 'Best paid value — DeepSeek v4 Flash + Claude Haiku 5.5', author: 'deepseek/deepseek-v4-flash', critic: 'anthropic/claude-haiku-5.5', note: 'Fraction of a cent per round at verified prices ($0.09 / $0.10 per M input), both fast, and Haiku adds vision for images.' },
  { name: 'Frontier quality — GPT-6.1 Terra + DeepSeek v4 Pro', author: 'openai/gpt-6.1-terra', critic: 'deepseek/deepseek-v4-pro', note: 'Sharpest output of the four, roughly 5–10× the cost per volley. Save it for the prompt you will actually ship.' },
];
const loadPairs = () => { try { return JSON.parse(store.get(PAIRS_KEY, '{}')) || {}; } catch { return {}; } };
const storePairs = (p) => store.set(PAIRS_KEY, JSON.stringify(p));
const prettyModel = (id) => String(id || '').replace(/^.*\//, '').replace(/:free$/, '').replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function refreshPairSelect() {
  const sel = document.getElementById('pairSelect'); if (!sel) return;
  sel.textContent = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = 'Model pairs…'; sel.appendChild(none);
  const rec = document.createElement('optgroup'); rec.label = 'Recommended';
  RECOMMENDED_PAIRS.forEach((p, i) => { const o = document.createElement('option'); o.value = `rec:${i}`; o.textContent = p.name; rec.appendChild(o); });
  sel.appendChild(rec);
  const names = Object.keys(loadPairs());
  if (names.length) {
    const grp = document.createElement('optgroup'); grp.label = 'Saved';
    for (const name of names) { const o = document.createElement('option'); o.value = `saved:${name}`; o.textContent = name; grp.appendChild(o); }
    sel.appendChild(grp);
  }
}
function setupPairSelect() {
  const sel = document.getElementById('pairSelect');
  if (!sel) return;
  sel.onchange = () => {
    const value = sel.value; if (!value) return;
    const kind = value.slice(0, value.indexOf(':'));
    const key = value.slice(value.indexOf(':') + 1);
    const pair = kind === 'rec' ? RECOMMENDED_PAIRS[Number(key)] : loadPairs()[key];
    if (!pair) return;
    document.getElementById('author').value = pair.author; document.getElementById('critic').value = pair.critic;
    store.set('author', pair.author); store.set('critic', pair.critic);
    document.getElementById('pairHelp').textContent = pair.note || `${prettyModel(pair.author)} writes, ${prettyModel(pair.critic)} reviews.`;
  };
  document.getElementById('btnSavePair')?.addEventListener('click', () => {
    const author = document.getElementById('author').value.trim(), critic = document.getElementById('critic').value.trim();
    if (!author || !critic) { toast('Fill in both the Writer and Reviewer first.', 4000); return; }
    const pairs = loadPairs();
    const base = `${prettyModel(author)} + ${prettyModel(critic)}`;
    let name = base, n = 2;
    while (pairs[name]) name = `${base} (${n++})`;
    pairs[name] = { author, critic }; storePairs(pairs); refreshPairSelect();
    sel.value = `saved:${name}`;
    document.getElementById('pairHelp').textContent = `Saved “${name}” — it is in the Saved group of this list from now on.`;
    toast(`Saved model pair “${name}”.`, 4000);
  });
  document.getElementById('btnDelPair')?.addEventListener('click', () => {
    const value = sel.value;
    if (!value.startsWith('saved:')) { toast('Only your saved pairs can be deleted — recommended ones are built in.', 4000); return; }
    const key = value.slice(6), pairs = loadPairs();
    if (!pairs[key]) return;
    delete pairs[key]; storePairs(pairs); refreshPairSelect();
    document.getElementById('pairHelp').textContent = `Deleted “${key}”.`;
    toast(`Saved pair “${key}” deleted.`, 4000);
  });
}
refreshPairSelect();

// ---- Presets ----------------------------------------------------------------
const PRESETS_KEY = 'vpPresets';
const STARTER_PRESETS = {
  mvp: { name: 'Focused MVP', project: 'New MVP', rounds: 2, auto: false, idea: 'Build a small, polished app for [target users] that helps them [primary goal]. Start with the smallest useful version. Describe the main user flow, essential screens, data to store, important empty/error states, and clear testable completion criteria. Avoid accounts, paid services, and unnecessary dependencies unless essential.' },
  product: { name: 'Distinctive product website', project: 'Product website', rounds: 3, auto: false, idea: 'Design and build a distinctive, high-impact landing page for [product] aimed at [audience]. Explain the product value within the first screen, show its real workflow with [available screenshots/demos], establish a coherent visual direction, and include responsive, accessible interactions and a clear call to action. Define the sections, content, and measurable done criteria. Do not invent product capabilities or add a backend.' },
  bugfix: { name: 'Focused bug fix', project: 'Bug fix', rounds: 2, auto: false, idea: 'Investigate and fix this bug: [describe observed behavior]. Expected behavior: [describe expected behavior]. Reproduce it, trace the cause before editing, make the smallest safe fix, and add or update a focused regression check. Preserve existing conventions and avoid unrelated refactors. Report files changed and checks actually run.' },
};
const loadPresets = () => { try { return JSON.parse(store.get(PRESETS_KEY, '{}')) || {}; } catch { return {}; } };
function refreshPresetSelect() {
  const sel = document.getElementById('presetSelect'); if (!sel) return;
  const presets = loadPresets();
  sel.textContent = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = '— starter templates + saved setups —'; sel.appendChild(none);
  const starters = document.createElement('optgroup'); starters.label = 'Starter templates';
  for (const [id, preset] of Object.entries(STARTER_PRESETS)) { const o = document.createElement('option'); o.value = `starter:${id}`; o.textContent = preset.name; starters.appendChild(o); }
  sel.appendChild(starters);
  const savedGroup = document.createElement('optgroup'); savedGroup.label = `Your saved setups (${Object.keys(presets).length})`;
  for (const name of Object.keys(presets).sort()) { const o = document.createElement('option'); o.value = `saved:${name}`; o.textContent = name; savedGroup.appendChild(o); }
  sel.appendChild(savedGroup);
}
function setupPresetSelect() {
  const sel = document.getElementById('presetSelect'); if (!sel) return;
  sel.onchange = () => {
    const value = sel.value;
    const p = value.startsWith('starter:') ? STARTER_PRESETS[value.slice(8)] : value.startsWith('saved:') ? loadPresets()[value.slice(6)] : null;
    if (!p) return;
    document.getElementById('idea').value = p.idea || ''; document.getElementById('projectName').value = p.project || '';
    if (p.author) document.getElementById('author').value = p.author;
    if (p.critic) document.getElementById('critic').value = p.critic;
    document.getElementById('rounds').value = p.rounds || 3; document.getElementById('auto').checked = !!p.auto;
    if (p.settings) saveSettings({ ...loadSettings(), ...p.settings });
    refreshVisionHints();
    toast(value.startsWith('starter:') ? `Starter loaded: ${p.name}. Edit the bracketed details.` : 'Saved setup loaded.', 5000);
  };
  document.getElementById('btnSavePreset')?.addEventListener('click', async () => {
    const entered = await askText({ title: 'Save preset', label: 'Preset name', placeholder: 'e.g. My MVP', okLabel: 'Save' });
    if (entered === null) return;
    const name = String(entered).trim(); if (!name) return;
    const presets = loadPresets();
    if (presets[name]) { const ok = await askConfirm({ title: 'Overwrite preset?', message: `“${name}” already exists. Replace it?`, okLabel: 'Overwrite' }); if (!ok) return; }
    const s = loadSettings();
    presets[name] = { idea: document.getElementById('idea').value, project: document.getElementById('projectName').value.trim(), author: document.getElementById('author').value.trim(), critic: document.getElementById('critic').value.trim(), rounds: +document.getElementById('rounds').value || 3, auto: document.getElementById('auto').checked, settings: { fallback: s.fallback || '', imgMode: s.imgMode || 'auto', recent: s.recent | 0 || 0, rubric: s.rubric || '', budget: Number(s.budget) || 0 } };
    store.set(PRESETS_KEY, JSON.stringify(presets)); refreshPresetSelect(); sel.value = `saved:${name}`;
    toast(`Preset “${name}” saved.`, 4000);
  });
  document.getElementById('btnDelPreset')?.addEventListener('click', () => {
    const value = sel.value;
    if (!value.startsWith('saved:')) { toast('Choose one of your saved setups to delete; starter templates can’t be deleted.', 5000); return; }
    const name = value.slice(6), presets = loadPresets(); if (!presets[name]) return; delete presets[name];
    store.set(PRESETS_KEY, JSON.stringify(presets)); refreshPresetSelect(); toast(`Saved setup “${name}” deleted.`, 4000);
  });
}
refreshPresetSelect();

// ---- Vision hints -----------------------------------------------------------
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i === -1 ? '' : name.slice(i).toLowerCase(); };
let pendingAttachments = [];

function refreshVisionHints() {
  const hints = document.getElementById('visionHints'); if (!hints) return;
  const criticId = (document.getElementById('critic').value || '').trim();
  const hasImages = pendingAttachments.some((a) => IMAGE_EXT.has(extOf(a.file.name)));
  const row = MODEL_ROWS.find((r) => r.id === criticId);
  if (!hasImages || criticId === '') { hints.classList.add('hidden'); return; }
  const suggestions = MODEL_ROWS.filter((r) => r.isFree && r.vision && r.id !== criticId).slice(0, 3);
  if (!suggestions.length || (row && row.vision)) { hints.classList.add('hidden'); return; }
  hints.textContent = row && !row.vision ? '⚠ This Reviewer can’t see images — suggested FREE vision models: ' : 'Image support unknown for this model — suggested FREE vision models: ';
  for (const s of suggestions) { const b = document.createElement('button'); b.type = 'button'; b.className = 'vision-chip'; b.textContent = s.id; b.onclick = () => { document.getElementById('critic').value = s.id; refreshVisionHints(); }; hints.appendChild(b); }
  hints.classList.remove('hidden');
}

// ---- Diff rendering ---------------------------------------------------------
function diffOps(A, B) {
  if (A.length * B.length > 160000) return null;
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: A[i++] }); }
    else { ops.push({ type: 'ins', text: B[j++] }); }
  }
  while (i < n) ops.push({ type: 'del', text: A[i++] });
  while (j < m) ops.push({ type: 'ins', text: B[j++] });
  return ops;
}
function renderLineDiff(el, oldText, newText) {
  const ops = diffOps(oldText.split('\n'), newText.split('\n'));
  if (!ops) { el.textContent = newText; return; }
  const out = []; let same = [];
  const drain = () => {
    if (same.length > 6) out.push({ type: 'same', text: same[0] }, { type: 'gap' }, { type: 'same', text: same[same.length - 1] });
    else for (const t of same) out.push({ type: 'same', text: t });
    same = [];
  };
  for (const op of ops) { if (op.type === 'same') same.push(op.text); else { drain(); out.push(op); } }
  drain();
  el.innerHTML = out.map((op) =>
    op.type === 'del' ? `<span class="ln-del">− ${escapeHtml(op.text)}</span>`
    : op.type === 'ins' ? `<span class="ln-ins">+ ${escapeHtml(op.text)}</span>`
    : op.type === 'gap' ? '<span class="ln-gap">⋮</span>'
    : escapeHtml(op.text)).join('\n');
}

// ---- Prompt/Confirm modals --------------------------------------------------
function askText({ title, message = '', label = 'Name', value = '', placeholder = '', choices = null, okLabel = 'Save' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('promptModal');
    document.getElementById('promptTitle').textContent = title;
    const msg = document.getElementById('promptMessage'); msg.textContent = message; msg.classList.toggle('hidden', !message);
    const input = document.getElementById('promptInput'); input.value = value; input.placeholder = placeholder;
    document.getElementById('promptLabel').textContent = label;
    document.getElementById('promptField').classList.remove('hidden');
    const box = document.getElementById('promptChoices'); box.textContent = '';
    if (choices && choices.length) { box.classList.remove('hidden'); for (const c of choices) { const b = document.createElement('button'); b.type = 'button'; b.textContent = c.label; b.addEventListener('click', () => finish(c.value)); box.appendChild(b); } } else box.classList.add('hidden');
    const ok = document.getElementById('promptOk'); ok.textContent = okLabel;
    const done = (v) => finish(v); ok.onclick = () => done(input.value);
    document.getElementById('promptCancel').onclick = () => finish(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
    function finish(v) { modal.classList.add('hidden'); ok.onclick = null; document.getElementById('promptCancel').onclick = null; input.onkeydown = null; resolve(v); }
  });
}

function askConfirm({ title, message = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('promptModal');
    document.getElementById('promptTitle').textContent = title;
    const msg = document.getElementById('promptMessage'); msg.textContent = message; msg.classList.toggle('hidden', !message);
    document.getElementById('promptField').classList.add('hidden'); document.getElementById('promptChoices').classList.add('hidden');
    const ok = document.getElementById('promptOk'); ok.textContent = okLabel;
    const finish = (v) => { modal.classList.add('hidden'); ok.onclick = null; document.getElementById('promptCancel').onclick = null; resolve(v); };
    ok.onclick = () => finish(true); document.getElementById('promptCancel').onclick = () => finish(false);
    modal.classList.remove('hidden'); setTimeout(() => ok.focus(), 0);
  });
}

// ---- Context menu -----------------------------------------------------------
const contextMenu = document.getElementById('contextMenu');
let contextTarget = null;
function closeContextMenu() { if (!contextMenu) return; contextMenu.classList.add('hidden'); contextMenu.classList.remove('visible'); contextTarget = null; }
function openContextMenu(e, target) {
  if (!contextMenu) return; contextTarget = target;
  contextMenu.querySelectorAll('.menu-item').forEach((el) => { let show = el.dataset.scope === target.kind; if (show && el.dataset.action === 'delete-project' && !target.key) show = false; el.classList.toggle('hidden', !show); });
  contextMenu.style.left = `${e.pageX}px`; contextMenu.style.top = `${e.pageY}px`; contextMenu.classList.remove('hidden'); contextMenu.classList.add('visible');
}
if (contextMenu) {
  contextMenu.addEventListener('click', (e) => { const el = e.target.closest('.menu-item'); if (!el || !contextTarget) return; const action = el.dataset.action; const target = contextTarget; closeContextMenu(); runHistoryAction(action, target); });
  document.addEventListener('click', (e) => { if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu(); });
}

// ---- Attachment handling (shared) ------------------------------------------
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.md', '.markdown', '.json', '.csv', '.js', '.jsx', '.ts', '.tsx', '.py', '.html', '.htm', '.css']);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10;
let attachmentIdSeq = 0;
const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const isDuplicateFile = (file) => pendingAttachments.some((a) => a.file.name === file.name && a.file.size === file.size && a.file.lastModified === file.lastModified);

function addAttachmentFiles(fileList) {
  const rejected = [];
  for (const file of Array.from(fileList)) {
    const ext = extOf(file.name);
    if (!ALLOWED_EXT.has(ext)) { rejected.push(`${file.name} (unsupported type)`); continue; }
    if (file.size > MAX_FILE_BYTES) { rejected.push(`${file.name} (over 64 MB)`); continue; }
    if (isDuplicateFile(file)) continue;
    if (pendingAttachments.length >= MAX_FILES) { rejected.push(`${file.name} (max ${MAX_FILES} attachments)`); continue; }
    let url = null; if (IMAGE_EXT.has(ext)) { try { url = URL.createObjectURL(file); } catch { url = null; } }
    pendingAttachments.push({ id: ++attachmentIdSeq, file, url });
  }
  if (rejected.length) toast('Skipped: ' + rejected.join(', '), 8000);
  renderAttachments();
}

function removeAttachment(id) {
  const idx = pendingAttachments.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const [removed] = pendingAttachments.splice(idx, 1);
  if (removed.url) URL.revokeObjectURL(removed.url);
  renderAttachments();
}

function renderAttachments() {
  const tray = document.getElementById('attachment-tray'); if (!tray) return;
  tray.textContent = '';
  const attachedCount = pendingAttachments.length;
  tray.classList.toggle('hidden', attachedCount === 0);
  if (attachedCount) {
    const status = document.createElement('div'); status.className = 'attachment-status'; status.setAttribute('aria-live', 'polite');
    status.textContent = `✓ ${attachedCount} context source${attachedCount === 1 ? '' : 's'} attached · included with the next volley`;
    tray.appendChild(status);
  }
  for (const a of pendingAttachments) {
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    const thumb = document.createElement('div'); thumb.className = 'chip-thumb';
    if (a.url) { const img = document.createElement('img'); img.src = a.url; img.alt = ''; img.onerror = () => { thumb.textContent = '📄'; img.remove(); }; thumb.appendChild(img); }
    else { thumb.textContent = extOf(a.file.name) === '.pdf' ? '📕' : '📄'; }
    const info = document.createElement('div'); info.className = 'chip-info';
    const name = document.createElement('span'); name.className = 'chip-name'; name.textContent = a.file.name; name.title = a.file.name;
    const size = document.createElement('span'); size.className = 'chip-size'; size.textContent = formatSize(a.file.size) + (a.scaledDataUrl ? ' · ⤓ compressed' : ''); info.append(name, size);
    const removeBtn = document.createElement('button'); removeBtn.type = 'button'; removeBtn.className = 'chip-remove'; removeBtn.title = 'Remove'; removeBtn.setAttribute('aria-label', `Remove ${a.file.name}`); removeBtn.textContent = '✕'; removeBtn.addEventListener('click', () => removeAttachment(a.id));
    const chipKids = [thumb, info];
    if (IMAGE_EXT.has(extOf(a.file.name))) {
      const shrink = document.createElement('button'); shrink.type = 'button'; shrink.className = 'chip-remove'; shrink.title = 'Re-encode smaller (max 1024px)'; shrink.setAttribute('aria-label', `Re-encode ${a.file.name} smaller`); shrink.textContent = '⤓'; shrink.addEventListener('click', async () => { shrink.disabled = true; try { a.scaledDataUrl = await downscaleForVision(a.file, 1024, 0.75, true); renderAttachments(); toast(`“${a.file.name}” re-encoded → ~${Math.round(a.scaledDataUrl.length * 0.75 / 1024)} KB sent version.`, 6000); } catch (e) { shrink.disabled = false; toast('⚠ Could not re-encode that image.', 6000); } }); chipKids.push(shrink);
    }
    chipKids.push(removeBtn); chip.append(...chipKids); tray.appendChild(chip);
  }
  refreshVisionHints();
}

// ---- Image downscaling for vision ------------------------------------------
const VISION_MAX_FILE_BYTES = 2 * 1024 * 1024;
const VISION_MAX_DIM = 1600;
let imagesScaled = false;
async function downscaleForVision(file, maxDim = VISION_MAX_DIM, quality = 0.85, force = false) {
  if (!force && file.size <= VISION_MAX_FILE_BYTES) return readFileAsDataURL(file);
  imagesScaled = true;
  try {
    const bmp = await createImageBitmap(file);
    let { width, height } = bmp;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)); const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
    let dataUrl = canvas.toDataURL('image/webp', quality);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', quality);
    return dataUrl;
  } catch (e) { return readFileAsDataURL(file); }
}

const readFileAsDataURL = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('Failed to read ' + file.name)); r.readAsDataURL(file); });
const readFileAsText = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('Failed to read ' + file.name)); r.readAsText(file); });

// ---- History actions --------------------------------------------------------
async function runHistoryAction(action, target) {
  if (action === 'rename') { const name = await askText({ title: 'Rename volley', label: 'Name', value: target.title, okLabel: 'Rename' }); if (name === null) return; const clean = String(name).trim(); if (!clean) return; const ok = await pv.renameRun(target.name, clean); if (ok) { toast('Volley renamed.', 3000); await loadHistory(); } else toast('Rename failed — could not write the new title.', 4000); }
  else if (action === 'move') { const list = await pv.projects(); const choices = (list || []).filter((p) => p.key).map((p) => ({ label: p.name, value: p.key })); const dest = await askText({ title: 'Move volley to folder', label: 'Folder', value: target.key || '', placeholder: 'Folder name', choices, okLabel: 'Move' }); if (dest === null) return; const ok = await pv.moveRun(target.name, String(dest).trim()); if (ok) { toast('Volley moved.', 3000); await loadHistory(); } else toast('Move failed.', 4000); }
  else if (action === 'delete') { const yes = await askConfirm({ title: 'Delete volley?', okLabel: 'Delete', message: `“${target.title}” and its saved prompt will be removed from this computer. This cannot be undone.` }); if (!yes) return; const ok = await pv.deleteRun(target.name); if (ok) { if (window.currentHistoryName === target.name) window.currentHistoryName = null; toast('Volley deleted.', 3000); await loadHistory(); } else toast('Delete failed.', 4000); }
  else if (action === 'rename-project') { const name = await askText({ title: 'Rename folder', label: 'Folder name', value: target.label, okLabel: 'Rename' }); if (name === null) return; const clean = String(name).trim(); if (!clean) return; const n = await pv.renameProject(target.key, clean); toast(n ? `Folder renamed (${n} volley${n === 1 ? '' : 's'}).` : 'No volleys in that folder.', 3500); await loadHistory(); }
  else if (action === 'delete-project') { const yes = await askConfirm({ title: 'Delete folder?', okLabel: 'Delete folder', message: `The volleys in “${target.label}” move back to “Other volleys”. The volleys themselves are kept.` }); if (!yes) return; const n = await pv.deleteProject(target.key); toast(n ? `Folder deleted (${n} volley${n === 1 ? '' : 's'} moved to Other volleys).` : 'Folder was already empty.', 4000); await loadHistory(); }
}

// ---- Custom dropdowns -------------------------------------------------------
function enhanceSelect(sel) { if (!sel || sel.dataset.enhanced) return; sel.dataset.enhanced = '1'; const wrap = document.createElement('div'); wrap.className = 'select-wrap'; const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'select-trigger'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); const label = document.createElement('span'); label.className = 'select-label'; const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▾'; chev.setAttribute('aria-hidden', 'true'); btn.append(label, chev); const menu = document.createElement('div'); menu.className = 'select-menu hidden'; menu.setAttribute('role', 'listbox'); sel.parentNode.insertBefore(wrap, sel); wrap.append(sel, btn, menu); const rows = () => [...menu.children]; const render = () => { const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null; const full = cur ? cur.textContent : ''; label.textContent = full.split(' — ')[0]; btn.title = full; btn.dataset.value = sel.value; rows().forEach((r) => r.setAttribute('aria-selected', String(r.dataset.value === sel.value))); }; const build = () => { menu.textContent = ''; [...sel.options].forEach((o) => { const row = document.createElement('div'); row.className = 'select-option'; row.setAttribute('role', 'option'); row.dataset.value = o.value; row.textContent = o.textContent; row.addEventListener('click', () => { pick(o.value); close(); btn.focus(); }); menu.append(row); }); render(); }; const pick = (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); render(); }; const active = () => rows().find((r) => r.classList.contains('active')); const move = (dir) => { const list = rows(); if (!list.length) return; const i = list.indexOf(active()); const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? (dir > 0 ? -1 : 0) : i) + dir))]; list.forEach((r) => r.classList.remove('active')); next.classList.add('active'); next.scrollIntoView({ block: 'nearest' }); }; const open = () => { menu.classList.remove('hidden'); wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); const cur = rows().find((r) => r.getAttribute('aria-selected') === 'true') || rows()[0]; if (cur) { rows().forEach((r) => r.classList.remove('active')); cur.classList.add('active'); cur.scrollIntoView({ block: 'nearest' }); } }; function close() { menu.classList.add('hidden'); wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); rows().forEach((r) => r.classList.remove('active')); } const toggle = () => (menu.classList.contains('hidden') ? open() : close()); btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); }); btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else move(e.key === 'ArrowDown' ? 1 : -1); } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else { const a = active(); if (a) pick(a.dataset.value); close(); } } else if (e.key === 'Escape') { close(); } }); document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); }); window.addEventListener('blur', close); const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); if (desc?.get && desc?.set) Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(sel); }, set(v) { desc.set.call(sel, v); render(); } }); const lab = sel.closest('label'); if (lab) { sel.setAttribute('aria-label', lab.textContent.replace(/\s+/g, ' ').trim() || 'Choose an option'); lab.htmlFor = ''; } build(); }

// Expose shared utilities globally
window.__vpShared = { store, toast, applyTheme, escapeHtml, loadSettings, saveSettings, setupModelAutocomplete, populateProviderSelects, applyProviderToField, applyAllProviderRows, wireProviderSelect, loadPairs, storePairs, refreshPairSelect, setupPairSelect, loadPresets, refreshPresetSelect, setupPresetSelect, refreshVisionHints, diffOps, renderLineDiff, askText, askConfirm, runHistoryAction, enhanceSelect, addAttachmentFiles, removeAttachment, renderAttachments, downscaleForVision, readFileAsDataURL, readFileAsText, IMAGE_EXT, extOf, formatSize };