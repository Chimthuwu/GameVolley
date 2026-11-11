const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};


function toast(msg, ms = 6000) {
  // Stacked toasts (max 3): notices, fallback retries and resize warnings no longer
  // clobber each other mid-run. Click a toast to dismiss it early.
  const box = $('toasts');
  if (!box) return;
  while (box.children.length >= 3) box.firstElementChild.remove();
  const t = document.createElement('div');
  t.className = 'toast-item';
  t.textContent = msg;
  t.onclick = () => t.remove();
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---- Collapsible sidebar — applied immediately (before the async model fetch below)
// so a remembered collapsed state doesn't flash open on load. ----
const sidebarEl = document.querySelector('.sidebar');
function setSidebarCollapsed(collapsed) {
  sidebarEl.classList.toggle('sidebar-collapsed', collapsed);
  $('btnSidebarToggle').setAttribute('aria-expanded', String(!collapsed));
  store.set('sidebarCollapsed', collapsed ? '1' : '0');
}
setSidebarCollapsed(store.get('sidebarCollapsed', '0') === '1');
$('btnSidebarToggle').onclick = () => setSidebarCollapsed(!sidebarEl.classList.contains('sidebar-collapsed'));

// ---- Theme (hue/saturation/contrast) — shifts the actual accent CSS vars via HSL math,
// so body text stays crisp and only the neon palette moves. Applied immediately to avoid
// a flash of the default palette before the user's saved preference kicks in. ----
const THEME_BASE_HSL = {
  '--neon-cyan': [183, 100, 50],
  '--neon-magenta': [344, 100, 59],
  '--neon-green': [156, 100, 51],
  '--neon-purple': [275, 100, 59],
};
// The background, cards, titlebar and dropdown surfaces used to be fixed hexes, so the hue
// slider only moved the accents and the app still looked purple. Same colours in HSL here.
const THEME_SURFACE_HSL = {
  '--bg': [252, 50, 4],
  '--bg-glow': [251, 65, 19],
  '--card': [252, 49, 10],
  '--titlebar-from': [253, 60, 6],
  '--panel': [275, 55, 8],
  '--panel-hi': [263, 66, 19],
};
function applyTheme({ hue, sat, contrast }) {
  const root = document.documentElement.style;
  const satOf = (s) => Math.min(100, Math.max(0, s * (sat / 100)));
  const lumOf = (l) => Math.min(100, Math.max(0, l * (contrast / 100)));
  for (const [name, [h, s, l]] of Object.entries(THEME_BASE_HSL)) {
    const newH = ((h + hue) % 360 + 360) % 360;
    const newS = Math.min(100, Math.max(0, s * (sat / 100)));
    const newL = Math.min(100, Math.max(0, 50 + (l - 50) * (contrast / 100)));
    root.setProperty(name, `hsl(${newH.toFixed(0)}, ${newS.toFixed(0)}%, ${newL.toFixed(0)}%)`);
  }
  // Surfaces: hue follows the accents, lightness follows contrast around its own baseline.
  for (const [name, [h, s, l]] of Object.entries(THEME_SURFACE_HSL)) {
    const newH = ((h + hue) % 360 + 360) % 360;
    root.setProperty(name, `hsl(${newH.toFixed(0)}, ${satOf(s).toFixed(0)}%, ${lumOf(l).toFixed(0)}%)`);
  }
  // Field fills and the wash behind the full-page Settings view keep their alpha.
  const fh = ((252 + hue) % 360 + 360) % 360;
  root.setProperty('--field', `hsla(${fh.toFixed(0)}, ${satOf(50).toFixed(0)}%, ${lumOf(4).toFixed(0)}%, 0.7)`);
  const wh = ((270 + hue) % 360 + 360) % 360;
  root.setProperty('--bg-wash', `hsla(${wh.toFixed(0)}, ${satOf(71).toFixed(0)}%, ${Math.min(40, lumOf(27)).toFixed(0)}%, 0.35)`);
  // Keep the purple-tinted borders/glow in step with the shifted purple instead of
  // staying frozen at the original hue.
  const [ph, ps] = THEME_BASE_HSL['--neon-purple'];
  const h2 = ((ph + hue) % 360 + 360) % 360;
  const s2 = Math.min(100, Math.max(0, ps * (sat / 100)));
  root.setProperty('--line', `hsla(${h2.toFixed(0)}, ${s2.toFixed(0)}%, 50%, 0.3)`);
  root.setProperty('--line-glow', `hsla(${h2.toFixed(0)}, ${s2.toFixed(0)}%, 50%, 0.8)`);
  // The animated background canvas paints with its own colours — let it re-read them.
  document.dispatchEvent(new Event('vp-theme'));
}
const hueInput = $('themeHue'), satInput = $('themeSat'), contrastInput = $('themeContrast');
hueInput.value = store.get('themeHue', '0');
satInput.value = store.get('themeSat', '100');
contrastInput.value = store.get('themeContrast', '100');
function currentThemeValues() { return { hue: +hueInput.value, sat: +satInput.value, contrast: +contrastInput.value }; }
applyTheme(currentThemeValues());
function persistAndApplyTheme() {
  const v = currentThemeValues();
  applyTheme(v);
  store.set('themeHue', v.hue); store.set('themeSat', v.sat); store.set('themeContrast', v.contrast);
}
[hueInput, satInput, contrastInput].forEach((el) => el.addEventListener('input', persistAndApplyTheme));
$('btnThemeReset').onclick = () => { hueInput.value = 0; satInput.value = 100; contrastInput.value = 100; persistAndApplyTheme(); };

const themeBtn = $('btnTheme'), themePanel = $('themePanel');
function closeThemePanel() { themePanel.classList.add('hidden'); themeBtn.setAttribute('aria-expanded', 'false'); }
themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willShow = themePanel.classList.contains('hidden');
  themePanel.classList.toggle('hidden', !willShow);
  themeBtn.setAttribute('aria-expanded', String(willShow));
});
themePanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => { if (!themePanel.classList.contains('hidden') && e.target !== themeBtn) closeThemePanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !themePanel.classList.contains('hidden')) closeThemePanel(); });

(async () => {
  // Original shipped pair. The ":free" variants of both were retired by OpenRouter, so the same
  // models are the paid ids here — a couple of cents per volley. The "Free & capable" pair in
  // Model pairs is the $0 equivalent.
  $('author').value = store.get('author', 'deepseek/deepseek-chat-v3.1');
  $('critic').value = store.get('critic', 'meta-llama/llama-3.3-70b-instruct');
  $('rounds').value = store.get('rounds', '3');
  $('outputMode').value = store.get('outputMode', 'prompt') === 'deep-plan' ? 'deep-plan' : 'prompt';
  $('idea').value = store.get('idea', '');
  $('auto').checked = store.get('auto', '0') === '1';
  const ap = store.get('authorProvider', 'openrouter');
  const cp = store.get('criticProvider', 'openrouter');
  if ((ap === 'openrouter' || cp === 'openrouter') && !(await pv.hasKey())) openModal(true);
  const rows = await pv.models();
  $('modelList').innerHTML = rows.map((r) => `<option value="${r.id}">`).join('');
})();

function openModal(first) {
  $('modalTitle').textContent = first ? 'Welcome! One-time setup' : 'Settings';
  $('keyMsg').textContent = ''; $('keyInput').value = '';
  pv.keyState?.().then((s) => {
    const hint = $('keyStorageHint');
    if (!hint) return;
    if (s?.unreadable) {
      hint.textContent = '⚠ A saved key file is on this PC, but this Windows account can no longer decrypt it (this happens after an OS reinstall or a new Windows profile). Paste the key once more and it will be saved again.';
      return;
    }
    hint.textContent = s?.storage === 'browser'
      ? "Your key stays in this browser's storage and goes straight to OpenRouter — never through any server of ours. A different browser, device, or cleared site data means entering it again."
      : 'Your key is saved encrypted on this PC only (Windows DPAPI).';
  }).catch(() => {});
  show('modal'); $('keyInput').focus();
}
$('btnSettings').onclick = () => {
  // The cog toggles: it opens Settings, and closes it again if you're already there.
  if (!$('settingsPage').classList.contains('hidden')) hideSettingsPage();
  else openSettings();
};
$('btnCloseModal').onclick = () => show('modal', false);
$('btnFolder').onclick = () => pv.openFolder();
document.querySelectorAll('[data-url]').forEach((a) => a.onclick = (e) => { e.preventDefault(); pv.openUrl(a.dataset.url); });
$('btnSaveKey').onclick = async () => {
  const k = $('keyInput').value.trim(), msg = $('keyMsg');
  if (!k) { msg.className = 'msg bad'; msg.textContent = 'Paste your key first.'; return; }
  msg.className = 'msg'; msg.textContent = 'Checking…';
  const r = await pv.testKey(k);
  msg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); msg.textContent = r.message;
  if (r.ok) { await pv.saveKey(k); setTimeout(() => show('modal', false), 700); }
};

// ---- Settings (⚙): mirrored default models for every volley + cost-saving options ----
const SETTINGS_KEY = 'vpSettings';
const loadSettings = () => { try { return JSON.parse(store.get(SETTINGS_KEY, '{}')) || {}; } catch { return {}; } };
const saveSettings = (o) => store.set(SETTINGS_KEY, JSON.stringify(o));

function openSettings() {
  const s = loadSettings();
  $('setWriter').value = s.writer || store.get('author', '');
  $('setCritic').value = s.critic || store.get('critic', '');
  $('setFallback').value = s.fallback || '';
  $('setImgMode').value = s.imgMode || 'auto';
  $('setRecent').value = String(s.recent | 0 || 0);
  $('setRubric').value = s.rubric || '';
  $('setBudget').value = String(Number(s.budget) || 0);
  pv.keyState?.().then((s) => {
    const status = $('keyStoreStatus'), where = $('keyStoreWhere');
    if (!status || !where) return;
    status.classList.toggle('bad', !!s?.unreadable);
    status.textContent = s?.unreadable ? '⚠ saved but unreadable' : s?.configured ? '✓ saved' : 'not saved yet';
    where.textContent = s?.storage === 'browser'
      ? `Kept in this browser's local storage for ${s.origin} only — no server of ours ever sees it, and it is not synced. Another browser or device needs the key pasted again, and clearing site data removes it.`
      : `Encrypted file in ${s?.path || 'the app data folder'} (Windows DPAPI, readable only by your Windows account) — sent only to openrouter.ai, never to us.`;
    if (s?.unreadable && s?.error) where.textContent += ` Windows reported: ${s.error}`;
  }).catch(() => {});
  $('keyUsageInfo').textContent = 'Loading OpenRouter key usage…';
  pv.keyUsage().then((r) => {
    if (!r?.ok) { $('keyUsageInfo').textContent = r?.message || 'Key usage unavailable.'; return; }
    const d = r.data || {};
    const remaining = d.limit_remaining;
    const limit = d.limit;
    $('keyUsageInfo').textContent = remaining != null && Number.isFinite(Number(remaining))
      ? `OpenRouter key spend remaining: $${Number(remaining).toFixed(2)}${limit != null && Number.isFinite(Number(limit)) ? ` of $${Number(limit).toFixed(2)}` : ''}.`
      : `OpenRouter key usage: $${Number(d.usage || 0).toFixed(2)} used${d.is_free_tier ? ' · free tier' : ''}.`;
  }).catch(() => { $('keyUsageInfo').textContent = 'Could not load key usage.'; });
  populateProviderSelects();
  renderProviders();
  showSettingsPage();
}
// Settings is its own page (it was too cramped as a popup): hide the current view, and
// return to it on Back/Escape.
let settingsReturn = 'setup';
function showSettingsPage() {
  settingsReturn = ['setup', 'run', 'result'].find((id) => !$(id).classList.contains('hidden')) || 'setup';
  ['setup', 'run', 'result'].forEach((id) => show(id, false));
  show('settingsPage');
  window.scrollTo(0, 0);
}
function hideSettingsPage() { show('settingsPage', false); show(settingsReturn || 'setup'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settingsPage').classList.contains('hidden')) hideSettingsPage();
});
$('btnSaveSettings').onclick = () => {
  const o = {
    writer: $('setWriter').value.trim(),
    critic: $('setCritic').value.trim(),
    fallback: $('setFallback').value.trim(),
    imgMode: $('setImgMode').value,
    recent: Math.max(0, Math.min(5, $('setRecent').value | 0 || 0)),
    rubric: $('setRubric').value.trim().slice(0, 6000),
    budget: Math.max(0, Math.min(100, Number($('setBudget').value) || 0)),
  };
  saveSettings(o);
  // Default Writer/Reviewer models share one source of truth with the composer fields.
  if (o.writer) { store.set('author', o.writer); $('author').value = o.writer; }
  if (o.critic) { store.set('critic', o.critic); $('critic').value = o.critic; }
  // Persist provider choices and keep the composer selects + model lists in sync.
  store.set('authorProvider', $('setWriterProvider').value);
  store.set('criticProvider', $('setCriticProvider').value);
  store.set('fallbackProvider', $('setFallbackProvider').value);
  $('authorProvider').value = $('setWriterProvider').value;
  $('criticProvider').value = $('setCriticProvider').value;
  applyProviderToField($('author'), $('authorProvider').value);
  applyProviderToField($('critic'), $('criticProvider').value);
  hideSettingsPage();
  toast('Settings saved.', 4000);
};
$('settingsClose').onclick = () => hideSettingsPage();
$('btnEditKey').onclick = () => { hideSettingsPage(); openModal(false); };

