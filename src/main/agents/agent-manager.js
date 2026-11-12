// agent-manager.js
//
// The multi-role game-development workflow. This is the "execution layer" the
// original VolleyPrompt lacked: it does not just generate text, it drives a real
// coding agent against a real project directory and iterates on the result.
//
// Workflow:
//   USER IDEA -> CREATIVE DIRECTOR (brief) -> CODING AGENT (build) -> PREVIEW
//            -> VALIDATION GATE (entry/syntax/build/runtime) -> CRITIC (review)
//            -> [fixes] -> CODING AGENT -> (repeat, max N rounds) -> FINAL RESULT
//
// Completion policy (v2):
//   - `completed: true` requires BOTH a passing validation gate AND a Critic
//     SHIP/CLOSE with zero HIGH/MED findings. The Critic alone can NEVER
//     complete a build.
//   - Developer crash / unusable output -> restore the last known-good
//     checkpoint, surface the error.
//   - Validation failure -> KEEP the work, feed the validation errors into the
//     next round (rolling back then asking the Developer to "fix" files that
//     no longer exist would be self-defeating).
//   - Final round still failing -> restore the last known-good state and
//     return completed:false.
//
// Roles are independently configurable: the Director and Critic are chat providers
// (reusing lib/providers.js); the Developer is a coding-agent adapter (Codex /
// Claude Code / Gemini CLI) or a provider-backed ProviderDevAgent.
//
// All loops are BOUNDED and clamped (clampRounds).

const { validateProject } = require('../lib/validate-project.js');

const DEFAULT_MAX_ROUNDS = 3;
const MAX_ROUNDS_CAP = 5;

// Clamp an untrusted round count: NaN/garbage/<=0 -> default, hard cap above.
function clampRounds(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ROUNDS;
  return Math.min(n, MAX_ROUNDS_CAP);
}

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

