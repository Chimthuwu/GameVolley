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

// Budget for the "CURRENT PROJECT CODE" section appended to fix/improve prompts (Q2).
const CODE_CONTEXT_BUDGET = 60 * 1024;
// Budget for the code the Critic actually sees (Q3).
const CRITIC_CODE_BUDGET = 24 * 1024;
// Completion bar (Q8): a SHIP/CLOSE verdict ships when there are no HIGH findings
// and at most this many MED findings. Configurable per run via `maxMed`.
const DEFAULT_MAX_MED = 2;
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

// Q9: for Director/Critic with no explicit model, prefer a CONNECTED CLI provider
// (subscription-billed — no per-token cost) over a free API model, so the two
// quality-critical roles use the strongest model the user actually has. Paid API
// keys are deliberately NOT auto-selected: auto-billing needs consent. The lookup
// is cached per AgentManager instance (CLI detection spawns processes).
async function pickStrongAutoModel(providers) {
  try {
    if (typeof providers.getProviderStatuses !== 'function') return null;
    const statuses = await providers.getProviderStatuses();
    for (const [id, st] of Object.entries(statuses || {})) {
      if (!st || !st.connected) continue;
      const p = providers.getProvider(id);
      if (!p || p.authType !== 'cli') continue; // subscription CLI only, never paid API
      const models = await p.getModels().catch(() => []);
      if (models.length) return { providerId: id, model: pickAutoModel(models) };
    }
  } catch { /* offline or registry unavailable: fall back to prefer-free */ }
  return null;
}

const CREATIVE_DIRECTOR_SYSTEM = `You are the Creative Director for an AI game studio. Given a short, often silly game idea, produce a concise DEVELOPMENT BRIEF that a coding agent will implement as a real, playable game. Be decisive and concrete.

Include exactly these sections:
1. CONCEPT & CORE LOOP — one paragraph on what the player does and why it's fun.
2. TECHNOLOGY — recommend ONE approach. Prefer a single self-contained HTML + JS (Canvas or Three.js) game unless the idea clearly needs a framework. If you pick Three.js, say so explicitly.
3. GAMEPLAY — concrete mechanics, controls, win/lose, scoring, difficulty (state the ramp: what gets harder, when).
4. STRUCTURE — level/world layout and progression.
5. VISUALS — art direction, colour palette, lighting, key effects.
6. AUDIO — music and sound-effect direction.
7. FILE PLAN — the exact files to create (e.g. index.html, game.js, style.css).
8. MUST-HAVE v1 — a short checklist of features the first playable build must have. Always include: win/lose + restart, an on-screen controls hint, and a difficulty ramp.

INTENT FIDELITY: the player's idea is the north star. If they ask for "the best" or a big vision, aim for it — never shrink their idea into a minimal toy, and never add restrictions, disclaimers or "private prototype" framing they did not ask for. When improving an existing game, keep what already works and its character, and add real content, polish and feel rather than only hardening it.

Keep the whole brief under 600 words. The coding agent will follow it literally.`;