// ---- Model autocomplete: custom, scrollable, badged. The native <input list> dropdown
// refused to show options while the field already had text in it, and its list can't be
// reliably scrolled — this replaces it everywhere a model id is picked. ----
let MODEL_ROWS = []; // OpenRouter model catalogue (used for pricing/vision hints)
let MODEL_ROWS_BY_INPUT = new WeakMap(); // per-input model rows (provider-aware)
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
    // Focusing a field that already holds a model id shows the whole list; only actual
    // typing filters it. (Otherwise the field filtered down to its own value and looked empty.)
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
      // Free models first (the API sorts them ahead) AND flagged loudly — saving money is the default path.
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
  input.addEventListener('blur', () => setTimeout(close, 120)); // leaves clicks time to land
  window.addEventListener('scroll', (e) => { if (!list.contains(e.target)) close(); }, true);
  window.addEventListener('resize', close);
  list.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keeps the input's blur from closing the list before the click lands
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
  // Initial OpenRouter model rows (provider-aware fields swap this out later).
  if (!window.__defaultModelRows) window.__defaultModelRows = pv.models().catch(() => []);
  try { rowsFor().rows = (await window.__defaultModelRows) || []; } catch {}
}
(async () => {
  try { MODEL_ROWS = (await pv.models()) || []; } catch {}
  refreshVisionHints(); // rows just arrived — suggestions may become possible
})();
[...document.querySelectorAll('#author, #critic, .model-input')].forEach((el) => el && setupModelAutocomplete(el));
// Settings model fields get a visible caret, so it's obvious they open a picker.
['setWriter', 'setCritic', 'setFallback'].forEach((id) => {
  const input = $(id);
  const label = input && input.closest('label');
  if (!input || !label || label.querySelector('.model-caret')) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'model-caret'; btn.tabIndex = -1;
  btn.setAttribute('aria-label', 'Show the model list');
  btn.textContent = '▾';
  btn.addEventListener('click', (e) => { e.preventDefault(); input.focus(); });
  label.appendChild(btn);
});
$('critic').addEventListener('input', refreshVisionHints);

// ---- Multi-provider support: connect your own AI accounts; pick a provider per role. ----
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
    const sel = $(selId);
    if (!sel || sel.options.length) continue;
    for (const p of PROVIDER_LIST) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    }
  }
  const set = (selId, key) => { const sel = $(selId); if (sel) sel.value = store.get(key, 'openrouter'); };
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
    const input = $(inputId), sel = $(selId);
    if (input && sel) await applyProviderToField(input, sel.value);
  }
}

function wireProviderSelect(inputId, selId, storeKey) {
  const sel = $(selId);
  if (!sel) return;
  sel.addEventListener('change', async () => {
    store.set(storeKey, sel.value);
    await applyProviderToField($(inputId), sel.value);
  });
}

async function renderProviders() {
  const list = $('providerList');
  if (!list) return;
  if (!PROVIDER_LIST.length) { try { PROVIDER_LIST = (await pv.providersList()) || []; } catch { PROVIDER_LIST = []; } }
  let statuses = {};
  try { statuses = (await pv.providersStatus()) || {}; } catch {}
  list.textContent = '';
  for (const p of PROVIDER_LIST) {
    const st = statuses[p.id] || {};
    const card = document.createElement('div');
    card.className = 'provider-card';
    const head = document.createElement('div');
    head.className = 'provider-card-head';
    const name = document.createElement('span'); name.className = 'provider-name'; name.textContent = p.name;
    const stat = document.createElement('span');
    stat.className = 'provider-status' + (st.connected ? ' ok' : '');
    if (p.authType === 'cli') stat.textContent = st.installed ? '✓ CLI installed' : 'CLI not installed';
    else stat.textContent = st.connected ? '✓ connected' : 'not connected';
    head.append(name, stat);
    card.appendChild(head);
    const help = document.createElement('p');
    help.className = 'hint';
    if (p.authType === 'local') help.textContent = 'Runs locally — no key needed. Make sure Ollama is running with the model pulled.';
    else if (p.authType === 'cli') help.textContent = p.installHint || 'Install this provider’s official CLI and log in, then it uses your own account.';
    else help.textContent = 'Enter your API key (stored encrypted on this device). It is sent only to ' + p.name + '.';
    card.appendChild(help);
    // Billing implication, so users never discover a paid fallback by accident.
    if (p.billingNote) {
      const bill = document.createElement('p');
      bill.className = 'hint provider-billing';
      bill.textContent = p.billingNote;
      card.appendChild(bill);
    }
    if (p.authType === 'api_key') {
      const row = document.createElement('div');
      row.className = 'provider-cred-row';
      const inp = document.createElement('input');
      inp.type = 'password'; inp.placeholder = 'API key'; inp.className = 'provider-key'; inp.dataset.prov = p.id;
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'ghost'; saveBtn.textContent = 'Save';
      const msg = document.createElement('span'); msg.className = 'provider-msg'; msg.dataset.prov = p.id;
      saveBtn.onclick = async () => {
        const r = await pv.providerCredsSave(p.id, inp.value.trim());
        msg.textContent = r.present ? `Saved ${r.masked}` : 'Cleared';
        renderProviders();
      };
      row.append(inp, saveBtn, msg);
      card.appendChild(row);
    } else if (p.authType === 'cli') {
      const cliName = (p.cliBinaries && p.cliBinaries[0]) || 'cli';
      const login = document.createElement('p');
      login.className = 'hint';
      login.textContent = st.installed
        ? 'Binary found. If a request fails, run "' + cliName + ' login" in a terminal once.'
        : 'Not found. Install it, then run "' + cliName + ' login" in a terminal (opens your browser).';
      card.appendChild(login);
    }
    const act = document.createElement('button');
    act.type = 'button'; act.className = 'ghost';
    act.textContent = p.authType === 'local' ? 'Check connection' : (p.authType === 'cli' ? 'Check CLI' : 'Test & connect');
    act.onclick = async () => {
      act.disabled = true; act.textContent = 'Checking…';
      const r = await pv.providerConnect(p.id, '');
      act.disabled = false; act.textContent = p.authType === 'local' ? 'Check connection' : (p.authType === 'cli' ? 'Check CLI' : 'Test & connect');
      let m = card.querySelector('.provider-msg');
      if (!m) { m = document.createElement('span'); m.className = 'provider-msg'; card.appendChild(m); }
      m.textContent = r.ok ? `✓ ${r.cli ? 'CLI found' : 'connected'} · ${r.models.length} models` : '✗ ' + (r.message || r.error || 'failed');
      renderProviders();
    };
    card.appendChild(act);
    list.appendChild(card);
  }
}

// Wire provider selects once, on load. Settings selectors share the composer's stored
// provider preference (Writer/Reviewer/Fallback) so they stay in sync.
const PROVIDER_STORE_KEY = {
  author: 'authorProvider', critic: 'criticProvider',
  setWriter: 'authorProvider', setCritic: 'criticProvider', setFallback: 'fallbackProvider',
};
for (const [inputId, selId] of Object.entries(PROVIDER_PAIRS)) {
  wireProviderSelect(inputId, selId, PROVIDER_STORE_KEY[inputId]);
}

// Pulls the last N finished prompts (finals) from history for the run's reference context.
async function collectRecentContext(n) {
  let items = [];
  try { items = (await pv.runs()) || []; } catch { return ''; }
  const chunks = [];
  for (const it of items) {
    if (chunks.length >= n) break;
    let final = it.final;
    if (final == null && typeof pv.openRun === 'function') {
      const got = await pv.openRun(it.name).catch(() => null);
      final = got && got.final;
    }
    if (!final) continue;
    chunks.push(`— Past idea: ${it.idea || it.title || '(untitled)'}\n— Past finished prompt:\n${final}`);
  }
  return chunks.join('\n\n');
}

let runAbandoned = false;
let lastRunMeta = null; // header for "Copy as Markdown" (models, rounds, date)
let lastRunPerM = { author: null, critic: null };
let currentHistoryName = null;
let runSnapshots = [];
let demoRunning = false;

// Builds the full run config from the composer (idea, models, settings, attachments,
// recent-context) — used by "Start the volley". Returns null
// (with a toast) on any validation problem.
async function composeCfgFromComposer() {
  const idea = $('idea').value.trim();
  if (!idea) { toast('Type your idea first 🙂'); $('idea').focus(); return null; }
  const authorProv = $('authorProvider').value || 'openrouter';
  const criticProv = $('criticProvider').value || 'openrouter';
  const needOpenRouter = authorProv === 'openrouter' || criticProv === 'openrouter';
  if (needOpenRouter && !(await pv.hasKey())) { openModal(true); return null; }
  const cfg = { idea, author: $('author').value.trim(), critic: $('critic').value.trim(), rounds: +$('rounds').value || 3, auto: $('auto').checked };
  cfg.authorProvider = authorProv;
  cfg.criticProvider = criticProv;
  cfg.fallbackProvider = store.get('fallbackProvider', '');
  cfg.outputMode = $('outputMode').value === 'deep-plan' ? 'deep-plan' : 'prompt';
  store.set('outputMode', cfg.outputMode);
  if (!cfg.author || !cfg.critic) { toast('Pick a model for both AIs.'); return null; }
  for (const k of ['author', 'critic', 'rounds', 'idea']) store.set(k, cfg[k]);
  store.set('auto', cfg.auto ? '1' : '0');

  // Settings-driven run knobs: fallback model on failure, how the Reviewer sees
  // attachments, and how many recent finished prompts feed in as reference context.
  const s = loadSettings();
  cfg.fallback = s.fallback || '';
  cfg.imgMode = s.imgMode || 'auto';
  cfg.recent = Math.max(0, Math.min(5, s.recent | 0 || 0));
  cfg.rubric = s.rubric || '';
  cfg.budget = Math.max(0, Number(s.budget) || 0);
  cfg.project = $('projectName').value.trim().slice(0, 80);

  if (pendingAttachments.length || pendingFolders.some((f) => f.status === 'ready')) {
    const btnStart = $('btnStart');
    const originalLabel = btnStart.textContent;
    btnStart.disabled = true; btnStart.textContent = 'Processing files…';
    try {
      cfg.attachments = await buildAttachmentPayload();
      if (imagesScaled) toast('Large images were auto-resized (vision models only see a static frame anyway) — smaller payloads, faster rounds.', 7000);
    } catch (e) {
      btnStart.disabled = false; btnStart.textContent = originalLabel;
      toast('⚠ ' + (e.message || 'Could not process attachments.'), 8000);
      return null;
    }
    btnStart.disabled = false; btnStart.textContent = originalLabel;
  }

  // Reference context: the last N finished prompts, straight from history (Settings).
  if (cfg.recent > 0) {
    const ctx = await collectRecentContext(cfg.recent);
    if (ctx) cfg.context = ctx;
  }
  return cfg;
}

function beginRun(cfg) {
  lastRunMeta = { author: cfg.author, critic: cfg.critic, rounds: cfg.rounds, when: new Date().toLocaleString(), project: cfg.project || '', snapshots: [], currentName: null };
  const perOf = (id) => { const r = MODEL_ROWS.find((x) => x.id === id); return r ? (r.isFree ? 0 : r.perM) : null; };
  lastRunPerM.author = perOf(cfg.author); lastRunPerM.critic = perOf(cfg.critic);
  runAbandoned = false;
  currentHistoryName = null; runSnapshots = [];
  $('fitnessScore').textContent = 'Fitness: —'; $('versionSlider').disabled = true; $('versionSlider').max = '1'; $('versionSlider').value = '1'; $('versionLabel').textContent = '—';
  $('outcomeTag').value = '';
  $('aOut').textContent = $('cOut').textContent = '';
  $('aRound').textContent = $('cRound').textContent = '';
  $('statusUsage').textContent = '';
  show('setup', false); show('result', false); show('notesBox', false); show('run');
  $('statusText').textContent = 'Starting…';
  $('runAuthor').value = cfg.author; $('runCritic').value = cfg.critic; $('runModelsHint').textContent = '';
  if (!cfg.demo) pv.start(cfg);
}

// Swap Writer/Reviewer mid-volley: Apply takes effect from the next call, Retry round aborts the
// request in flight so a stalled model can be replaced without losing the run.
async function pushRunModels(retry) {
  const author = $('runAuthor').value.trim(), critic = $('runCritic').value.trim();
  const r = await pv.setRunModels({ author, critic, retry });
  if (!r?.ok) { toast(r?.message || 'No volley is running — set models in the composer instead.', 5000); return; }
  $('runModelsHint').textContent = retry ? 'Restarting this round on the new model…' : 'Applied — the next call uses it.';
  if (retry) toast('Restarting this round on the new model…', 5000);
}
$('btnSwapModels').onclick = () => pushRunModels(false);
$('btnSwapRetry').onclick = () => pushRunModels(true);
['runAuthor', 'runCritic'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pushRunModels(false); } });
});

