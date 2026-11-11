// agent-manager.js
//
// The multi-role game-development workflow. This is the "execution layer" the
// original VolleyPrompt lacked: it does not just generate text, it drives a real
// coding agent against a real project directory and iterates on the result.
//
// Workflow:
//   USER IDEA -> CREATIVE DIRECTOR (brief) -> CODING AGENT (build) -> PREVIEW
//            -> CRITIC (review) -> [fixes] -> CODING AGENT -> (repeat, max N rounds)
//            -> VERIFY -> FINAL RESULT
//
// Roles are independently configurable: the Director and Critic are chat providers
// (reusing lib/providers.js); the Developer is a coding-agent adapter (Codex /
// Claude Code / Gemini CLI) that edits files in the selected project.
//
// All loops are BOUNDED (default 3 correction rounds). User follow-up instructions
// take priority over agent preferences (the Director is skipped on Improve/Fix so it
// cannot override an explicit user request).

const DEFAULT_MAX_ROUNDS = 3;

// Auto model pick (no explicit model): prefer a FREE model when the provider's list
// marks one, so a blank field never silently bills the user. Falls back to the
// provider's first listed model only when no free one exists.
function pickAutoModel(models) {
  if (!Array.isArray(models) || !models.length) return null;
  const free = models.find((m) => m && (m.isFree || (typeof m.id === 'string' && m.id.includes(':free'))));
  return (free || models[0]).id;
}

const CREATIVE_DIRECTOR_SYSTEM = `You are the Creative Director for an AI game studio. Given a short, often silly game idea, produce a concise DEVELOPMENT BRIEF that a coding agent will implement as a real, playable game. Be decisive and concrete.

Include exactly these sections:
1. CONCEPT & CORE LOOP — one paragraph on what the player does and why it's fun.
2. TECHNOLOGY — recommend ONE approach. Prefer a single self-contained HTML + JS (Canvas or Three.js) game unless the idea clearly needs a framework. If you pick Three.js, say so explicitly.
3. GAMEPLAY — concrete mechanics, controls, win/lose, scoring, difficulty.
4. STRUCTURE — level/world layout and progression.
5. VISUALS — art direction, colour palette, lighting, key effects.
6. AUDIO — music and sound-effect direction.
7. FILE PLAN — the exact files to create (e.g. index.html, game.js, style.css).
8. MUST-HAVE v1 — a short checklist of features the first playable build must have.

Keep the whole brief under 600 words. The coding agent will follow it literally.`;

const CRITIC_SYSTEM = `You are the QA Critic for an AI game studio. You are given the development brief and a summary of the implemented project (file tree + key files). Reason carefully about whether the PLAYABLE game would satisfy the brief and be fun.

Report concrete, actionable findings only. Put each finding on its own line as:
[SEVERITY] <finding>
where SEVERITY is one of HIGH, MED, or LOW:
  HIGH = the game is broken, does not run, or the core idea is unmet.
  MED  = a quality, polish, feel, or completeness issue that should be fixed.
  LOW  = a minor nitpick.

Do NOT invent problems you cannot support. At the very end, add exactly one line:
VERDICT: <SHIP | CLOSE | NEEDS-WORK>`;

function parseReview(text) {
  const findings = [];
  let verdict = null;
  const re = /\[(HIGH|MED|LOW)\]\s*(.+)/gi;
  let m;
  while ((m = re.exec(text))) {
    findings.push({ severity: m[1].toUpperCase(), message: m[2].trim() });
  }
  const v = /VERDICT:\s*(SHIP|CLOSE|NEEDS-WORK)/i.exec(text);
  if (v) verdict = v[1].toUpperCase();
  return { findings, verdict };
}

class AgentManager {
  // providers: the lib/providers module (or a test stub) exposing getProvider(id).
  // agents: map of { codex: CodingAgent, claude: CodingAgent, gemini: CodingAgent }.
  // projectManager: ProjectManager instance.
  // hooks: { loadPreview({projectPath, entry}), onCheckpoint(info) }.
  constructor({ providers, agents, projectManager, hooks = {} }) {
    this.providers = providers;
    this.agents = agents || {};
    this.projectManager = projectManager;
    this.hooks = hooks;
  }

  _emit(onEvent, ev) { onEvent && onEvent(ev); }

  async _brief(idea, { signal, onEvent }) {
    const provider = this.providers.getProvider(this._directorId);
    const models = await provider.getModels().catch(() => []);
    const model = this._directorModel || pickAutoModel(models);
    this._emit(onEvent, { type: 'agent:status', role: 'director', status: 'working', message: 'Writing the development brief…' });
    let brief = '';
    const res = await provider.chat({
      model,
      system: CREATIVE_DIRECTOR_SYSTEM,
      messages: [{ role: 'user', content: `Game idea: ${idea}` }],
      signal,
      onDelta: (d) => this._emit(onEvent, { type: 'agent:output', role: 'director', text: d }),
    });
    brief = res.text;
    this._emit(onEvent, { type: 'agent:status', role: 'director', status: 'done', message: 'Development brief ready.' });
    return brief;
  }