Judge against these engine-quality criteria where relevant: a clamped-dt requestAnimationFrame main loop; explicit persistent game states (never stalling on empty waves or failed spawns); shape-appropriate collision with pickup areas matching what is drawn; balanced ctx.save()/restore(); gameplay constants in one CONFIG; complete files (no truncation).

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
  // hooks: { loadPreview({projectPath, entry}), onCheckpoint(info), getPreview() }.
  //   getPreview() returns the embedded PreviewManager (or null) so the
  //   validation gate can watch preview:ready / preview:console / preview:fail.
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
    const res = await provider.chat({
      model,
      system: CREATIVE_DIRECTOR_SYSTEM,
      messages: [{ role: 'user', content: `Game idea: ${idea}` }],
      signal,
      onDelta: (d) => this._emit(onEvent, { type: 'agent:output', role: 'director', text: d }),
    });
    this._emit(onEvent, { type: 'agent:status', role: 'director', status: 'done', message: 'Development brief ready.' });
    return res.text;
  }

  async _review(brief, { signal, onEvent }) {
    this._emit(onEvent, { type: 'agent:status', role: 'critic', status: 'working', message: 'Reviewing the build…' });
    const summary = await this.projectManager.getProjectSummary().catch(() => ({ name: '', entry: null, tree: [], manifest: '' }));
    const ctx = `DEVELOPMENT BRIEF:\n${brief}\n\nPROJECT SUMMARY:\n${JSON.stringify({ entry: summary.entry, tree: summary.tree.slice(0, 60) }, null, 2)}\n\nKEY FILES:\n${summary.manifest.slice(0, 6000)}`;
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
    const { findings, verdict } = parseReview(res.text);
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

  // Run the developer. `restore` (optional) is handed to the agent so a mid-write
  // staged-commit failure puts the project back BEFORE this throws.
  async _develop(taskPrompt, { developerId, developerModel, signal, onEvent, label, restore }) {
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
          else if (ev.type === 'stage' || ev.type === 'error') this._emit(onEvent, Object.assign({}, ev, { role: 'developer' }));
          else this._emit(onEvent, { type: 'agent:diagnostic', role: 'developer', text: ev.text });
        },
        restore,
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

  // The validation gate: execution-level proof (entry refs, syntax, optional
  // build, preview runtime health) before the Critic is ever consulted.
  async _validate({ onEvent, entry }) {
    const preview = this.hooks.getPreview ? this.hooks.getPreview() : null;
    const entryFile = entry && entry.type === 'file' ? entry.path : 'index.html';
    return validateProject({
      root: this.projectManager.active.path,
      preview,
      entryFile,
      emit: (e) => this._emit(onEvent, e),
    });
  }

  _safeRestore(cp, onEvent) {
    if (!cp) return Promise.resolve();
    return this.projectManager.checkpoint().restore(this.projectManager.active.path, cp.id)
      .then(() => this._emit(onEvent, { type: 'restored', checkpoint: cp.id, label: cp.label }))
      .catch(() => {});
  }

  // Shared bounded round loop with the completion policy documented at the top.
  async _runRounds({ buildTask, brief, signal, onEvent, maxRounds }) {
    const rounds = clampRounds(maxRounds);
    const root = this.projectManager.active.path;
    let lastGood = await this.projectManager.checkpoint().create(root, 'baseline').catch(() => null);
    let feedback = null;
    let lastEntry = null;
    let lastValidation = null;
    let lastReview = { findings: [], verdict: 'NEEDS-WORK' };
    let round = 0;

    while (round < rounds) {
      round++;
      this._emit(onEvent, { type: 'progress', phase: 'develop', round, maxRounds: rounds });
      const fixNote = feedback
        ? `\n\nIMPORTANT — the previous pass did not fully succeed. Fix ALL of these before anything else:\n${feedback}`
        : '';
      const restoreTo = async () => this._safeRestore(lastGood, onEvent);

      try {
        await this._develop(buildTask + fixNote, {
          developerId: this._developerId,
          developerModel: this._developerModel,
          signal,
          onEvent,
          label: round > 1 ? `Fixing issues (round ${round})…` : 'Building the game…',
          restore: restoreTo,
        });
      } catch (err) {
        // Crash or unusable output -> put the project back, then surface the error.
        await restoreTo();
        this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'error', message: `Rolled back to "${lastGood ? lastGood.label : 'baseline'}": ${err.message}` });
        throw err;
      }

      // Reload the preview FIRST so validation never reads stale state.
      lastEntry = await this._reloadPreview(onEvent);
      this._emit(onEvent, { type: 'progress', phase: 'validate', round, maxRounds: rounds });
      const validation = await this._validate({ onEvent, entry: lastEntry });
      lastValidation = validation;

      if (!validation.ok) {
        this._emit(onEvent, { type: 'validation:failed', round, checks: validation.checks, blocking: validation.blocking });
        // Keep the work; feed the validation errors into the next round.
        feedback = `VALIDATION FAILED — fix these execution-level problems:\n${validation.blocking.map((b) => `- ${b}`).join('\n')}`;
        continue;
      }

      // This state is execution-verified good; it becomes the rollback point.
      lastGood = await this.projectManager.checkpoint().create(root, `round-${round}-valid`).catch(() => lastGood);

      this._emit(onEvent, { type: 'progress', phase: 'review', round, maxRounds: rounds });
      lastReview = await this._review(brief, { signal, onEvent });
      const highOrMed = lastReview.findings.filter((f) => f.severity !== 'LOW');
      const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE') && highOrMed.length === 0;
      if (passed) {
        this._emit(onEvent, { type: 'stage', stage: 'success' });
        return { completed: true, round, rounds, entry: lastEntry, review: lastReview, validation };
      }
      feedback = `Review findings to address:\n${lastReview.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`;
    }

    // Out of rounds and not complete: restore the last known-good state.
    await this._safeRestore(lastGood, onEvent);
    return {
      completed: false,
      round,
      rounds,
      entry: lastEntry,
      review: lastReview,
      validation: lastValidation,
      reason: 'Did not pass validation and review within the round limit',
      blocking: lastValidation ? lastValidation.blocking : [],
    };
  }

  // Public: create a brand-new game from an idea.
  async createGame({ idea, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS }) {
    this._setRoles(roles);
    await this.projectManager.openProject(projectPath);
    this._emit(onEvent, { type: 'progress', phase: 'brief', round: 0, maxRounds: clampRounds(maxRounds) });
    const brief = await this._brief(idea, { signal, onEvent });

    const task = `Implement the game described by this development brief as a real, PLAYABLE project in the current working directory. Create every file in the FILE PLAN. The result must run by opening index.html (or the project's dev server). Prioritise: it must actually run without errors, be fun, and match the brief. Brief:\n\n${brief}`;

    const out = await this._runRounds({ buildTask: task, brief, signal, onEvent, maxRounds });
    this._emit(onEvent, { type: 'game:done', result: this._result(out) });
    return {
      brief,
      entry: out.entry,
      review: out.review,
      rounds: out.round,
      completed: out.completed,
      validation: out.validation,
    };
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

    const out = await this._runRounds({ buildTask: baseTask, brief: '', signal, onEvent, maxRounds });
    this._emit(onEvent, { type: 'game:done', result: this._result(out) });
    return { entry: out.entry, review: out.review, rounds: out.round, completed: out.completed, validation: out.validation };
  }

  _result(out) {
    return {
      // completed:true is only reachable through a passing validation gate.
      verifiedFixes: out.completed && out.validation ? out.validation.checks : [],
      validation: out.validation ? { ok: out.validation.ok, checks: out.validation.checks, warnings: out.validation.warnings } : null,
      unverifiedImprovements: (out.review.findings || []).filter((f) => f.severity === 'LOW').map((f) => f.message),
      knownIssues: (out.review.findings || []).filter((f) => f.severity === 'HIGH' || f.severity === 'MED').map((f) => f.message),
      verdict: out.review.verdict || 'NONE',
      completed: out.completed,
      entry: out.entry,
      rounds: out.round,
      reason: out.reason,
    };
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
module.exports.clampRounds = clampRounds;
module.exports.CREATIVE_DIRECTOR_SYSTEM = CREATIVE_DIRECTOR_SYSTEM;
module.exports.CRITIC_SYSTEM = CRITIC_SYSTEM;