$('btnStart').onclick = async () => { const cfg = await composeCfgFromComposer(); if (cfg) beginRun(cfg); };


// ---- Model pairs: a Writer/Reviewer combo you can reload for a particular kind of work ----
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
  const sel = $('pairSelect'); if (!sel) return;
  sel.textContent = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = 'Model pairs…';
  sel.appendChild(none);
  const rec = document.createElement('optgroup'); rec.label = 'Recommended';
  RECOMMENDED_PAIRS.forEach((p, i) => {
    const o = document.createElement('option'); o.value = `rec:${i}`; o.textContent = p.name; rec.appendChild(o);
  });
  sel.appendChild(rec);
  const names = Object.keys(loadPairs());
  if (names.length) {
    const grp = document.createElement('optgroup'); grp.label = 'Saved';
    for (const name of names) {
      const o = document.createElement('option'); o.value = `saved:${name}`; o.textContent = name; grp.appendChild(o);
    }
    sel.appendChild(grp);
  }
}
$('pairSelect').onchange = () => {
  const value = $('pairSelect').value;
  if (!value) return;
  const kind = value.slice(0, value.indexOf(':'));
  const key = value.slice(value.indexOf(':') + 1);
  const pair = kind === 'rec' ? RECOMMENDED_PAIRS[Number(key)] : loadPairs()[key];
  if (!pair) return;
  $('author').value = pair.author; $('critic').value = pair.critic;
  store.set('author', pair.author); store.set('critic', pair.critic);
  $('pairHelp').textContent = pair.note || `${prettyModel(pair.author)} writes, ${prettyModel(pair.critic)} reviews.`;
};
$('btnSavePair').onclick = () => {
  const author = $('author').value.trim(), critic = $('critic').value.trim();
  if (!author || !critic) { toast('Fill in both the Writer and Reviewer first.', 4000); return; }
  const pairs = loadPairs();
  const base = `${prettyModel(author)} + ${prettyModel(critic)}`;
  let name = base, n = 2;
  while (pairs[name]) name = `${base} (${n++})`;
  pairs[name] = { author, critic }; storePairs(pairs); refreshPairSelect();
  $('pairSelect').value = `saved:${name}`;
  $('pairHelp').textContent = `Saved “${name}” — it is in the Saved group of this list from now on.`;
  toast(`Saved model pair “${name}”.`, 4000);
};
$('btnDelPair').onclick = () => {
  const value = $('pairSelect').value;
  if (!value.startsWith('saved:')) { toast('Only your saved pairs can be deleted — recommended ones are built in.', 4000); return; }
  const key = value.slice(6), pairs = loadPairs();
  if (!pairs[key]) return;
  delete pairs[key]; storePairs(pairs); refreshPairSelect();
  $('pairHelp').textContent = `Deleted “${key}”.`;
};
refreshPairSelect();
populateProviderSelects();

// ---- Presets: save/load a whole composer state (idea + models + settings knobs) ----
const PRESETS_KEY = 'vpPresets';
const STARTER_PRESETS = {
  mvp: { name: 'Focused MVP', project: 'New MVP', rounds: 2, auto: false, idea: 'Build a small, polished app for [target users] that helps them [primary goal]. Start with the smallest useful version. Describe the main user flow, essential screens, data to store, important empty/error states, and clear testable completion criteria. Avoid accounts, paid services, and unnecessary dependencies unless essential.' },
  product: { name: 'Distinctive product website', project: 'Product website', rounds: 3, auto: false, idea: 'Design and build a distinctive, high-impact landing page for [product] aimed at [audience]. Explain the product value within the first screen, show its real workflow with [available screenshots/demos], establish a coherent visual direction, and include responsive, accessible interactions and a clear call to action. Define the sections, content, and measurable done criteria. Do not invent product capabilities or add a backend.' },
  bugfix: { name: 'Focused bug fix', project: 'Bug fix', rounds: 2, auto: false, idea: 'Investigate and fix this bug: [describe observed behavior]. Expected behavior: [describe expected behavior]. Reproduce it, trace the cause before editing, make the smallest safe fix, and add or update a focused regression check. Preserve existing conventions and avoid unrelated refactors. Report files changed and checks actually run.' },
};
const loadPresets = () => { try { return JSON.parse(store.get(PRESETS_KEY, '{}')) || {}; } catch { return {}; } };
function refreshPresetSelect() {
  const sel = $('presetSelect'); if (!sel) return;
  const presets = loadPresets();
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— starter templates + saved setups —';
  sel.appendChild(none);
  const starters = document.createElement('optgroup'); starters.label = 'Starter templates';
  for (const [id, preset] of Object.entries(STARTER_PRESETS)) {
    const o = document.createElement('option'); o.value = `starter:${id}`; o.textContent = preset.name; starters.appendChild(o);
  }
  sel.appendChild(starters);
  const savedGroup = document.createElement('optgroup'); savedGroup.label = `Your saved setups (${Object.keys(presets).length})`;
  for (const name of Object.keys(presets).sort()) {
    const o = document.createElement('option'); o.value = `saved:${name}`; o.textContent = name; savedGroup.appendChild(o);
  }
  sel.appendChild(savedGroup);
}
$('btnSavePreset').onclick = async () => {
  // window.prompt() THROWS in Electron renderers, so the shared modal is used instead.
  const entered = await askText({ title: 'Save preset', label: 'Preset name', placeholder: 'e.g. My MVP', okLabel: 'Save' });
  if (entered === null) return;
  const name = String(entered).trim();
  if (!name) return;
  const presets = loadPresets();
  if (presets[name]) {
    const ok = await askConfirm({ title: 'Overwrite preset?', message: `"${name}" already exists. Replace it?`, okLabel: 'Overwrite' });
    if (!ok) return;
  }
  const s = loadSettings();
  presets[name] = {
    idea: $('idea').value,
    project: $('projectName').value.trim(),
    author: $('author').value.trim(), critic: $('critic').value.trim(),
    rounds: +$('rounds').value || 3, auto: $('auto').checked,
    settings: { fallback: s.fallback || '', imgMode: s.imgMode || 'auto', recent: s.recent | 0 || 0, rubric: s.rubric || '', budget: Number(s.budget) || 0 },
  };
  store.set(PRESETS_KEY, JSON.stringify(presets));
  refreshPresetSelect(); $('presetSelect').value = `saved:${name}`;
  toast(`Preset "${name}" saved.`, 4000);
};
$('presetSelect').onchange = () => {
  const value = $('presetSelect').value;
  const p = value.startsWith('starter:') ? STARTER_PRESETS[value.slice(8)]
    : value.startsWith('saved:') ? loadPresets()[value.slice(6)] : null;
  if (!p) return;
  $('idea').value = p.idea || ''; $('projectName').value = p.project || '';
  if (p.author) $('author').value = p.author;
  if (p.critic) $('critic').value = p.critic;
  $('rounds').value = p.rounds || 3; $('auto').checked = !!p.auto;
  if (p.settings) saveSettings({ ...loadSettings(), ...p.settings });
  refreshVisionHints();
  toast(value.startsWith('starter:') ? `Starter loaded: ${p.name}. Edit the bracketed details.` : 'Saved setup loaded.', 5000);
};
$('btnDelPreset').onclick = () => {
  const value = $('presetSelect').value;
  if (!value.startsWith('saved:')) { toast('Choose one of your saved setups to delete; starter templates can’t be deleted.', 5000); return; }
  const name = value.slice(6), presets = loadPresets();
  if (!presets[name]) return;
  delete presets[name];
  store.set(PRESETS_KEY, JSON.stringify(presets));
  refreshPresetSelect();
  toast(`Saved setup "${name}" deleted.`, 4000);
};
refreshPresetSelect();

// 2. Render a revision round as a line diff instead of a silent full rewrite.
function escapeHtml(s) { return s.replace(/[&<>"]'/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function diffOps(A, B) {
  if (A.length * B.length > 160000) return null; // absurdly long prompt — plain text wins
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
  // Collapse long unchanged runs to head+tail lines so the changes stay visible.
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

// 9. Inline FREE vision-model suggestions when images are attached but the Reviewer can't see them.
function refreshVisionHints() {
  const hints = $('visionHints');
  if (!hints) return;
  const criticId = ($('critic').value || '').trim();
  const hasImages = pendingAttachments.some((a) => IMAGE_EXT.has(extOf(a.file.name)));
  const row = MODEL_ROWS.find((r) => r.id === criticId);
  if (!hasImages || criticId === '') { hints.classList.add('hidden'); return; }
  const suggestions = MODEL_ROWS.filter((r) => r.isFree && r.vision && r.id !== criticId).slice(0, 3);
  if (!suggestions.length || (row && row.vision)) { hints.classList.add('hidden'); return; }
  hints.textContent = row && !row.vision
    ? '⚠ This Reviewer can’t see images — suggested FREE vision models: '
    : 'Image support unknown for this model — suggested FREE vision models: ';
  for (const s of suggestions) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'vision-chip'; b.textContent = s.id;
    b.onclick = () => { $('critic').value = s.id; refreshVisionHints(); };
    hints.appendChild(b);
  }
  hints.classList.remove('hidden');
}

$('btnStop').onclick = () => {
  pv.stop();
};
$('btnContinue').onclick = () => {
  const notes = $('notes').value; $('notes').value = '';
  const selectedIssues = [...document.querySelectorAll('#reviewIssues input:checked')].map((x) => x.value);
  show('notesBox', false); show('reviewIssues', false);
  pv.sendNotes({ notes, selectedIssues });
};
$('btnFinish').onclick = () => { show('notesBox', false); show('reviewIssues', false); pv.sendNotes(null); };
$('btnCopy').onclick = async () => { await pv.copy($('final').value); if (currentHistoryName) $('outcomeTag').value = 'used'; toast('Copied! Paste it into your coding AI.', 3000); if (currentHistoryName) pv.updateRun(currentHistoryName, { outcome: 'used' }); };
$('btnCopyMd').onclick = async () => {
  const m = lastRunMeta;
  const head = m
    ? `> VolleyPrompt — ${m.when}\n> Writer: ${m.author} · Reviewer: ${m.critic} · max rounds: ${m.rounds}\n\n`
    : '> VolleyPrompt volley (from history)\n\n';
  await pv.copy(head + $('final').value);
  toast('Copied as Markdown, with the volley header.', 4000);
};
$('btnBack').onclick = () => { show('result', false); show('run', false); show('setup'); $('idea').focus(); };
document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { await pv.copy($(b.dataset.copy).textContent); toast('Copied!', 1500); });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const setupOpen = !$('setup').classList.contains('hidden');
  if (e.key === 'Enter' && setupOpen) { $('btnStart').click(); return; }
  if (setupOpen) {
    // Keyboard-first flow: Ctrl+K/Ctrl+1 → Writer field, Ctrl+2 → Reviewer field.
    if (e.key === 'k' || e.key === '1') { e.preventDefault(); $('author').focus(); }
    else if (e.key === '2') { e.preventDefault(); $('critic').focus(); }
  }
});
$('btnAgain').onclick = () => { show('result', false); show('run', false); show('setup'); };
$('utilityClose').onclick = () => show('utilityOutput', false);
$('outcomeTag').onchange = () => { if (currentHistoryName && $('outcomeTag').value) pv.updateRun(currentHistoryName, { outcome: $('outcomeTag').value }); };