  async _review(brief, { signal, onEvent }) {
    this._emit(onEvent, { type: 'agent:status', role: 'critic', status: 'working', message: 'Reviewing the build…' });
    const summary = await this.projectManager.getProjectSummary().catch(() => ({ name: '', entry: null, tree: [], manifest: '' }));
    const ctx = `DEVELOPMENT BRIEF:\n${brief}\n\nPROJECT SUMMARY:\n${JSON.stringify({ entry: summary.entry, tree: summary.tree.slice(0, 60) }, null, 2)}\n\nKEY FILES:\n${summary.manifest.slice(0, 6000)}`;
    let text = '';
    const provider = this.providers.getProvider(this._criticId);
    const models = await provider.getModels().catch(() => []);
    const model = this._criticModel || pickAutoModel(models);
    const res = await provider.chat({
      model,
      system: CRITIC_SYSTEM,
      messages: [{ role: 'user', content: ctx }],
      signal,
      onDelta: (d) => this._emit(onEvent, { type: 'agent:output', role: 'critic', text: d }),
    });
    text = res.text;
    const { findings, verdict } = parseReview(text);
    for (const f of findings) this._emit(onEvent, { type: 'review:result', severity: f.severity, message: f.message });
    this._emit(onEvent, { type: 'agent:status', role: 'critic', status: 'done', message: `Review complete — ${findings.length} finding(s), verdict ${verdict || 'NONE'}.` });
    return { findings, verdict };
  }

  _developerAgent(developerId) {
    // "prov:<providerId>" = an AI-provider developer (writes files directly, no CLI).
    if (developerId && developerId.startsWith('prov:')) {
      const pid = developerId.slice(5);
      const key = `__prov_${pid}`;
      if (!this.agents[key]) {
        const { ProviderDevAgent } = require('./provider-dev-agent.js');
        this.agents[key] = new ProviderDevAgent({
          provider: this.providers.getProvider(pid),
          projectManager: this.projectManager,
          providerId: pid,
        });
      }
      return this.agents[key];
    }
    const agent = this.agents[developerId];
    if (!agent) throw new Error(`No coding agent "${developerId}" is available. Install its CLI or pick a different Developer.`);
    return agent;
  }

