/* "Send to ▸" handoff: build explicit, action-tagged text and route it to a coding agent.
 *
 * Hermes is a DIRECT handoff (CLI spawn on desktop / paste fallback on web) — never Discord.
 * The gateway /v1/runs path is opt-in via a token and is intentionally not used by default.
 *
 * UMD so the exact same logic is tested in Node and loaded in both front-ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DESTINATIONS = [
    { id: 'cursor', label: 'Cursor', scheme: 'cursor://', web: true },
    { id: 'claude', label: 'Claude Code', scheme: 'claude://', web: true },
    { id: 'cline', label: 'Cline', scheme: 'cline://', web: true },
    { id: 'vscode', label: 'VS Code', scheme: 'vscode://', web: true },
    { id: 'hermes', label: 'Hermes (direct)', scheme: '', web: false },
  ];

  function destination(id) {
    return DESTINATIONS.find((d) => d.id === id) || null;
  }

  // A bare prompt handed to an agent gets *answered*, not executed. Make the expected
  // action and the working folder explicit, and fence the prompt so it cannot be mistaken
  // for surrounding instructions.
  function buildHandoffText(prompt, options) {
    const opts = options || {};
    const review = opts.action === 'review';
    const folder = String(opts.folder == null ? '' : opts.folder).trim();
    const lines = [
      review ? 'REVIEW THIS APPROVED PROMPT — do not edit files yet.' : 'BUILD THIS APPROVED PROMPT — treat it as the spec.',
    ];
    if (folder) lines.push(`Work in this project folder: ${folder}`);
    lines.push(review
      ? 'Report clarity, completeness and contradiction issues, ranked by severity. Do not implement.'
      : 'Implement it in that folder. Ask before making changes unrelated to the spec.');
    lines.push('', '--- APPROVED PROMPT (verbatim) ---');
    lines.push(String(prompt == null ? '' : prompt).trim());
    lines.push('--- END APPROVED PROMPT ---');
    return lines.join('\n');
  }

  // Only agent schemes we actually support — never shell strings or arbitrary URLs.
  function isAllowedUrl(url) {
    return typeof url === 'string' && /^(cursor|claude|cline|vscode):\/\/[^\s]*$/i.test(url);
  }

  // spawn() receives this as an ARGV ARRAY. No shell, no interpolation, no injection.
  function hermesArgs(text) {
    return ['chat', '-q', String(text == null ? '' : text)];
  }

  // Optional gateway path (token required). Returns null when no token is configured.
  function gatewayConfig(storage) {
    try {
      const base = String((storage && storage.getItem('gv_hermes_api')) || '').trim();
      const token = String((storage && storage.getItem('gv_hermes_token')) || '').trim();
      if (!base || !token) return null;
      return { base: base.replace(/\/+$/, ''), token };
    } catch (_) {
      return null;
    }
  }

  return { DESTINATIONS, destination, buildHandoffText, isAllowedUrl, hermesArgs, gatewayConfig };
});