// ---- Custom dropdowns -------------------------------------------------------
// Electron/Windows draws a native <select> popup itself, in OS grey, and ignores every
// option colour we set. So the real <select> stays in the DOM (all existing value/onchange
// logic keeps working, untouched) but is made invisible and driven by this styled list.
function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  const wrap = document.createElement('div'); wrap.className = 'select-wrap';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'select-trigger';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span'); label.className = 'select-label';
  const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▾'; chev.setAttribute('aria-hidden', 'true');
  btn.append(label, chev);
  const menu = document.createElement('div'); menu.className = 'select-menu hidden'; menu.setAttribute('role', 'listbox');
  sel.parentNode.insertBefore(wrap, sel); wrap.append(sel, btn, menu);
  const rows = () => [...menu.children];
  const render = () => {
    const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    const full = cur ? cur.textContent : '';
    // Long option text ("Auto — images when the Reviewer supports vision…") stays in the
    // list; the closed trigger shows just the leading keyword so it never wraps.
    label.textContent = full.split(' — ')[0];
    btn.title = full;
    btn.dataset.value = sel.value;
    rows().forEach((r) => r.setAttribute('aria-selected', String(r.dataset.value === sel.value)));
  };
  const build = () => {
    menu.textContent = '';
    [...sel.options].forEach((o) => {
      const row = document.createElement('div');
      row.className = 'select-option'; row.setAttribute('role', 'option'); row.dataset.value = o.value;
      row.textContent = o.textContent;
      row.addEventListener('click', () => { pick(o.value); close(); btn.focus(); });
      menu.append(row);
    });
    render();
  };
  const pick = (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); render(); };
  const active = () => rows().find((r) => r.classList.contains('active'));
  const move = (dir) => {
    const list = rows(); if (!list.length) return;
    const i = list.indexOf(active());
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? (dir > 0 ? -1 : 0) : i) + dir))];
    list.forEach((r) => r.classList.remove('active'));
    next.classList.add('active'); next.scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    menu.classList.remove('hidden'); wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    const cur = rows().find((r) => r.getAttribute('aria-selected') === 'true') || rows()[0];
    if (cur) { rows().forEach((r) => r.classList.remove('active')); cur.classList.add('active'); cur.scrollIntoView({ block: 'nearest' }); }
  };
  function close() { menu.classList.add('hidden'); wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); rows().forEach((r) => r.classList.remove('active')); }
  const toggle = () => (menu.classList.contains('hidden') ? open() : close());
  btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.classList.contains('hidden')) open(); else { const a = active(); if (a) pick(a.dataset.value); close(); } }
    else if (e.key === 'Escape') { close(); }
  });
  // Any other click (or leaving the app) closes the list.
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  window.addEventListener('blur', close);
  // Programmatic `sel.value = …` happens in several places; keep the label in sync automatically.
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (desc?.get && desc?.set) Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(sel); }, set(v) { desc.set.call(sel, v); render(); } });
  // Drop the <label> association: clicking the caption would otherwise open the invisible
  // native select's grey popup on top of our menu. The trigger carries the name instead.
  const lab = sel.closest('label');
  if (lab) { sel.setAttribute('aria-label', lab.textContent.replace(/\s+/g, ' ').trim() || 'Choose an option'); lab.htmlFor = ''; }
  build();
}
enhanceSelect($('outcomeTag'));
enhanceSelect($('setImgMode'));
$('outcomeTag').setAttribute('aria-label', 'Outcome rating — help measure prompt usefulness');
$('versionSlider').oninput = () => {
  const idx = Number($('versionSlider').value) - 1, snap = runSnapshots[idx];
  if (!snap) return;
  $('final').value = snap.draft;
  $('fitnessScore').textContent = `Fitness: ${snap.score == null ? '—' : `${snap.score}/100`} · ${snap.verdict || ''}`;
  $('versionLabel').textContent = `Round ${snap.round}`;
};
async function runUtility(kind, instruction = '') {
  const model = MODEL_ROWS.find((r) => r.id === (lastRunMeta?.author || $('author').value)) || MODEL_ROWS.find((r) => r.isFree) || MODEL_ROWS[0];
  if (!model) { toast('Load the model list first.', 5000); return; }
  if (!model.isFree && !confirm(`This ${kind} helper will make an extra API call using ${model.id} (estimated from catalog pricing). Continue?`)) return;
  show('utilityOutput'); $('utilityTitle').textContent = `${kind} · ${model.isFree ? 'FREE model' : model.id} · working…`; $('utilityText').textContent = '';
  try {
    const result = await pv.utility({ kind, model: model.id, prompt: $('final').value, instruction: String(instruction || '').slice(0, 800), provider: $('authorProvider')?.value || 'openrouter' });
    $('utilityTitle').textContent = `${kind} · ${result.usage ? `${result.usage.total_tokens || '?'} tokens` : 'usage unavailable'} · ${(result.elapsedMs / 1000).toFixed(1)}s`;
    $('utilityText').textContent = result.text || '(empty response)';
  } catch (e) { $('utilityTitle').textContent = `${kind} failed`; $('utilityText').textContent = e.message || String(e); }
}
$('btnTestDrive').onclick = () => runUtility('testdrive');
$('btnAnnotate').onclick = () => runUtility('annotate');
// Variant takes optional instructions, so you can steer what the alternative changes.
$('btnVariant').onclick = () => {
  show('variantBox');
  $('variantInstruction').focus();
};
$('btnVariantGo').onclick = () => {
  const instruction = $('variantInstruction').value.trim();
  show('variantBox', false);
  runUtility('variant', instruction);
};
$('btnVariantCancel').onclick = () => show('variantBox', false);
$('variantInstruction').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('btnVariantGo').click(); }
});
$('btnCursor').onclick = async () => { await pv.copy($('final').value); await pv.openUrl('cursor://'); toast('Prompt copied. Cursor is opening if installed.', 5000); };
function replayHtml() {
  const title = escapeHtml(lastRunMeta?.project || 'VolleyPrompt replay');
  const snapshots = JSON.stringify(runSnapshots).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>VolleyPrompt replay</title><style>body{background:#080611;color:#e8e2ff;font:16px system-ui;max-width:900px;margin:3em auto;padding:0 2em}pre{white-space:pre-wrap;background:#151020;padding:1em;border-radius:12px}button{padding:.7em 1em;margin:.3em}</style><h1>VolleyPrompt · ${title}</h1><div id="v"></div><button id="p">← Previous</button><button id="n">Next →</button><script>const s=${snapshots};let i=0;function r(){const x=s[i];document.querySelector('#v').innerHTML='<h2>Round '+x.round+' · Fitness '+(x.score??'—')+'/100 · '+x.verdict+'</h2><h3>Draft</h3><pre>'+x.draft.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</pre><h3>Review</h3><pre>'+x.review.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</pre>'}document.querySelector('#p').onclick=()=>{i=Math.max(0,i-1);r()};document.querySelector('#n').onclick=()=>{i=Math.min(s.length-1,i+1);r()};r();</script>`;
}
let replayIdx = 0;
function renderReplay() {
  const snap = runSnapshots[replayIdx];
  if (!snap) return;
  $('replaySlider').value = String(replayIdx + 1);
  $('replayDraftHead').textContent = `Draft · Round ${snap.round}`;
  $('replayReviewHead').textContent = `Review · ${snap.score == null ? 'no score' : snap.score + '/100'} · ${snap.verdict || ''}`;
  $('replayDraft').textContent = snap.draft || '';
  $('replayReview').textContent = snap.review || '';
  $('replayPrev').disabled = replayIdx === 0;
  $('replayNext').disabled = replayIdx >= runSnapshots.length - 1;
}
$('btnReplay').onclick = () => {
  if (!runSnapshots.length) { toast('No rounds recorded for this volley yet.', 6000); return; }
  replayIdx = runSnapshots.length - 1;
  $('replaySlider').max = String(runSnapshots.length);
  const when = lastRunMeta?.when ? ` · ${lastRunMeta.when}` : '';
  $('replayMeta').textContent = `${escapeHtml(lastRunMeta?.project || 'Untitled')} · ${runSnapshots.length} round${runSnapshots.length === 1 ? '' : 's'}${when} — step through each Draft ↔ Review exchange.`;
  show('replayModal');
  renderReplay();
};
$('replayClose').onclick = () => show('replayModal', false);
$('replayModal').addEventListener('click', (e) => { if (e.target === $('replayModal')) show('replayModal', false); });
$('replayPrev').onclick = () => { if (replayIdx > 0) { replayIdx--; renderReplay(); } };
$('replayNext').onclick = () => { if (replayIdx < runSnapshots.length - 1) { replayIdx++; renderReplay(); } };
$('replaySlider').oninput = () => { const i = Number($('replaySlider').value) - 1; if (i >= 0 && i < runSnapshots.length) { replayIdx = i; renderReplay(); } };
$('replayDownload').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([replayHtml()], { type: 'text/html' })); a.download = 'volleyprompt-replay.html'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('btnShareCard').onclick = () => {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 630; const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, 1200, 630); g.addColorStop(0, '#090719'); g.addColorStop(1, '#152342'); c.fillStyle = g; c.fillRect(0, 0, 1200, 630);
  c.fillStyle = '#00efff'; c.font = 'bold 32px sans-serif'; c.fillText('VOLLEY PROMPT', 64, 78);
  c.fillStyle = '#f7f3ff'; c.font = 'bold 42px sans-serif'; const lines = $('final').value.slice(0, 220).match(/.{1,44}(?:\s|$)/g) || [];
  lines.slice(0, 7).forEach((line, i) => c.fillText(line.trim(), 64, 170 + i * 52));
  c.fillStyle = '#22f9a6'; c.font = 'bold 28px sans-serif'; c.fillText($('fitnessScore').textContent, 64, 570);
  canvas.toBlob((blob) => { if (!blob) return toast('Could not create image.', 4000); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'volleyprompt-card.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
};
$('btnDemo').onclick = async () => {
  if (demoRunning) return; demoRunning = true;
  show('modal', false); // the demo lives in the key dialog, so close it before playing
  const demo = [
    { round: 1, score: 48, verdict: 'REVISE', draft: 'Build a beautiful productivity app.', review: '1. HIGH — The target user and core workflow are unspecified.\n2. MED — No platform or completion criteria.\nFITNESS SCORE: 48/100\nVERDICT: REVISE' },
    { round: 2, score: 84, verdict: 'APPROVE', draft: 'Build a keyboard-first daily planner for solo freelancers.\n\nCore flow: capture tasks, set a due date, and review a focused Today list.\n\nConstraints: responsive web app; local persistence; accessible keyboard navigation; no account or paid service.\n\nDone when: tasks survive refresh, keyboard-only flows work, and empty/error states are covered by tests.', review: 'No HIGH issues remain.\nFITNESS SCORE: 84/100\nVERDICT: APPROVE' },
  ];
  beginRun({ idea: 'Demo: make a daily planner', author: 'Prerecorded demo', critic: 'Prerecorded demo', rounds: 2, project: 'Demo', demo: true });
  for (const snap of demo) {
    await new Promise((r) => setTimeout(r, 650)); runSnapshots.push(snap);
    $('aOut').textContent = snap.draft; $('cOut').textContent = snap.review;
    $('statusText').textContent = `Demo · round ${snap.round} · ${snap.verdict}`;
    $('fitnessScore').textContent = `Fitness: ${snap.score}/100 · ${snap.verdict}`;
  }
  $('final').value = demo[1].draft; $('versionSlider').disabled = false; $('versionSlider').max = '2'; $('versionSlider').value = '2'; $('versionLabel').textContent = 'Round 2';
  show('run', false); show('result'); $('savedAt').textContent = 'Prerecorded walkthrough · no key or API calls used.'; demoRunning = false;
};
// Collapse/expand the result card in place — a loaded history prompt shouldn't dominate the page.
$('resultHead').addEventListener('click', () => {
  const collapsed = $('result').classList.toggle('collapsed');
  $('resultCollapse').textContent = collapsed ? '▸' : '▾';
});

// ---- Attachment UI shell (Phase 2 — local-only, not wired into pv.start) ----
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.md', '.markdown', '.json', '.csv', '.js', '.jsx', '.ts', '.tsx', '.py', '.html', '.htm', '.css']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
// Desktop: a beefier budget is fine — payloads stay local until the request is sent.
// Note individual OpenRouter providers may still reject very large image payloads.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10;
let pendingAttachments = [];
let attachmentIdSeq = 0;

const extOf = (name) => { const i = name.lastIndexOf('.'); return i === -1 ? '' : name.slice(i).toLowerCase(); };
const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const isDuplicateFile = (file) => pendingAttachments.some((a) => a.file.name === file.name && a.file.size === file.size && a.file.lastModified === file.lastModified);

function addAttachmentFiles(fileList) {
  const rejected = [];
  for (const file of Array.from(fileList)) {
    const ext = extOf(file.name);
    if (!ALLOWED_EXT.has(ext)) { rejected.push(`${file.name} (unsupported type)`); continue; }
    if (file.size > MAX_FILE_BYTES) { rejected.push(`${file.name} (over 25 MB)`); continue; }
    if (isDuplicateFile(file)) continue;
    if (pendingAttachments.length >= MAX_FILES) { rejected.push(`${file.name} (max ${MAX_FILES} attachments)`); continue; }
    let url = null;
    if (IMAGE_EXT.has(ext)) { try { url = URL.createObjectURL(file); } catch { url = null; } }
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
  const tray = $('attachment-tray');
  if (!tray) return;
  tray.textContent = '';
  const attachedCount = pendingAttachments.length + pendingFolders.filter((f) => f.status === 'ready').length;
  tray.classList.toggle('hidden', attachedCount === 0 && pendingFolders.length === 0);
  if (attachedCount || pendingFolders.some((f) => f.status === 'processing')) {
    const status = document.createElement('div');
    status.className = 'attachment-status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = pendingFolders.some((f) => f.status === 'processing')
      ? 'Reading project context…'
      : `✓ ${attachedCount} context source${attachedCount === 1 ? '' : 's'} attached · included with the next volley`;
    tray.appendChild(status);
  }
  for (const f of pendingFolders) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip folder-chip' + (f.status === 'processing' ? ' processing' : '');

    const isGithub = f.kind === 'github';
    const thumb = document.createElement('div');
    thumb.className = 'chip-thumb';
    thumb.textContent = isGithub ? '🐙' : '📁';

    const info = document.createElement('div');
    info.className = 'chip-info';
    const name = document.createElement('span');
    name.className = 'chip-name'; name.title = f.name; name.textContent = (isGithub ? 'GitHub · ' : '') + f.name;
    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = f.status === 'processing'
      ? `Reading… (${f.files.length}/${f.fileCount})`
      : `✓ ${isGithub ? 'GitHub repo' : 'folder'} attached · included next run · ${f.fileCount} file${f.fileCount === 1 ? '' : 's'}${f.bytes ? ' · ' + formatSize(f.bytes) : ''}`;
    info.append(name, size);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'chip-remove'; removeBtn.title = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove ${f.name}`);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeFolder(f.id));

    chip.append(thumb, info, removeBtn);
    tray.appendChild(chip);
  }
  for (const a of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';

    const thumb = document.createElement('div');
    thumb.className = 'chip-thumb';
    if (a.url) {
      const img = document.createElement('img');
      img.src = a.url; img.alt = '';
      img.onerror = () => { thumb.textContent = '📄'; img.remove(); };
      thumb.appendChild(img);
    } else {
      thumb.textContent = extOf(a.file.name) === '.pdf' ? '📕' : '📄';
    }

    const info = document.createElement('div');
    info.className = 'chip-info';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = a.file.name;
    name.title = a.file.name;
    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = formatSize(a.file.size) + (a.scaledDataUrl ? ' · ⤓ compressed' : '');
    info.append(name, size);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chip-remove';
    removeBtn.title = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove ${a.file.name}`);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeAttachment(a.id));

    const chipKids = [thumb, info];
    if (IMAGE_EXT.has(extOf(a.file.name))) {
      // "Reduce further": re-encode a stubborn image stricter without editing thresholds —
      // the compressed version replaces whichever version would have been sent.
      const shrink = document.createElement('button');
      shrink.type = 'button'; shrink.className = 'chip-remove'; shrink.title = 'Re-encode smaller (max 1024px)';
      shrink.setAttribute('aria-label', `Re-encode ${a.file.name} smaller`);
      shrink.textContent = '⤓';
      shrink.addEventListener('click', async () => {
        shrink.disabled = true;
        try {
          a.scaledDataUrl = await downscaleForVision(a.file, 1024, 0.75, true);
          renderAttachments();
          toast(`"${a.file.name}" re-encoded → ~${Math.round(a.scaledDataUrl.length * 0.75 / 1024)} KB sent version.`, 6000);
        } catch (e) {
          shrink.disabled = false;
          toast('⚠ Could not re-encode that image.', 6000);
        }
      });
      chipKids.push(shrink);
    }
    chipKids.push(removeBtn);
    chip.append(...chipKids);
    tray.appendChild(chip);
  }
  refreshVisionHints();
}