  async _develop(taskPrompt, { developerId, developerModel, signal, onEvent, label }) {
    const agent = this._developerAgent(developerId);
    // Snapshot for change detection.
    const before = await this.projectManager.snapshotHashes().catch(() => ({}));
    this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'working', message: label || 'Building the game…' });
    const cp = await this.projectManager.checkpoint().create(this.projectManager.active.path, label || 'pre-dev').catch(() => null);
    if (cp && this.hooks.onCheckpoint) this.hooks.onCheckpoint(cp);
    let result;
    try {
      result = await agent.runTask({
        projectPath: this.projectManager.active.path,
        prompt: taskPrompt,
        model: developerModel || null,
        signal,
        onEvent: (ev) => {
          if (ev.type === 'output') this._emit(onEvent, { type: 'agent:output', role: 'developer', text: ev.text });
          else this._emit(onEvent, { type: 'agent:diagnostic', role: 'developer', text: ev.text });
        },
      });
    } catch (e) {
      this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'error', message: e.message });
      throw e;
    }
    const after = await this.projectManager.snapshotHashes().catch(() => ({}));
    const changed = this.projectManager.diffSnapshots(before, after);
    for (const c of changed) this._emit(onEvent, { type: 'project:changed', path: c.path, operation: c.operation });
    this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'done', message: `${changed.length} file(s) changed.` });
    return { changed, result };
  }

  async _reloadPreview(onEvent) {
    const entry = await this.projectManager.detectEntryPoint().catch(() => null);
    if (!entry) {
      this._emit(onEvent, { type: 'preview:error', message: 'No playable entry point found in the project. The coding agent did not produce an index.html or dev server.' });
      return null;
    }
    this._emit(onEvent, { type: 'preview:load', entry });
    if (this.hooks.loadPreview) await this.hooks.loadPreview({ projectPath: this.projectManager.active.path, entry });
    return entry;
  }

  // Public: create a brand-new game from an idea.
  async createGame({ idea, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS }) {
    this._setRoles(roles);
    await this.projectManager.openProject(projectPath);
    this._emit(onEvent, { type: 'progress', phase: 'brief', round: 0, maxRounds });
    const brief = await this._brief(idea, { signal, onEvent });

    const task = `Implement the game described by this development brief as a real, PLAYABLE project in the current working directory. Create every file in the FILE PLAN. The result must run by opening index.html (or the project's dev server). Prioritise: it must actually run without errors, be fun, and match the brief. Brief:\n\n${brief}`;

    let lastEntry = null;
    let round = 0;
    let lastReview = { findings: [], verdict: 'NEEDS-WORK' };
    while (round < maxRounds) {
      round++;
      this._emit(onEvent, { type: 'progress', phase: 'develop', round, maxRounds });
      const fixNote = round > 1
        ? `\n\nIMPORTANT — address these review findings from the previous pass:\n${lastReview.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`
        : '';
      await this._develop(task + fixNote, { developerId: this._developerId, developerModel: this._developerModel, signal, onEvent, label: round > 1 ? `Fixing issues (round ${round})…` : 'Building the game…' });
      lastEntry = await this._reloadPreview(onEvent);
      this._emit(onEvent, { type: 'progress', phase: 'review', round, maxRounds });
      lastReview = await this._review(brief, { signal, onEvent });
      // A missing/malformed verdict (null) is NOT a pass: only an explicit SHIP/CLOSE
      // with zero HIGH/MED findings completes the loop.
      const highOrMed = lastReview.findings.filter((f) => f.severity !== 'LOW');
      const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE') && highOrMed.length === 0;
      if (passed) break;
    }

    const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE')
      && lastReview.findings.filter((f) => f.severity !== 'LOW').length === 0;
    this._emit(onEvent, { type: 'game:done', result: {
      // Honest reporting: nothing has been EXECUTION-verified yet (no verification
      // stage exists), so LOW findings are "remaining notes", not verified fixes.
      verifiedFixes: [],
      unverifiedImprovements: lastReview.findings.filter((f) => f.severity === 'LOW').map((f) => f.message),
      knownIssues: lastReview.findings.filter((f) => f.severity === 'HIGH' || f.severity === 'MED').map((f) => f.message),
      verdict: lastReview.verdict || 'NONE',
      completed: passed,
      entry: lastEntry,
      rounds: round,
    } });
    return { brief, entry: lastEntry, review: lastReview, rounds: round, completed: passed };
  }

  // Public: follow-up improvement on an existing project. User instruction wins.
  async improveGame({ idea, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS }) {
    return this._followUp({ instruction: idea, projectPath, roles, signal, onEvent, maxRounds, label: 'Improving the game…' });
  }

  // Public: fix a reported bug in ordinary language.
  async fixGame({ report, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS }) {
    return this._followUp({ instruction: `Fix this bug: ${report}`, projectPath, roles, signal, onEvent, maxRounds, label: 'Fixing the bug…' });
  }

  async _followUp({ instruction, projectPath, roles, signal, onEvent, maxRounds, label }) {
    this._setRoles(roles);
    await this.projectManager.openProject(projectPath);
    const summary = await this.projectManager.getProjectSummary().catch(() => ({ name: '', entry: null, tree: [], manifest: '' }));
    const baseTask = `You are improving an EXISTING game project in the current working directory. Follow the user's instruction literally — do not change the game's core concept unless asked. Respect the existing code style and files.\n\nEXISTING PROJECT:\n${JSON.stringify({ entry: summary.entry, tree: summary.tree.slice(0, 80) }, null, 2)}\n\nUSER INSTRUCTION:\n${instruction}`;

    let lastEntry = null;
    let round = 0;
    let lastReview = { findings: [], verdict: 'NEEDS-WORK' };
    while (round < maxRounds) {
      round++;
      this._emit(onEvent, { type: 'progress', phase: 'develop', round, maxRounds });
      const fixNote = round > 1
        ? `\n\nAlso address these review findings:\n${lastReview.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`
        : '';
      await this._develop(baseTask + fixNote, { developerId: this._developerId, developerModel: this._developerModel, signal, onEvent, label: round > 1 ? `Re-applying fixes (round ${round})…` : label });
      lastEntry = await this._reloadPreview(onEvent);
      this._emit(onEvent, { type: 'progress', phase: 'review', round, maxRounds });
      lastReview = await this._review('', { signal, onEvent });
      const actionable = lastReview.findings.filter((f) => f.severity !== 'LOW');
      const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE') && actionable.length === 0;
      if (passed) break;
    }
    const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE')
      && lastReview.findings.filter((f) => f.severity !== 'LOW').length === 0;
    this._emit(onEvent, { type: 'game:done', result: {
      verifiedFixes: [],
      unverifiedImprovements: lastReview.findings.filter((f) => f.severity === 'LOW').map((f) => f.message),
      knownIssues: lastReview.findings.filter((f) => f.severity === 'HIGH' || f.severity === 'MED').map((f) => f.message),
      verdict: lastReview.verdict || 'NONE',
      completed: passed,
      entry: lastEntry,
      rounds: round,
    } });
    return { entry: lastEntry, review: lastReview, rounds: round, completed: passed };
  }

  _setRoles(roles = {}) {
    this._directorId = roles.creativeDirector?.provider || 'openrouter';
    this._directorModel = roles.creativeDirector?.model || null;
    this._criticId = roles.critic?.provider || 'openrouter';
    this._criticModel = roles.critic?.model || null;
    this._developerId = roles.developer?.agent || roles.developer || 'claude';
    this._developerModel = roles.developer?.model || null;
    // The Director/Critic use whatever provider is configured; default to openrouter.
    if (!this.providers.getProvider(this._directorId)) this._directorId = 'openrouter';
    if (!this.providers.getProvider(this._criticId)) this._criticId = 'openrouter';
  }
}

module.exports = AgentManager;
module.exports.parseReview = parseReview;
module.exports.CREATIVE_DIRECTOR_SYSTEM = CREATIVE_DIRECTOR_SYSTEM;
module.exports.CRITIC_SYSTEM = CRITIC_SYSTEM;