const CRITIC_SYSTEM = `You are the QA Critic for an AI game studio. You are given the development brief and a summary of the implemented project (file tree + key files). Reason carefully about whether the PLAYABLE game would satisfy the brief and be fun.

Report concrete, actionable findings only. Put each finding on its own line as:
[SEVERITY] <finding>
where SEVERITY is one of HIGH, MED, or LOW:
  HIGH = the game is broken, does not run, or the core idea is unmet.
  MED  = a quality, polish, feel, or completeness issue that should be fixed.
  LOW  = a minor nitpick.

Judge against these engine-quality criteria where relevant: a clamped-dt requestAnimationFrame main loop; explicit persistent game states (never stalling on empty waves or failed spawns); shape-appropriate collision with pickup areas matching what is drawn; balanced ctx.save()/restore(); gameplay constants in one CONFIG; complete files (no truncation).
Judge against these GAME-FEEL criteria too: the game has real win/lose states and a RESTART that fully resets without a reload; there is a visible difficulty ramp; the controls are shown on screen; the game has some juice (screen shake, particles, WebAudio SFX after first input) — but flag it MED when juice is entirely absent on an otherwise complete game, not HIGH.

INTENT FIDELITY: also judge whether the build delivers the ambition of the brief (not just that it runs). A game that runs but is a stripped-down shell of the brief's concept — missing its signature mechanics, content or polish — is a MED or HIGH finding.

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

  // Q9: model auto-pick for the quality-critical roles. Explicit model wins;
  // otherwise prefer a CONNECTED CLI provider (subscription — no per-token cost);
  // otherwise the chosen provider's prefer-free pick. Cached per instance.
  async _autoRoleModel(role) {
    const explicit = role === 'director' ? this._directorModel : this._criticModel;
    const fallbackId = role === 'director' ? this._directorId : this._criticId;
    if (explicit) return { providerId: fallbackId, model: explicit };
    const strong = await this._strongAutoModel();
    if (strong) return strong;
    const provider = this.providers.getProvider(fallbackId);
    const models = await provider.getModels().catch(() => []);
    return { providerId: fallbackId, model: pickAutoModel(models) };
  }

  async _strongAutoModel() {
    if (this._strongAutoCache === undefined) {
      this._strongAutoCache = await pickStrongAutoModel(this.providers).catch(() => null);
    }
    return this._strongAutoCache;
  }

  async _brief(idea, { signal, onEvent }) {
    const picked = await this._autoRoleModel('director');
    const provider = this.providers.getProvider(picked.providerId);
    const model = picked.model;
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

  async _review(brief, { signal, onEvent, buildContext }) {
    const summary = await this.projectManager.getProjectSummary(buildContext).catch(() => ({ name: '', entry: null, tree: [], manifest: '' }));
    // Q3: the Critic reviews the REAL code, not 6 hand-picked filenames at 1500
    // chars: entry file + all project JS/CSS, head+tail truncated, ~24 KB total.
    const codeCtx = await this._projectCodeContext(buildContext, CRITIC_CODE_BUDGET, {
      tail: true,
      exts: /\.(js|mjs|cjs|ts|html|htm|css)$/i,
      header: 'PROJECT CODE',
    });
    const ctx = `DEVELOPMENT BRIEF:\n${brief}\n\nPROJECT SUMMARY:\n${JSON.stringify({ entry: summary.entry, tree: summary.tree.slice(0, 60) }, null, 2)}${codeCtx}`;
    const picked = await this._autoRoleModel('critic');
    const provider = this.providers.getProvider(picked.providerId);
    const model = picked.model;
    // Q6: vision Critic — attach the playtest screenshot when the model can see.
    let messages = [{ role: 'user', content: ctx }];
    let shotAttached = false;
    try {
      const caps = typeof provider.getCapabilities === 'function' ? provider.getCapabilities(model) : null;
      const preview = this.hooks.getPreview ? this.hooks.getPreview() : null;
      const shot = caps && caps.supportsVision && preview && typeof preview.capture === 'function'
        ? await preview.capture()
        : null;
      const url = shot && typeof shot.toDataURL === 'function' ? shot.toDataURL() : null;
      if (url) {
        messages = [{ role: 'user', content: [
          { type: 'text', text: ctx },
          { type: 'image_url', image_url: { url } },
        ] }];
        shotAttached = true;
      }
    } catch { /* fall back to text-only */ }
    this._emit(onEvent, { type: 'agent:status', role: 'critic', status: 'working', message: shotAttached ? 'Reviewing the build (with screenshot)…' : 'Reviewing the build…' });
    const res = await provider.chat({
      model,
      system: CRITIC_SYSTEM,
      messages,
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
  async _develop(taskPrompt, { developerId, developerModel, signal, onEvent, label, restore, buildContext }) {
    const agent = this._developerAgent(developerId);
    // Snapshot for change detection.
    const before = await this.projectManager.snapshotHashes(buildContext).catch(() => ({}));
    this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'working', message: label || 'Building the game…' });
    const cp = await this.projectManager.checkpoint().create(buildContext.path, label || 'pre-dev').catch(() => null);
    if (cp && this.hooks.onCheckpoint) this.hooks.onCheckpoint(cp);
    let result;
    try {
      result = await agent.runTask({
        projectPath: buildContext.path,
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
    const after = await this.projectManager.snapshotHashes(buildContext).catch(() => ({}));
    const changed = this.projectManager.diffSnapshots(before, after);
    for (const c of changed) this._emit(onEvent, { type: 'project:changed', path: c.path, operation: c.operation });
    this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'done', message: `${changed.length} file(s) changed.` });
    return { changed, result };
  }

  async _reloadPreview(onEvent, buildContext) {
    const entry = await this.projectManager.detectEntryPoint(buildContext).catch(() => null);
    if (!entry) {
      this._emit(onEvent, { type: 'preview:error', message: 'No playable entry point found in the project. The coding agent did not produce an index.html or dev server.' });
      return null;
    }
    this._emit(onEvent, { type: 'preview:load', entry });
    if (this.hooks.loadPreview) await this.hooks.loadPreview({ projectPath: buildContext.path, entry });
    return entry;
  }

  // The validation gate: execution-level proof (entry refs, syntax, optional
  // build, preview runtime health) before the Critic is ever consulted.
  async _validate({ onEvent, entry, buildContext }) {
    const preview = this.hooks.getPreview ? this.hooks.getPreview() : null;
    const entryFile = entry && entry.type === 'file' ? entry.path : 'index.html';
    return validateProject({
      root: buildContext.path,
      preview,
      entryFile,
      emit: (e) => this._emit(onEvent, e),
    });
  }

  _safeRestore(cp, onEvent, buildContext) {
    if (!cp) return Promise.resolve();
    return this.projectManager.checkpoint().restore(buildContext.path, cp.id)
      .then(() => this._emit(onEvent, { type: 'restored', checkpoint: cp.id, label: cp.label }))
      .catch(() => {});
  }

  // Full project code for fix/improve rounds (Q2) and critic review (Q3): the
  // model must edit/review what exists instead of working blind. Budgeted: the
  // entry file first, then the rest largest-first; a file that does not fit is
  // truncated with a notice (`tail: true` keeps a tail slice as well).
  async _projectCodeContext(buildContext, budget = CODE_CONTEXT_BUDGET, { tail = false, exts = null, header = 'CURRENT PROJECT CODE (edit this — do not start from scratch)' } = {}) {
    const files = (await this.projectManager.listFiles('', buildContext).catch(() => []))
      .filter((f) => f.type === 'file' && (!exts || exts.test(f.ext || '')));
    const entryPath = await this.projectManager.detectEntryPoint(buildContext).catch(() => null);
    const entryFile = entryPath && entryPath.type === 'file' ? entryPath.path : null;
    const sorted = [...files].sort((a, b) => {
      if (entryFile) { if (a.path === entryFile) return -1; if (b.path === entryFile) return 1; }
      return (b.size || 0) - (a.size || 0);
    });
    const parts = [];
    let used = 0;
    for (const f of sorted) {
      let text = '';
      try { text = await this.projectManager.readFile(f.path, buildContext); } catch { continue; }
      const header = `--- ${f.path} ---\n`;
      const room = budget - used - header.length - 60;
      if (room <= 0) break;
      if (Buffer.byteLength(text) <= room) {
        parts.push(header + text);
      } else if (tail) {
        const head = text.slice(0, Math.max(0, Math.floor(room * 0.6)));
        const tailPart = text.slice(-Math.max(0, Math.floor(room * 0.4)));
        parts.push(`${header}${head}\n[TRUNCATED: omitted middle of ${text.length} chars]\n${tailPart}`);
      } else {
        const head = text.slice(0, Math.max(0, Math.floor(room * 0.8)));
        parts.push(`${header}${head}\n[TRUNCATED: first ${head.length} of ${text.length} chars]`);
      }
      used += Buffer.byteLength(parts[parts.length - 1]) + 1;
    }
    if (!parts.length) return '';
    return `\n\n${header}:\n${parts.join('\n')}`;
  }

  // Shared bounded round loop with the completion policy documented at the top.
  async _runRounds({ buildTask, brief, signal, onEvent, maxRounds, includeCodeContext = false, maxMed = DEFAULT_MAX_MED }) {
    const rounds = clampRounds(maxRounds);
    // Capture immutable project context for this build.
    const buildContext = this.projectManager.startBuildContext();
    const root = buildContext.path;
    let lastGood = await this.projectManager.checkpoint().create(root, 'baseline').catch(() => null);
    let feedback = null;
    let lastEntry = null;
    let lastValidation = null;
    let lastReview = { findings: [], verdict: 'NEEDS-WORK' };
    // Best failed attempt so far (fewest blocking validation errors), used to keep
    // something instead of wiping the project when every round fails. Q1.
    let bestAttempt = { blocking: Infinity, checkpoint: null, round: 0 };
    let validatedAnyRound = false; // some round passed validation -> lastGood beats any failed attempt
    let round = 0;

    try {
      while (round < rounds) {
        round++;
        this._emit(onEvent, { type: 'progress', phase: 'develop', round, maxRounds: rounds });
        const fixNote = feedback
          ? `\n\nIMPORTANT — the previous pass did not fully succeed. Fix ALL of these before anything else:\n${feedback}`
          : '';
        // Fix/improve rounds get the existing code (Q2): edit, don't rewrite blind.
        let devPrompt = buildTask + fixNote;
        if (feedback || includeCodeContext) {
          const codeCtx = await this._projectCodeContext(buildContext);
          if (codeCtx) devPrompt += codeCtx;
        }
        const restoreTo = async () => this._safeRestore(lastGood, onEvent, buildContext);

        try {
          await this._develop(devPrompt, {
            developerId: this._developerId,
            developerModel: this._developerModel,
            signal,
            onEvent,
            label: round > 1 ? `Fixing issues (round ${round})…` : 'Building the game…',
            restore: restoreTo,
            buildContext,
          });
        } catch (err) {
          // Crash or unusable output -> put the project back, then surface the error.
          await restoreTo();
          this._emit(onEvent, { type: 'agent:status', role: 'developer', status: 'error', message: `Rolled back to "${lastGood ? lastGood.label : 'baseline'}": ${err.message}` });
          throw err;
        }

        // Reload the preview FIRST so validation never reads stale state.
        lastEntry = await this._reloadPreview(onEvent, buildContext);
        this._emit(onEvent, { type: 'progress', phase: 'validate', round, maxRounds: rounds });
        const validation = await this._validate({ onEvent, entry: lastEntry, buildContext });
        lastValidation = validation;

        // Snapshot failed attempts so a later wipe can restore the best one (Q1),
        // then keep the work and feed the validation errors into the next round.
        if (!validation.ok) {
          const blockingCount = validation.blocking.length;
          if (blockingCount < bestAttempt.blocking) {
            bestAttempt.blocking = blockingCount;
            bestAttempt.round = round;
            bestAttempt.checkpoint = await this.projectManager.checkpoint().create(root, `round-${round}-attempt`).catch(() => bestAttempt.checkpoint);
          }
          this._emit(onEvent, { type: 'validation:failed', round, checks: validation.checks, blocking: validation.blocking });
          feedback = `VALIDATION FAILED — fix these execution-level problems:\n${validation.blocking.map((b) => `- ${b}`).join('\n')}`;
          continue;
        }

        // This state is execution-verified good; it becomes the rollback point.
        lastGood = await this.projectManager.checkpoint().create(root, `round-${round}-valid`).catch(() => lastGood);
        validatedAnyRound = true;

        this._emit(onEvent, { type: 'progress', phase: 'review', round, maxRounds: rounds });
        lastReview = await this._review(brief, { signal, onEvent, buildContext });
        // Completion bar (Q8): no HIGH and at most `maxMed` MED findings ships.
        const high = lastReview.findings.filter((f) => f.severity === 'HIGH');
        const med = lastReview.findings.filter((f) => f.severity === 'MED');
        const passed = (lastReview.verdict === 'SHIP' || lastReview.verdict === 'CLOSE') && high.length === 0 && med.length <= maxMed;
        if (passed) {
          this._emit(onEvent, { type: 'stage', stage: 'success' });
          return { completed: true, round, rounds, entry: lastEntry, review: lastReview, validation };
        }
        feedback = `Review findings to address:\n${lastReview.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`;
      }

      // Out of rounds and not complete: never wipe the project (Q1). If a round
      // validated, lastGood is strictly better than any failed attempt. Otherwise
      // keep the attempt with the fewest blocking errors instead of the empty
      // baseline; if no round ever produced files, fall back to the baseline.
      const keepIssues = (!validatedAnyRound && bestAttempt.blocking !== Infinity) ? bestAttempt.blocking : null;
      if (keepIssues !== null && bestAttempt.checkpoint) {
        await this._safeRestore(bestAttempt.checkpoint, onEvent, buildContext);
        this._emit(onEvent, {
          type: 'kept-attempt', round: bestAttempt.round, issues: keepIssues,
          message: `Kept best attempt (round ${bestAttempt.round}, ${keepIssues} issue${keepIssues === 1 ? '' : 's'})`,
        });
      } else {
        await this._safeRestore(lastGood, onEvent, buildContext);
      }
      return {
        completed: false,
        round,
        rounds,
        entry: lastEntry,
        review: lastReview,
        validation: lastValidation,
        reason: keepIssues !== null
          ? `Did not pass validation and review within the round limit; kept best attempt (${keepIssues} blocking issue${keepIssues === 1 ? '' : 's'})`
          : 'Did not pass validation and review within the round limit',
        blocking: lastValidation ? lastValidation.blocking : [],
        keptAttempt: keepIssues !== null ? { round: bestAttempt.round, issues: keepIssues } : null,
      };
    } finally {
      // Always release the build context lock.
      this.projectManager.endBuildContext();
    }
  }

  // Public: create a brand-new game from an idea.
  async createGame({ idea, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS, maxMed = DEFAULT_MAX_MED }) {
    this._setRoles(roles);
    await this.projectManager.openProject(projectPath);
    this._emit(onEvent, { type: 'progress', phase: 'brief', round: 0, maxRounds: clampRounds(maxRounds) });
    const brief = await this._brief(idea, { signal, onEvent });

    const task = `Implement the game described by this development brief as a real, PLAYABLE project in the current working directory. Create every file in the FILE PLAN. The result must run by opening index.html (or the project's dev server). Prioritise: it must actually run without errors, be fun, and match the brief. Brief:\n\n${brief}`;

    const out = await this._runRounds({ buildTask: task, brief, signal, onEvent, maxRounds, maxMed });
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
  async improveGame({ idea, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS, maxMed = DEFAULT_MAX_MED }) {
    return this._followUp({ instruction: idea, projectPath, roles, signal, onEvent, maxRounds, maxMed, label: 'Improving the game…' });
  }

  // Public: fix a reported bug in ordinary language.
  async fixGame({ report, projectPath, roles, signal, onEvent, maxRounds = DEFAULT_MAX_ROUNDS, maxMed = DEFAULT_MAX_MED }) {
    return this._followUp({ instruction: `Fix this bug: ${report}`, projectPath, roles, signal, onEvent, maxRounds, maxMed, label: 'Fixing the bug…' });
  }

  async _followUp({ instruction, projectPath, roles, signal, onEvent, maxRounds, maxMed = DEFAULT_MAX_MED, label }) {
    this._setRoles(roles);
    await this.projectManager.openProject(projectPath);
    const summary = await this.projectManager.getProjectSummary().catch(() => ({ name: '', entry: null, tree: [], manifest: '' }));
    const baseTask = `You are improving an EXISTING game project in the current working directory. Follow the user's instruction literally — do not change the game's core concept unless asked. Respect the existing code style and files.\n\nEXISTING PROJECT:\n${JSON.stringify({ entry: summary.entry, tree: summary.tree.slice(0, 80) }, null, 2)}\n\nUSER INSTRUCTION:\n${instruction}`;

    const out = await this._runRounds({ buildTask: baseTask, brief: '', signal, onEvent, maxRounds, maxMed, includeCodeContext: true });
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