// ---- Phase 5: project-folder context (filtered, size-capped, read off the main thread's path) ----
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage', 'vendor', 'venv', '.venv', '__pycache__', '.idea', '.vscode']);
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.env', '.env.local', '.env.production']);
const IGNORED_FILE_PATTERNS = [/^\.env(\..+)?$/i, /\.lock$/i, /^package-lock\.json$/i, /^yarn\.lock$/i, /^pnpm-lock\.yaml$/i, /\.map$/i, /\.min\.(js|css)$/i, /\.(pem|key|crt|pfx|p12)$/i];
// Allowlist, not a blocklist: images/binaries are simply never in this set, so they're
// skipped without needing a separate "ignored binary extensions" list to maintain.
const FOLDER_ALLOWED_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.html', '.css', '.scss', '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.xml', '.svg', '.sql', '.sh', '.bat', '.ps1', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.vue', '.svelte']);
const MAX_FOLDER_FILES = 400;
const MAX_FOLDER_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_FOLDER_FILE_BYTES = 768 * 1024;
const MAX_FOLDERS = 8;
const FOLDER_READ_BATCH = 8;

let pendingFolders = [];
let foldersProcessingCount = 0;

function isFolderPathIgnored(relPath) {
  const segs = relPath.split('/');
  const base = segs[segs.length - 1];
  // Any dot-directory (.github, .cache, …) and any dotfile is skipped — they are tooling
  // metadata, not code the models need, and cheaply cut thousands of irrelevant entries.
  if (segs.slice(0, -1).some((s) => IGNORED_DIR_NAMES.has(s) || s.startsWith('.'))) return true;
  if (base.startsWith('.')) return true;
  if (IGNORED_FILE_NAMES.has(base)) return true;
  return IGNORED_FILE_PATTERNS.some((rx) => rx.test(base));
}

// Relevance ranking for oversized folder selections: when more than MAX_FOLDER_FILES files
// are selected, the top of this ranking is what gets read. Entry points and configs first,
// then source code, then docs/styles, then everything else; shallower paths beat deeper
// ones at the same tier so a project's core files outrank nested utilities.
const CONTEXT_KEY_FILE_RX = /(^|\/)(readme[^/]*|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements[^/]*|composer\.json|gemfile|makefile|dockerfile[^/]*|tsconfig[^/]*|vite\.config\.[^/]*|webpack\.config\.[^/]*|tailwind\.config\.[^/]*|main\.[a-z]+|index\.[a-z]+|app\.[a-z]+|server\.[a-z]+|routes?\.[a-z]+|config\.[a-z]+)$/i;
const CONTEXT_EXT_RANK = { '.ts': 0, '.tsx': 0, '.js': 0, '.jsx': 0, '.mjs': 0, '.cjs': 0, '.py': 0, '.cs': 1, '.go': 1, '.rs': 1, '.java': 1, '.c': 1, '.cpp': 1, '.h': 1, '.hpp': 1, '.php': 1, '.vue': 1, '.svelte': 1, '.md': 2, '.html': 2, '.css': 2, '.scss': 2, '.sql': 2, '.sh': 2, '.bat': 2, '.ps1': 2, '.json': 2, '.yaml': 2, '.yml': 2, '.toml': 2, '.xml': 2, '.svg': 3, '.txt': 3 };
function rankContextFiles(entries) {
  return entries.map((e) => {
    const path = e.path || e.name || '';
    const depth = path.split('/').length;
    const tier = CONTEXT_KEY_FILE_RX.test(path) ? 0 : (CONTEXT_EXT_RANK[extOf(path)] ?? 4);
    return { e, score: tier * 1000 + depth * 10 + path.length / 100 };
  }).sort((a, b) => a.score - b.score).map((x) => x.e);
}

function setProcessingLock(on) {
  const btn = $('btnStart');
  btn.disabled = on;
  if (on) { btn.dataset.prevLabel = btn.dataset.prevLabel || btn.textContent; btn.textContent = 'Reading project folder…'; }
  else if (btn.dataset.prevLabel) { btn.textContent = btn.dataset.prevLabel; delete btn.dataset.prevLabel; }
}
function beginFolderProcessing() { foldersProcessingCount++; setProcessingLock(true); }
function endFolderProcessing() { foldersProcessingCount = Math.max(0, foldersProcessingCount - 1); if (foldersProcessingCount === 0) setProcessingLock(false); }

function removeFolder(id) {
  const idx = pendingFolders.findIndex((f) => f.id === id);
  if (idx === -1) return;
  const [removed] = pendingFolders.splice(idx, 1);
  removed.aborted = true; // lets an in-flight read batch notice and stop applying results
  renderAttachments();
}

// Reads the given (already-validated) entries off the main thread's path into a pendingFolders
// entry, batch by batch, exactly like Phase 5 did — shared by the explorer's "Attach selected".
// brief=true = project brief mode: full text only for key files (README, package.json, entry
// points…); everything else becomes a tree with on-disk sizes — far cheaper per token and
// usually better review context than 50 raw files.
const KEY_FILE_RE = /(^|\/)(readme|license|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|makefile|dockerfile)(\.|$)|(^|\/)(main|index|app)\.[a-z0-9]{1,4}$/i;
const BRIEF_TEXT_BUDGET = 48 * 1024;
async function readEligibleIntoFolder(entries, rootName, brief) {
  const folder = { id: 'folder-' + (++attachmentIdSeq), kind: 'folder', name: rootName, status: 'processing', aborted: false, files: [], fileCount: entries.length };
  pendingFolders.push(folder);
  renderAttachments();
  beginFolderProcessing();
  try {
    if (brief) {
      let budget = BRIEF_TEXT_BUDGET;
      for (const e of entries) {
        if (folder.aborted) return;
        if (!KEY_FILE_RE.test(e.path) || budget <= 0) continue;
        const t = await readFileAsText(e.file).catch(() => null);
        if (t == null || t.length > budget) continue;
        folder.files.push({ path: e.path, text: t });
        budget -= t.length;
      }
      if (folder.aborted) return;
      // One synthetic entry carries the tree (paths + sizes); models reference it for
      // structure while the key files above provide the real code.
      folder.files.unshift({
        path: 'PROJECT-FILES.txt',
        text: `${entries.length} files in "${rootName}" — every file listed below with its size; only the key files attached alongside carry full contents.

` + entries.map((e) => `${e.path}  (${formatSize(e.file.size)})`).join('\n'),
      });
    } else {
    for (let i = 0; i < entries.length; i += FOLDER_READ_BATCH) {
      if (folder.aborted) return;
      const batch = entries.slice(i, i + FOLDER_READ_BATCH);
      const texts = await Promise.all(batch.map((e) => readFileAsText(e.file).catch(() => null)));
      if (folder.aborted) return;
      batch.forEach((e, idx) => { if (texts[idx] !== null) folder.files.push({ path: e.path, text: texts[idx] }); });
      renderAttachments();
    }
    }
    if (folder.aborted) return;
    const skipped = entries.length - folder.files.length;
    folder.status = 'ready'; folder.fileCount = folder.files.length;
    folder.bytes = folder.files.reduce((sum, f) => sum + new TextEncoder().encode(f.text).length, 0);
    renderAttachments();
    toast(`Attached "${rootName}" ✓ — ${brief ? `brief: tree of ${entries.length} files + ` : ''}${folder.files.length} file${folder.files.length === 1 ? '' : 's'}${brief ? '' : `, ${formatSize(folder.bytes)} of code`}${skipped ? ` · ${skipped} skipped` : ''}.`, 7000);
  } catch (e) {
    if (!folder.aborted) {
      removeFolder(folder.id);
      toast(`Could not read "${rootName}": ${e.message || e}`, 8000);
    }
  } finally {
    endFolderProcessing();
  }
}

// ---- Phase 6: Project Context Explorer — tri-state folder tree, lazily rendered ----
const CTX_RENDER_BATCH = 200;
let ctxState = null; // { rootName, fileMap: Map<relPath,File>, tree, selected: Set<relPath> }
const ctxExplorerQueue = []; // dropped folders waiting while the explorer is open
function queueContextExplorer(files) {
  if (ctxState) ctxExplorerQueue.push(files); else openContextExplorer(files);
}

function buildFolderTree(eligible) {
  const root = { name: '', type: 'dir', path: '', children: new Map() };
  for (const { path, file } of eligible) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLeaf = i === segs.length - 1;
      const childPath = node.path ? `${node.path}/${seg}` : seg;
      if (!node.children.has(seg)) {
        node.children.set(seg, isLeaf
          ? { name: seg, type: 'file', path: childPath, size: file.size, file }
          : { name: seg, type: 'dir', path: childPath, children: new Map() });
      }
      node = node.children.get(seg);
    }
  }
  return root;
}

const sortedChildren = (node) => Array.from(node.children.values()).sort((a, b) =>
  a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));

// Memoized: the tree is static once built, so each directory's flattened file list is computed once.
function descendantFiles(node) {
  if (node.type === 'file') return [node];
  if (node._files) return node._files;
  const out = [];
  for (const c of node.children.values()) out.push(...descendantFiles(c));
  node._files = out;
  return out;
}

function nodeSelectionState(node) {
  const files = descendantFiles(node);
  if (!files.length) return 'none';
  let selCount = 0;
  for (const f of files) if (ctxState.selected.has(f.path)) selCount++;
  return selCount === 0 ? 'none' : selCount === files.length ? 'all' : 'some';
}

function toggleNodeSelection(node, checked) {
  for (const f of descendantFiles(node)) { if (checked) ctxState.selected.add(f.path); else ctxState.selected.delete(f.path); }
  refreshCheckboxStates();
  refreshExplorerSummary();
}

// Walks the whole (in-memory, not just rendered) tree so every checkbox that *has* been
// rendered gets its checked/indeterminate state resynced from the selection Set — covers
// bulk toggles on folders whose children aren't all in the DOM yet.
function refreshCheckboxStates(node = ctxState.tree) {
  if (node._el) {
    const state = nodeSelectionState(node);
    node._el.cb.checked = state === 'all';
    node._el.cb.indeterminate = state === 'some';
  }
  if (node.type === 'dir') for (const c of node.children.values()) refreshCheckboxStates(c);
}

function renderCtxNode(node) {
  const li = document.createElement('li');
  li.className = 'ctx-node ' + (node.type === 'dir' ? 'ctx-dir' : 'ctx-file');
  const row = document.createElement('div');
  row.className = 'ctx-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'ctx-check'; cb.dataset.path = node.path;
  cb.onclick = (e) => { e.stopPropagation(); toggleNodeSelection(node, cb.checked); };

  if (node.type === 'dir') {
    const chevron = document.createElement('button');
    chevron.type = 'button'; chevron.className = 'ctx-chevron'; chevron.textContent = '▶';
    chevron.setAttribute('aria-expanded', 'false');
    const childUl = document.createElement('ul');
    childUl.className = 'ctx-children hidden';
    chevron.onclick = (e) => {
      e.stopPropagation();
      const expanded = chevron.getAttribute('aria-expanded') === 'true';
      chevron.setAttribute('aria-expanded', String(!expanded));
      chevron.textContent = expanded ? '▶' : '▼';
      childUl.classList.toggle('hidden', expanded);
      if (!expanded && node._rendered === undefined) renderCtxChildrenBatch(node, childUl);
    };
    const label = document.createElement('span');
    label.className = 'ctx-label'; label.textContent = `📁 ${node.name}`;
    const files = descendantFiles(node);
    const count = document.createElement('span');
    count.className = 'ctx-count'; count.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    row.append(chevron, cb, label, count);
    li.append(row, childUl);
    node._el = { cb };
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'ctx-spacer';
    const label = document.createElement('span');
    label.className = 'ctx-label'; label.textContent = `📄 ${node.name}`;
    const size = document.createElement('span');
    size.className = 'ctx-size'; size.textContent = formatSize(node.size);
    row.append(spacer, cb, label, size);
    li.append(row);
    node._el = { cb };
  }
  return li;
}

// Only renders the next CTX_RENDER_BATCH children of `node` into `ul` — keeps directories
// with hundreds/thousands of entries from freezing the DOM on first expand.
function renderCtxChildrenBatch(node, ul) {
  const kids = sortedChildren(node);
  const start = node._rendered || 0;
  const batch = kids.slice(start, start + CTX_RENDER_BATCH);
  const frag = document.createDocumentFragment();
  for (const child of batch) frag.appendChild(renderCtxNode(child));
  const existingBtn = ul.querySelector(':scope > .ctx-load-more');
  if (existingBtn) existingBtn.remove();
  ul.appendChild(frag);
  node._rendered = start + batch.length;
  if (node._rendered < kids.length) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ctx-load-more';
    btn.textContent = `Load more (${kids.length - node._rendered} remaining)`;
    btn.onclick = (e) => { e.stopPropagation(); renderCtxChildrenBatch(node, ul); };
    ul.appendChild(btn);
  }
  refreshCheckboxStates();
}

function refreshExplorerSummary() {
  const files = Array.from(ctxState.selected, (p) => ctxState.fileMap.get(p)).filter(Boolean);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  $('ctxSelCount').textContent = String(files.length);
  $('ctxSelSize').textContent = formatSize(totalSize);
  let warn = '';
  if (files.length > MAX_FOLDER_FILES) warn = `${files.length} files selected — full code reads the ${MAX_FOLDER_FILES} most relevant; brief mode includes the whole tree.`;
  else if (totalSize > MAX_FOLDER_TOTAL_BYTES) warn = `${formatSize(totalSize)} selected — full code is trimmed to ${formatSize(MAX_FOLDER_TOTAL_BYTES)} of the most relevant files; tick "Attach as project brief" for the whole tree cheaply.`;
  const warnEl = $('ctxWarning');
  warnEl.textContent = warn;
  warnEl.classList.toggle('hidden', !warn);
  // Never blocks: oversized selections are trimmed by relevance at attach time.
  $('ctxAttach').disabled = files.length === 0;
}

function openContextExplorer(fileList) {
  const all = Array.from(fileList);
  if (!all.length) return;
  // Dropped-folder files carry their path in _vpRelPath (webkitRelativePath is read-only);
  // the picker path still uses webkitRelativePath. First segment of either is the root.
  const rootName = ((all[0]._vpRelPath || all[0].webkitRelativePath) || all[0].name).split('/')[0] || 'Project';

  // No file content is read here — only name/size/webkitRelativePath, same as Phase 5's
  // metadata-only pass. The ignore rules and extension allowlist are reused verbatim.
  const eligible = [];
  for (const file of all) {
    const rel = file._vpRelPath || file.webkitRelativePath || file.name;
    const relInFolder = rel.split('/').slice(1).join('/');
    if (!relInFolder || isFolderPathIgnored(rel)) continue;
    if (!FOLDER_ALLOWED_EXT.has(extOf(file.name))) continue;
    eligible.push({ path: relInFolder, file });
  }
  if (!eligible.length) { toast(`No supported source files found in "${rootName}".`, 6000); return; }

  ctxState = {
    rootName,
    fileMap: new Map(eligible.map((e) => [e.path, e.file])),
    tree: buildFolderTree(eligible),
    selected: new Set(eligible.map((e) => e.path)), // default: whole folder, same as pre-Phase-6 behavior
  };

  $('ctxRootLabel').textContent = `📁 ${rootName} — ${eligible.length} eligible file${eligible.length === 1 ? '' : 's'}`;
  const treeEl = $('ctxTree');
  treeEl.textContent = '';
  const rootUl = document.createElement('ul');
  rootUl.className = 'ctx-children';
  renderCtxChildrenBatch(ctxState.tree, rootUl);
  treeEl.appendChild(rootUl);
  refreshExplorerSummary();
  show('contextModal');
}

function closeContextExplorer() {
  show('contextModal', false); ctxState = null;
  // Multiple folders queued (e.g. a multi-folder drag-drop): open the next one.
  if (ctxExplorerQueue.length) setTimeout(() => openContextExplorer(ctxExplorerQueue.shift()), 0);
}
$('ctxExplorerClose').onclick = closeContextExplorer;
$('ctxCancel').onclick = closeContextExplorer; // Cancel means cancel: nothing in pendingFolders was touched while browsing.

$('ctxAttach').onclick = async () => {
  if (!ctxState) return;
  const rootName = ctxState.rootName;
  const entries = Array.from(ctxState.selected, (p) => ({ path: p, file: ctxState.fileMap.get(p) })).filter((e) => e.file);
  if (!entries.length) { toast('Select at least one file.'); return; }

  // Nothing blocks here anymore — oversized selections are trimmed by relevance instead.
  // Brief mode (tree + key files only) is so cheap the whole selection always fits, so it
  // never gets trimmed at all; full-code mode is trimmed to the size budget, skipping
  // rather than aborting, so smaller ranked files behind a monster still make it in.
  const brief = !!($('ctxBrief') && $('ctxBrief').checked); // checked before the modal closes
  let ranked = rankContextFiles(entries);
  const monsters = ranked.filter((e) => e.file.size > MAX_FOLDER_FILE_BYTES);
  if (monsters.length) {
    ranked = ranked.filter((e) => e.file.size <= MAX_FOLDER_FILE_BYTES);
    toast(`Skipped ${monsters.length} file${monsters.length === 1 ? '' : 's'} over ${Math.round(MAX_FOLDER_FILE_BYTES / 1024)}KB: ${monsters.slice(0, 5).map((e) => e.path).join(', ')}${monsters.length > 5 ? '…' : ''}.`, 10000);
    if (!ranked.length) { toast('Nothing left to attach after skipping oversized files.'); return; }
  }
  if (!brief && ranked.length > MAX_FOLDER_FILES) {
    const dropped = ranked.length - MAX_FOLDER_FILES;
    ranked = ranked.slice(0, MAX_FOLDER_FILES);
    toast(`Large selection: reading the ${MAX_FOLDER_FILES} most relevant files (${dropped} skipped — entry/config/source files ranked first).`, 10000);
  }
  if (!brief) {
    let total = 0;
    const kept = [];
    for (const e of ranked) {
      if (total + e.file.size <= MAX_FOLDER_TOTAL_BYTES) { total += e.file.size; kept.push(e); }
    }
    if (kept.length < ranked.length) {
      toast(`Full code would be ${formatSize(ranked.reduce((s, e) => s + e.file.size, 0))} — trimmed to the most relevant ${formatSize(total)} (${kept.length} files). Tick "Attach as project brief" to include the whole file tree cheaply instead.`, 12000);
      ranked = kept;
    }
  }
  entries.length = 0; entries.push(...ranked);
  if (!entries.length) { toast('Nothing left to attach.'); return; }

  const existingIdx = pendingFolders.findIndex((f) => f.name === rootName);
  if (existingIdx === -1 && pendingFolders.length >= MAX_FOLDERS) {
    toast(`You can attach up to ${MAX_FOLDERS} project folders.`, 6000); return;
  }
  if (existingIdx !== -1) {
    pendingFolders[existingIdx].aborted = true;
    pendingFolders.splice(existingIdx, 1);
  }

  closeContextExplorer();
  await readEligibleIntoFolder(entries, rootName, brief);
};

// ---- Phase 3: serialize attachments for the real request (renderer-side only; main.js re-validates) ----
// ~90MB of encoded text ≈ the desktop 64MB decoded budget base64'd (×4/3) + headroom
const MAX_TOTAL_SERIALIZED_CHARS = 90 * 1024 * 1024;

const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('Failed to read ' + file.name));
  r.readAsDataURL(file);
});
const readFileAsText = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('Failed to read ' + file.name));
  r.readAsText(file);
});

// Vision models only ever see a static frame anyway — a 10MB animated GIF uploads pure
// risk and cost. Anything over budget gets downscaled/re-encoded (first frame for GIFs)
// before it's base64'd into the request.
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
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    let dataUrl = canvas.toDataURL('image/webp', quality); // smaller than JPEG at similar quality
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', quality); // WebP-unsupported engine fallback
    return dataUrl;
  } catch (e) {
    // Undecodable via canvas — send the original as-is and let the engine decide.
    return readFileAsDataURL(file);
  }
}

async function buildAttachmentPayload() {
  imagesScaled = false;
  const pdfs = pendingAttachments.filter((a) => extOf(a.file.name) === '.pdf');
  if (pdfs.length) toast(`PDF parsing is coming soon. Please use images or text files for now. (skipped: ${pdfs.map((p) => p.file.name).join(', ')})`, 10000);
  const sendable = pendingAttachments.filter((a) => extOf(a.file.name) !== '.pdf');
  const out = [];
  let totalChars = 0;
  for (const a of sendable) {
    const ext = extOf(a.file.name);
    if (IMAGE_EXT.has(ext)) {
      const dataUrl = a.scaledDataUrl || await downscaleForVision(a.file);
      totalChars += dataUrl.length;
      out.push({ name: a.file.name, kind: 'image', dataUrl });
    } else {
      const text = await readFileAsText(a.file);
      totalChars += text.length;
      out.push({ name: a.file.name, kind: 'text', text });
    }
    if (totalChars > MAX_TOTAL_SERIALIZED_CHARS) {
      throw new Error(`Attachments are too large once encoded (${(totalChars / 1024 / 1024).toFixed(1)}MB). Remove a file or two and try again.`);
    }
  }
  for (const f of pendingFolders) {
    if (f.status !== 'ready' || !f.files.length) continue;
    const files = f.files.map((x) => ({ path: x.path, text: x.text }));
    totalChars += f.name.length + files.reduce((s, x) => s + x.text.length, 0);
    out.push({ name: f.name, kind: 'folder', files });
    if (totalChars > MAX_TOTAL_SERIALIZED_CHARS) {
      throw new Error(`Attachments are too large once encoded (${(totalChars / 1024 / 1024).toFixed(1)}MB). Remove a file or two and try again.`);
    }
  }
  return out;
}


const attachBtn = $('attach-btn'), fileInput = $('file-input'), editorWrapper = $('editorWrapper');
if (attachBtn && fileInput) {
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addAttachmentFiles(fileInput.files);
    fileInput.value = '';
  });
}  const folderBtn = $('folder-btn'), folderInput = $('folder-input');
  if (folderBtn && folderInput) {
  folderBtn.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    // FileList is a live view — clearing the input empties it, so snapshot first.
    // (Clearing before snapshotting is exactly the "folder attach does nothing" bug.)
    const files = Array.from(folderInput.files || []);
    folderInput.value = '';
    if (files.length) openContextExplorer(files);
  });
}
// ---- GitHub import: public repos need no token; private repos use a fine-grained token
// (Contents: Read-only). Desktop keeps the token in main-process OS-encrypted storage and the
// renderer never sees a saved token; web keeps it in page memory only.
const githubModal = $('githubModal');
const githubInput = $('githubRepoInput');
const githubTokenInput = $('githubTokenInput');
const githubTokenState = $('githubTokenState');
const githubStatus = $('githubStatus');
const githubFetchBtn = $('githubFetchBtn');
let githubTokenConfigured = false;
function setGithubTokenState(text, kind = '') {
  githubTokenState.textContent = text;
  githubTokenState.className = 'hint github-token-state' + (kind ? ' ' + kind : '');
}
async function refreshGithubTokenState() {
  let info = null;
  try { info = await pv.githubTokenInfo(); } catch { info = null; }
  githubTokenConfigured = !!(info && info.configured);
  if (!githubTokenConfigured) return setGithubTokenState('No GitHub token saved — public repositories work without one.');
  const who = info.username ? ` as ${info.username}` : '';
  setGithubTokenState(info.secureStorage
    ? `✓ Token saved${who}, encrypted by this computer’s secure storage.`
    : `✓ Token saved${who} for this session only (OS encryption unavailable).`
  , 'ok');
}
function closeGithubModal() { show('githubModal', false); }
$('gh-btn').onclick = () => {
  githubInput.value = '';
  githubTokenInput.value = '';
  githubStatus.textContent = 'Not connected — enter a repository to attach its context.';
  githubStatus.className = 'hint github-status';
  githubFetchBtn.disabled = false;
  githubFetchBtn.textContent = 'Fetch and attach';
  setGithubTokenState('Checking saved GitHub token…');
  refreshGithubTokenState();
  show('githubModal');
  setTimeout(() => githubInput.focus(), 0);
};
$('githubCancel').onclick = closeGithubModal;
$('githubCancelTop').onclick = closeGithubModal;
githubModal.addEventListener('click', (e) => { if (e.target === githubModal) closeGithubModal(); });
githubInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') githubFetchBtn.click(); });
$('githubTokenSave').onclick = async () => {
  const token = githubTokenInput.value.trim();
  if (!token) { setGithubTokenState('Paste a token first, or leave this blank for public repositories.', 'error'); githubTokenInput.focus(); return; }
  setGithubTokenState('Verifying with GitHub…');
  const r = await pv.saveGithubToken(token).catch(() => ({ ok: false, message: 'Could not verify the token.' }));
  if (!r || !r.ok) { setGithubTokenState(r?.message || 'Could not save that token.', 'error'); return; }
  githubTokenInput.value = '';
  githubTokenConfigured = true;
  setGithubTokenState(r.persisted
    ? `✓ Connected${r.username ? ' as ' + r.username : ''} — token encrypted by OS secure storage.`
    : `✓ Connected${r.username ? ' as ' + r.username : ''} for this session only (OS encryption unavailable).`
  , 'ok');
};
$('githubTokenClear').onclick = async () => {
  await pv.clearGithubToken().catch(() => {});
  githubTokenConfigured = false; githubTokenInput.value = '';
  setGithubTokenState('GitHub token removed. Public repositories still work.');
};
githubFetchBtn.onclick = async () => {
  const q = githubInput.value.trim();
  const match = q.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|\?|#|$)/i) || q.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    githubStatus.textContent = 'Enter a repository as owner/repo or https://github.com/owner/repo.';
    githubStatus.className = 'hint github-status error';
    githubInput.focus();
    return;
  }
  const owner = match[1], repo = match[2].replace(/\.git$/i, ''), name = `${owner}/${repo}`;
  const existingIdx = pendingFolders.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existingIdx === -1 && pendingFolders.length >= MAX_FOLDERS) {
    githubStatus.textContent = `You can attach up to ${MAX_FOLDERS} project folders/repositories. Remove one first.`;
    githubStatus.className = 'hint github-status error';
    return;
  }
  githubFetchBtn.disabled = true;
  githubFetchBtn.textContent = 'Fetching…';
  githubStatus.textContent = `Reading ${name}${githubTokenConfigured ? ' with your saved token' : ''}…`;
  githubStatus.className = 'hint github-status';
  try {
    const result = await pv.fetchGithubRepo(owner, repo);
    if (!result || !result.ok) throw new Error(result?.message || 'Could not fetch that repository.');
    if (existingIdx !== -1) { pendingFolders[existingIdx].aborted = true; pendingFolders.splice(existingIdx, 1); }
    pendingFolders.push({ id: 'folder-' + (++attachmentIdSeq), kind: 'github', name: result.repository || name, status: 'ready', aborted: false, files: result.files, fileCount: result.fileCount, bytes: result.bytes });
    renderAttachments();
    const privacy = result.isPrivate ? 'private repository' : 'public repository';
    const keyCount = result.fileCount - 1;
    githubStatus.textContent = `✓ ${result.repository} attached (${privacy}) — file tree plus ${keyCount} key file${keyCount === 1 ? '' : 's'}. Included with your next volley.`;
    githubStatus.className = 'hint github-status ok';
    toast(`GitHub context attached: ${result.repository} ✓ — included with the next volley.`, 7000);
    setTimeout(closeGithubModal, 1400);
  } catch (e) {
    githubStatus.textContent = `Could not attach ${name}: ${e.message || e}`;
    githubStatus.className = 'hint github-status error';
  } finally {
    githubFetchBtn.disabled = false;
    githubFetchBtn.textContent = 'Fetch and attach';
  }
};
if (editorWrapper) {
  ['dragenter', 'dragover'].forEach((evt) => editorWrapper.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); editorWrapper.classList.add('drop-active');
  }));
  editorWrapper.addEventListener('dragleave', (e) => {
    if (!editorWrapper.contains(e.relatedTarget)) editorWrapper.classList.remove('drop-active');
  });
  editorWrapper.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    editorWrapper.classList.remove('drop-active');
    const dropped = await collectDataTransferEntries(e.dataTransfer);
    if (dropped.files.length) addAttachmentFiles(dropped.files);
    for (const group of dropped.folderGroups) queueContextExplorer(group);
  });
}

// Dropped folders arrive as File objects with empty content; the only way to read them is
// the File System entries API (webkitGetAsEntry), traversed recursively here. Loose files
// still go through the normal attachment path; each dropped directory becomes one explorer
// run (queued, so multiple folders dropped at once open one after another).
async function collectDataTransferEntries(dt) {
  const files = [], folderGroups = [];
  if (!dt) return { files, folderGroups };
  const entries = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) entries.push(entry);
    else { const f = item.getAsFile(); if (f) files.push(f); }
  }
  for (const entry of entries) {
    if (entry.isFile) {
      const f = await entryToFile(entry);
      if (f) files.push(f);
    } else if (entry.isDirectory) {
      const group = [];
      await walkEntry(entry, '', group);
      if (group.length) folderGroups.push(group);
    }
  }
  return { files, folderGroups };
}

function entryToFile(entry) {
  return new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
}

async function walkEntry(dirEntry, prefix, out) {
  const reader = dirEntry.createReader();
  // readEntries only returns a bounded batch per call — keep calling until it returns [].
  let batch;
  do {
    batch = await new Promise((res) => reader.readEntries(res, () => res([])));
    for (const e of batch) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = `${dirEntry.name}/${rel}`;
      if (e.isDirectory) {
        if (!isFolderPathIgnored(full)) await walkEntry(e, rel, out);
      } else if (e.isFile && !isFolderPathIgnored(full) && FOLDER_ALLOWED_EXT.has(extOf(e.name))) {
        const f = await entryToFile(e);
        if (f) { try { f._vpRelPath = full; } catch {} out.push(f); }
      }
    }
  } while (batch.length);
}
$('idea').addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const images = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) images.push(f);
    }
  }
  if (images.length) addAttachmentFiles(images);
});

$('tbMin').onclick = () => pv.winMin();
$('tbMax').onclick = () => pv.winMax();
$('tbClose').onclick = () => pv.winClose();
$('btnNewChat').onclick = () => {
  // Reachable at any time, including mid-run — without stopping it first, the backend keeps
  // streaming in the background and its eventual done/error event would later yank the view
  // away from whatever the user's doing here.
  runAbandoned = true;
  pv.stop();
  show('result',false); show('run',false); show('setup'); $('idea').value=''; $('idea').focus();
};

let historyItems = [];
async function loadHistory() {
  historyItems = await pv.runs();
  const history = $('history');
  history.textContent = '';
  const groups = new Map();
  for (const r of historyItems) {
    // The project name is the folder; '' is the "Other volleys" fallback bucket.
    const key = (r.meta && r.meta.project) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, items] of groups) {
    const heading = document.createElement('div');
    heading.className = 'history-project';
    heading.dataset.projectKey = key;
    heading.textContent = key || 'Other volleys';
    heading.draggable = true;
    heading.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'folder:' + key);
      e.dataTransfer.effectAllowed = 'move';
      heading.classList.add('dragging');
    });
    heading.addEventListener('dragend', () => heading.classList.remove('dragging'));
    history.appendChild(heading);
    for (const r of items) {
      const stamp = r.name.replace('-final.md', '');
      const el = document.createElement('div');
      el.className = 'hist-item';
      el.dataset.path = r.path;
      el.dataset.id = r.name; // For context menu / drag-drop referencing
      el.title = stamp; // r.title is user-controlled (the idea's first line) — never into innerHTML/attributes unescaped
      el.textContent = (r.incomplete ? '✂ ' : '') + (r.title || stamp);
      el.draggable = true;
      // Saved runs are on disk; clicking loads the final prompt (and the original idea) via pv.openRun.
      el.addEventListener('click', () => openHistoryItem(r.name));
      if (r.meta?.outcome) el.textContent += ` · ${({ used: '✓', edited: '✎', failed: '!', unused: '–' })[r.meta.outcome] || ''}`;
      history.appendChild(el);
    }
  }
}

function showIdeaRecap(idea, whenText) {
  // Any freshly shown result (new run or history load) starts expanded.
  $('result').classList.remove('collapsed'); $('resultCollapse').textContent = '▾';
  const recap = $('ideaRecap');
  if (idea) {
    recap.textContent = `🎯 Your original idea: ${String(idea).slice(0, 400)}`;
    recap.classList.remove('hidden');
  } else {
    recap.classList.add('hidden');
  }
  if (whenText) $('savedAt').textContent = whenText;
}
async function openHistoryItem(name) {
  const item = historyItems.find((x) => x.name === name);
  if (!item || !item.path) { toast('No saved result for this entry.', 6000); return; }
  const got = await pv.openRun(name).catch(() => null);
  if (!got || !got.final) { toast('No saved result for this entry.', 6000); return; }
  currentHistoryName = name;
  runSnapshots = got.meta?.snapshots || [];
  lastRunMeta = { ...(lastRunMeta || {}), ...(got.meta?.modelPair ? { author: got.meta.modelPair.author, critic: got.meta.modelPair.critic } : {}), project: got.meta?.project || '', snapshots: runSnapshots, currentName: name };
  $('versionSlider').disabled = !runSnapshots.length; $('versionSlider').min = '1'; $('versionSlider').max = String(Math.max(1, runSnapshots.length)); $('versionSlider').value = String(Math.max(1, runSnapshots.length));
  $('versionLabel').textContent = runSnapshots.length ? `Round ${runSnapshots.length}` : '—';
  $('fitnessScore').textContent = got.meta?.score != null ? `Fitness: ${got.meta.score}/100` : 'Fitness: —';
  $('outcomeTag').value = got.meta?.outcome || '';
  // Opening a history item abandons any background run, same as New Volley.
  runAbandoned = true;
  const stamp = String(name).replace(/-final\.md$/, '');
  const d = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(stamp)
    ? new Date(stamp.replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})$/, '$1T$2:$3:$4'))
    : null;
  show('result', false); show('run', false); show('result');
  $('final').value = got.final;
  showIdeaRecap(got.idea, (d && !isNaN(d) ? `Loaded from history · ${d.toLocaleString()}` : 'Loaded from history') + (item.incomplete ? ' · stopped draft' : ''));
}
loadHistory();


// ---- Sidebar history: right-click menu, rename, delete, move -----------------
// The history list is rebuilt from scratch by loadHistory() every time it refreshes,
// so every listener here is delegated from the #history container. Binding at script
// load found an empty list and never fired — that is why right-click did nothing.
const historyEl = $('history');
const contextMenu = $('contextMenu');
let contextTarget = null; // { kind: 'run'|'project', name, title, key }

function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.classList.add('hidden');
  contextMenu.classList.remove('visible');
  contextTarget = null;
}

function openContextMenu(e, target) {
  if (!contextMenu) return;
  contextTarget = target;
  // Only offer the actions that apply to whatever was right-clicked.
  contextMenu.querySelectorAll('.menu-item').forEach((el) => {
    let show = el.dataset.scope === target.kind;
    // "Other volleys" is the fallback bucket, not a real folder — nothing to delete.
    if (show && el.dataset.action === 'delete-project' && !target.key) show = false;
    el.classList.toggle('hidden', !show);
  });
  contextMenu.style.left = `${e.pageX}px`;
  contextMenu.style.top = `${e.pageY}px`;
  contextMenu.classList.remove('hidden');
  contextMenu.classList.add('visible');
}

// Text prompt. `choices` are quick-pick buttons (used by "move to folder").
function askText({ title, message = '', label = 'Name', value = '', placeholder = '', choices = null, okLabel = 'Save' }) {
  return new Promise((resolve) => {
    const modal = $('promptModal');
    $('promptTitle').textContent = title;
    const msg = $('promptMessage');
    msg.textContent = message;
    msg.classList.toggle('hidden', !message);
    const input = $('promptInput');
    input.value = value;
    input.placeholder = placeholder;
    $('promptLabel').textContent = label;
    $('promptField').classList.remove('hidden');
    const box = $('promptChoices');
    box.textContent = '';
    if (choices && choices.length) {
      box.classList.remove('hidden');
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.label;
        b.addEventListener('click', () => finish(c.value));
        box.appendChild(b);
      }
    } else box.classList.add('hidden');
    const ok = $('promptOk');
    ok.textContent = okLabel;
    const done = (v) => finish(v);
    ok.onclick = () => done(input.value);
    $('promptCancel').onclick = () => finish(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
    function finish(v) {
      modal.classList.add('hidden');
      ok.onclick = null;
      $('promptCancel').onclick = null;
      input.onkeydown = null;
      resolve(v);
    }
  });
}

// Yes/no prompt, reusing the same modal.
function askConfirm({ title, message = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const modal = $('promptModal');
    $('promptTitle').textContent = title;
    const msg = $('promptMessage');
    msg.textContent = message;
    msg.classList.toggle('hidden', !message);
    $('promptField').classList.add('hidden');
    $('promptChoices').classList.add('hidden');
    const ok = $('promptOk');
    ok.textContent = okLabel;
    const finish = (v) => {
      modal.classList.add('hidden');
      ok.onclick = null;
      $('promptCancel').onclick = null;
      resolve(v);
    };
    ok.onclick = () => finish(true);
    $('promptCancel').onclick = () => finish(false);
    modal.classList.remove('hidden');
    setTimeout(() => ok.focus(), 0);
  });
}

async function runHistoryAction(action, target) {
  if (action === 'rename') {
    const name = await askText({ title: 'Rename volley', label: 'Name', value: target.title, okLabel: 'Rename' });
    if (name === null) return;
    const clean = String(name).trim();
    if (!clean) return;
    const ok = await pv.renameRun(target.name, clean);
    if (ok) { toast('Volley renamed.', 3000); await loadHistory(); }
    else toast('Rename failed — could not write the new title.', 4000);
  } else if (action === 'move') {
    const list = await pv.projects();
    const choices = (list || []).filter((p) => p.key).map((p) => ({ label: p.name, value: p.key }));
    const dest = await askText({
      title: 'Move volley to folder', label: 'Folder', value: target.key || '',
      placeholder: 'Folder name', choices, okLabel: 'Move',
    });
    if (dest === null) return;
    const ok = await pv.moveRun(target.name, String(dest).trim());
    if (ok) { toast('Volley moved.', 3000); await loadHistory(); }
    else toast('Move failed.', 4000);
  } else if (action === 'delete') {
    const yes = await askConfirm({
      title: 'Delete volley?', okLabel: 'Delete',
      message: `"${target.title}" and its saved prompt will be removed from this computer. This cannot be undone.`,
    });
    if (!yes) return;
    const ok = await pv.deleteRun(target.name);
    if (ok) {
      if (currentHistoryName === target.name) currentHistoryName = null;
      toast('Volley deleted.', 3000);
      await loadHistory();
    } else toast('Delete failed.', 4000);
  } else if (action === 'rename-project') {
    const name = await askText({ title: 'Rename folder', label: 'Folder name', value: target.label, okLabel: 'Rename' });
    if (name === null) return;
    const clean = String(name).trim();
    if (!clean) return;
    const n = await pv.renameProject(target.key, clean);
    toast(n ? `Folder renamed (${n} volley${n === 1 ? '' : 's'}).` : 'No volleys in that folder.', 3500);
    await loadHistory();
  } else if (action === 'delete-project') {
    const yes = await askConfirm({
      title: 'Delete folder?', okLabel: 'Delete folder',
      message: `The volleys in "${target.label}" move back to "Other volleys". The volleys themselves are kept.`,
    });
    if (!yes) return;
    const n = await pv.deleteProject(target.key);
    toast(n ? `Folder deleted (${n} volley${n === 1 ? '' : 's'} moved to Other volleys).` : 'Folder was already empty.', 4000);
    await loadHistory();
  }
}

if (contextMenu) {
  contextMenu.addEventListener('click', (e) => {
    const el = e.target.closest('.menu-item');
    if (!el || !contextTarget) return;
    const action = el.dataset.action;
    const target = contextTarget;
    closeContextMenu();
    runHistoryAction(action, target);
  });
  // A click anywhere else dismisses the menu.
  document.addEventListener('click', (e) => {
    if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu();
  });
}

if (historyEl) {
  historyEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.hist-item');
    if (item) {
      e.preventDefault();
      const name = item.dataset.id;
      const run = historyItems.find((x) => x.name === name);
      openContextMenu(e, {
        kind: 'run', name,
        title: (run && run.title) || name.replace(/-final\.md$|-draft\.md$/, ''),
        key: (run && run.meta && run.meta.project) || '',
      });
      return;
    }
    const group = e.target.closest('.history-project');
    if (group) {
      e.preventDefault();
      const key = group.dataset.projectKey || '';
      openContextMenu(e, { kind: 'project', key, label: group.textContent.trim() });
    }
  });

  // Drag a volley into a folder to move it. Delegated for the same reason as above.
  historyEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.hist-item');
    if (!item) return;
    e.dataTransfer.setData('text/plain', item.dataset.id || '');
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  historyEl.addEventListener('dragend', (e) => {
    const item = e.target.closest('.hist-item');
    if (item) item.classList.remove('dragging');
  });
  historyEl.addEventListener('dragover', (e) => {
    const group = e.target.closest('.history-project');
    if (!group) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    group.classList.add('dragover');
  });
  historyEl.addEventListener('dragleave', (e) => {
    const group = e.target.closest('.history-project');
    if (group && !group.contains(e.relatedTarget)) group.classList.remove('dragover');
  });
  historyEl.addEventListener('drop', async (e) => {
    const group = e.target.closest('.history-project');
    if (!group) return;
    e.preventDefault();
    group.classList.remove('dragover');
    const payload = e.dataTransfer.getData('text/plain') || '';
    const dest = group.dataset.projectKey || '';
    if (payload.startsWith('folder:')) {
      // Dropping one folder onto another merges its volleys into the target.
      const src = payload.slice(7);
      if (src === dest) return;
      const list = await pv.projects();
      const match = (list || []).find((p) => p.key === src);
      const moved = await pv.renameProject(src, dest || 'Other volleys');
      toast(moved ? `Moved ${moved} volley${moved === 1 ? '' : 's'} into "${dest || 'Other volleys'}".` : 'Nothing to move.', 3500);
      await loadHistory();
      return;
    }
    if (!payload) return;
    const ok = await pv.moveRun(payload, dest);
    if (ok) { toast('Volley moved.', 2500); await loadHistory(); }
  });
}

// animated background
const c = $('bgCanvas'); const ctx = c.getContext('2d');
function resize(){ c.width=innerWidth; c.height=innerHeight; }
resize(); addEventListener('resize', resize);
// Particle colours come from the live theme, so the hue slider moves the backdrop too.
let particleCyan = '#00f0ff', particlePurple = '#b026ff';
function readParticleColors() {
  const cs = getComputedStyle(document.documentElement);
  particleCyan = cs.getPropertyValue('--neon-cyan').trim() || '#00f0ff';
  particlePurple = cs.getPropertyValue('--neon-purple').trim() || '#b026ff';
}
readParticleColors();
document.addEventListener('vp-theme', readParticleColors);
let t=0;
function frame(){ t+=0.008; ctx.clearRect(0,0,c.width,c.height);
  for(let i=0;i<60;i++){
    const x=(Math.sin(t*0.7+i*1.3)*0.5+0.5)*c.width;
    const y=(Math.cos(t*0.5+i*0.9)*0.5+0.5)*c.height;
    const r=1+Math.sin(t+i)*1;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
    ctx.globalAlpha = 0.25+Math.sin(t+i)*0.15;
    ctx.fillStyle = i%2 ? particleCyan : particlePurple;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(frame);
}
frame();
const panelOf = (role) => document.querySelector('.panel.' + role);
const streaming = (role, on) => panelOf(role).classList.toggle('streaming', on);

pv.onEvent(async (ev) => {
  switch (ev.type) {
    case 'round':
      $('statusText').textContent = `Round ${ev.r} of ${ev.rounds}`;
      $('dots').innerHTML = Array.from({ length: ev.rounds }, (_, i) => `<i class="${i < ev.r ? 'on' : ''}"></i>`).join('');
      if (ev.models) { $('runAuthor').value = ev.models.author; $('runCritic').value = ev.models.critic; }
      break;
    case 'panel': {
      const isA = ev.role === 'author';
      (isA ? $('aOut') : $('cOut')).textContent = '';
      (isA ? $('aRound') : $('cRound')).textContent = `· round ${ev.r}`;
      streaming('author', isA); streaming('critic', !isA);
      $('statusText').textContent = isA ? `✍ Writer is drafting (round ${ev.r})…` : `🔍 Reviewer is reading (round ${ev.r})…`;
      break;
    }
    case 'delta': {
      const o = ev.role === 'author' ? $('aOut') : $('cOut');
      o.textContent += ev.text; o.scrollTop = o.scrollHeight; break;
    }
    case 'verdict':
      streaming('critic', false);
      $('statusText').textContent = ev.verdict === 'APPROVE' ? '✅ Reviewer approved!' : '↻ Reviewer wants changes';
      break;
    case 'usage': {
      const usageEl = $('statusUsage');
      if (!usageEl) break;
      if (ev.actual) {
        usageEl.textContent = `${((ev.sent || 0) + (ev.recv || 0)).toLocaleString()} tok · $${(Number(ev.cost) || 0).toFixed(4)}`;
        usageEl.title = 'Provider-reported token totals; cost uses provider cost when available, otherwise catalog pricing.';
      } else {
        const toks = Math.round(((ev.sent || 0) + (ev.recv || 0)) / 4);
        usageEl.textContent = `≈${(toks / 1000).toFixed(1)}k tok · estimate`;
        usageEl.title = 'Estimated from text characters ÷ 4; image payloads excluded.';
      }
      break;
    }
    case 'diff': {
      // 2. Round 2+: the Writer panel becomes a diff of what actually changed.
      const out = $('aOut');
      renderLineDiff(out, ev.oldText, ev.newText);
      out.scrollTop = out.scrollHeight;
      break;
    }
    case 'review-ready': {
      const box = $('reviewIssues'); box.textContent = '';
      if (ev.issues?.length) {
        const title = document.createElement('p'); title.className = 'hint'; title.textContent = 'Choose which reviewer issues the Writer should address (all selected by default).'; box.appendChild(title);
        ev.issues.forEach((issue) => { const label = document.createElement('label'); label.className = 'issue-choice'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = issue; input.checked = true; const text = document.createElement('span'); text.textContent = issue; label.append(input, text); box.appendChild(label); });
        show('reviewIssues');
      } else show('reviewIssues', false);
      if (ev.score != null) $('fitnessScore').textContent = `Fitness: ${ev.score}/100 · ${ev.verdict}`;
      break;
    }
    case 'round-snapshot': runSnapshots[ev.round - 1] = ev; $('versionSlider').max = String(runSnapshots.length); $('versionSlider').disabled = false; $('versionSlider').value = String(ev.round); $('versionLabel').textContent = `Round ${ev.round}`; if (ev.score != null) $('fitnessScore').textContent = `Fitness: ${ev.score}/100 · ${ev.verdict}`; break;
    case 'metric': { const el = $('statusUsage'); el.textContent = `${ev.promptTokens + ev.completionTokens} tok · $${ev.totalCost.toFixed(4)} · ${(ev.elapsedMs / 1000).toFixed(1)}s`; el.title = `${ev.role}: ${ev.model}; prompt ${ev.promptTokens}, completion ${ev.completionTokens}`; break; }
    case 'budget-hit': toast(`Budget reached ($${ev.cost.toFixed(4)} / $${ev.limit.toFixed(2)}). Finishing with the best current draft.`, 8000); break;
    case 'await-notes': show('notesBox'); $('notes').focus(); $('notesBox').scrollIntoView({ behavior: 'smooth' }); break;
    case 'notice': toast('ℹ ' + ev.message, 8000); break;
    case 'done':
      streaming('author', false); streaming('critic', false); show('notesBox', false); show('reviewIssues', false);
      await loadHistory();
      const finishedItem = historyItems.find((x) => x.name === ev.historyName) || historyItems[0];
      currentHistoryName = ev.historyName || finishedItem?.name || null;
      if (lastRunMeta) { lastRunMeta.currentName = currentHistoryName; lastRunMeta.snapshots = ev.snapshots || runSnapshots; }
      if (runAbandoned) break; // user already left via New Volley; don't yank them into a view they didn't ask for
      if (!ev.final) { show('run', false); show('setup'); toast('Stopped.'); break; }
      $('final').value = ev.final;
      runSnapshots = ev.snapshots || runSnapshots;
      if (ev.score != null) $('fitnessScore').textContent = `Fitness: ${ev.score}/100`;
      const modelText = lastRunMeta ? `Model: ${lastRunMeta.author} · ${lastRunMeta.critic}` : '';
      $('modelInfo').textContent = modelText;
      $('outcomeTag').value = '';
      showIdeaRecap(ev.idea, ev.file ? `Saved to ${ev.file}` : 'Stopped early — this is the latest draft.');
      show('run', false); show('result');
      break;
    case 'error':
      streaming('author', false); streaming('critic', false); show('notesBox', false);
      if (runAbandoned) break;
      show('run', false);
      if (ev.partial) { $('final').value = ev.partial; showIdeaRecap(ev.idea, 'Run failed — this is the latest draft.'); show('result'); }
      else show('setup');
      toast('⚠ ' + ev.message, 12000);
      // A key refusal stops every round, so open the key dialog instead of making the
      // user hunt for the settings cog.
      if (/rejected the API key \(401\)|API key \(401\)/i.test(ev.message)) setTimeout(() => openModal(false), 600);
      break;
  }
});
