// Modernize stage: continues an "analyzed" run with Translator -> Verifier ->
// Debugger -> shadow, for one program of the Analyzer's first slice. Every
// step is written to SpacetimeDB (status, code versions, test cases, results,
// changes, debug attempts, rule status, events), so the dashboard can show
// the proof live.
//
// The proof: the LEGACY program runs in its Docker image on generated inputs
// to record the expected outputs; the MODERN program runs on the same inputs
// in a locked-down container for its language; outputs and exit codes must
// match (see NORMALIZATION_POLICY). The Debugger only ever sees failing
// "debug" cases; "holdout" cases are never shown to it, so passing them shows
// the fix generalises.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT, dockerizeZip, type LegacyBundle } from '../dockerize.ts';
import { LEGACY_DIR, shq } from '../analyzer/runtime.ts';
import { Stdb, type Row } from '../stdb.ts';
import { debugFix, loadLegacyContext, translate, writeTests, type Failure, type GeneratedCase, type LegacyContext, type RuleRow, type StoredComponent } from './agents.ts';
import { canonical, NORMALIZATION_POLICY, runBatch, type BatchResult, type CaseInput } from './sandbox.ts';
import { pickTarget, type TargetProfile } from './targets.ts';

export interface ModernizeOptions {
  /** Program name to modernize (default: picked from the first slice). */
  only?: string;
  /** Debug attempts after the first translation (1-5). */
  maxAttempts?: number;
  log?: (msg: string) => void;
  /** Reuse an already-built bundle (when called right after the Analyzer). */
  bundle?: LegacyBundle;
}

export interface ModernizeResult {
  runId: string;
  component: string;
  target: string;
  status: 'ready_for_cutover' | 'failed';
  attempts: number;
  debugPassed: number;
  debugTotal: number;
  holdoutPassed: number;
  holdoutTotal: number;
  reason: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Turns the Analyzer's recorded syntax-check command into a build command. Exported for tests. */
export function legacyBuildCommand(syntaxCheck: string, extraSources: string[]): string {
  const cmd = syntaxCheck.replace(/-I ''/g, '-I .');
  const extras = extraSources.map(shq).join(' ');
  if (cmd.includes('-fsyntax-only')) {
    const out = /^\s*cobc\b/.test(cmd) ? '-x -o /tmp/legacy_prog' : '-o /tmp/legacy_prog';
    return `${cmd.replace('-fsyntax-only', out)}${extras ? ` ${extras}` : ''}`;
  }
  if (cmd.includes('-o /dev/null')) {
    return `${cmd.replace('-o /dev/null', '-o /tmp/legacy.o')} && (ld -o /tmp/legacy_prog /tmp/legacy.o || gcc -no-pie -o /tmp/legacy_prog /tmp/legacy.o)`;
  }
  throw new Error(`don't know how to build from: ${syntaxCheck}`);
}

/** Chooses the program to modernize. Exported for tests. */
export function pickComponent(components: StoredComponent[], firstSlice: string[], only?: string): StoredComponent | undefined {
  const ok = components.filter(c => c.verifiable && c.compile?.status === 'ok' && c.compile.command && c.role !== 'template');
  if (only) return ok.find(c => c.name.toUpperCase() === only.toUpperCase() || c.path === only);
  const inSlice = (c: StoredComponent) => firstSlice.some(s => s === c.path || s.endsWith(c.path) || c.path.endsWith(s) || s.toUpperCase() === c.name.toUpperCase());
  const score = (c: StoredComponent) =>
    (inSlice(c) ? 100 : 0) + (c.file_io.length === 0 ? 50 : 0) + (c.takes_parameters ? 0 : 20) + (c.rule_ids.length ? 10 : 0) - c.lines / 1000;
  return [...ok].sort((a, b) => score(b) - score(a))[0];
}

/** debug / holdout split: every third case is holdout. Exported for tests. */
export const splitOf = (i: number): 'debug' | 'holdout' => (i % 3 === 2 ? 'holdout' : 'debug');

export async function modernizeRun(zipPath: string, runId: string, opts: ModernizeOptions = {}): Promise<ModernizeResult> {
  const say = opts.log ?? ((m: string) => console.log(m));
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) throw new Error('STDB_TOKEN is empty in AgentBox/.env (see scripts/README.md)');
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 5, 0), 5);

  let seq = 0;
  const stamp = Date.now().toString(36);
  const event = async (agent: string, message: string) => {
    say(`[${agent}] ${message}`);
    try {
      await db.logEvent(`${runId}:mod-${stamp}-${String(++seq).padStart(4, '0')}`, runId, agent, message);
    } catch (e) {
      say(`  (event not stored: ${e instanceof Error ? e.message.slice(0, 120) : e})`);
    }
  };

  // 1. Load the analyzed run from SpacetimeDB (the source of truth).
  const run = (await db.sql(`SELECT * FROM run WHERE id = ${sqlStr(runId)}`))[0];
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'analyzed') throw new Error(`run ${runId} is "${run.status}"; only an "analyzed" run can be modernized`);
  const analysis = await db.sql(`SELECT * FROM analysis WHERE run_id = ${sqlStr(runId)}`);
  const json = (kind: string) => analysis.filter(a => a.kind === kind).map(a => JSON.parse(String(a.json)));
  const inventory = json('inventory')[0] as { root: string } | undefined;
  const system = json('system')[0] as { first_slice?: string[] } | undefined;
  const components = json('component') as StoredComponent[];
  if (!inventory) throw new Error('run has no inventory analysis');

  const bundle = opts.bundle ?? (await dockerizeZip(zipPath));
  if (bundle.zipSha256 !== run.legacy_sha256) throw new Error(`this zip (sha256 ${bundle.zipSha256.slice(0, 12)}) is not the one run ${runId} analyzed`);

  const component = pickComponent(components, system?.first_slice ?? [], opts.only);
  if (!component) {
    throw new Error(opts.only ? `no verifiable, compiling program named ${opts.only}` : 'no verifiable program that compiles; nothing to modernize');
  }
  const ruleRows = (await db.sql(`SELECT * FROM rule WHERE run_id = ${sqlStr(runId)}`)) as unknown as (RuleRow & Row)[];
  const rules = ruleRows.filter(r => component.rule_ids.includes(String(r.id)));
  const { profile: target, fallback } = pickTarget(String(run.target_language));
  const projectDir = path.join(bundle.extractDir, inventory.root);
  const ctx = await loadLegacyContext(projectDir, component, rules);
  const workDir = path.join(AGENTBOX_ROOT, '.cache', 'modernize', runId.replace(/[^\w.-]/g, '_'));
  await mkdir(workDir, { recursive: true });

  const stopBeat = db.keepAlive(runId);
  try {
    if (component.file_io.length) {
      await event('verifier', `Note: ${component.name} also uses files (${component.file_io.map(f => f.name).join(', ')}); this proof covers its stdin/stdout behaviour only.`);
    }
    return await pipeline({ db, runId, bundle, component, ctx, target, fallback, targetLanguage: String(run.target_language), workDir, maxAttempts, event, legacyCwd: `${LEGACY_DIR}/${inventory.root}` });
  } finally {
    stopBeat();
  }
}

interface PipelineArgs {
  db: Stdb;
  runId: string;
  bundle: LegacyBundle;
  component: StoredComponent;
  ctx: LegacyContext;
  target: TargetProfile;
  fallback: boolean;
  targetLanguage: string;
  workDir: string;
  maxAttempts: number;
  event: (agent: string, message: string) => Promise<void>;
  legacyCwd: string;
}

async function pipeline(p: PipelineArgs): Promise<ModernizeResult> {
  const { db, runId, component, ctx, target, event, workDir } = p;
  const fail = async (reason: string, partial: Partial<ModernizeResult> = {}): Promise<ModernizeResult> => {
    await event('verifier', `Run failed: ${reason}`);
    await db.finishRun(runId, 'failed');
    return { runId, component: component.name, target: target.label, status: 'failed', attempts: 0, debugPassed: 0, debugTotal: 0, holdoutPassed: 0, holdoutTotal: 0, reason, ...partial };
  };

  // 2. Verifier first half: test inputs from Nemotron, expected outputs from the LEGACY program.
  await db.setRunStatus(runId, 'translating');
  await event('verifier', 'Designing test inputs from the business rules');
  let gen: GeneratedCase[];
  try {
    gen = (await writeTests(db, ctx, problem => void event('verifier', `Tests rejected (${problem.slice(0, 160)}); retrying`))).cases;
  } catch (e) {
    return fail(`test design failed: ${e instanceof Error ? e.message : e}`);
  }
  const inputs: CaseInput[] = gen.map((c, i) => ({ id: String(i + 1).padStart(2, '0'), stdin: c.input }));
  const extraSources = component.calls.map(c => c.file).filter((f): f is string => !!f && f !== component.path);
  let legacyBuild: string;
  try {
    legacyBuild = legacyBuildCommand(component.compile!.command!, extraSources);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  await event('verifier', `Running the legacy program on ${inputs.length} inputs in its Docker image (${p.bundle.imageTag}, no network, read-only)`);
  const legacy = await runBatch({
    image: p.bundle.imageTag,
    build: legacyBuild,
    run: '/tmp/legacy_prog',
    workDir: path.join(workDir, 'legacy'),
    mounts: [{ host: p.bundle.extractDir, container: LEGACY_DIR }],
    cases: inputs,
    cwd: p.legacyCwd,
  });
  if (!legacy.built) return fail(`the legacy program did not build in its image: ${legacy.buildLog.slice(0, 300)}`);

  const cases: { id: string; tc: GeneratedCase; input: string; expected: string; split: 'debug' | 'holdout' }[] = [];
  let dropped = 0;
  for (const [i, inp] of inputs.entries()) {
    const r = legacy.cases.get(inp.id);
    if (!r || r.timedOut) {
      dropped++;
      continue;
    }
    cases.push({ id: `${runId}:tc-${inp.id}`, tc: gen[i], input: inp.stdin, expected: canonical(r.stdout, r.exitCode), split: splitOf(cases.length) });
  }
  if (dropped) await event('verifier', `Dropped ${dropped} input(s) where the legacy program hung (no reproducible output)`);
  if (cases.length < 4) return fail(`only ${cases.length} usable test cases`);
  await db.addTestCases(
    runId,
    cases.map((c, i) => ({ id: c.id, test_index: i + 1, split: c.split, kind: c.tc.kind, origin: 'generated', rule_id: c.tc.rule_id, input: c.input, legacy_output: c.expected }))
  );
  const holdoutTotal = cases.filter(c => c.split === 'holdout').length;
  const debugTotal = cases.length - holdoutTotal;
  await event('verifier', `Recorded ${cases.length} golden outputs from the legacy program: ${debugTotal} debug, ${holdoutTotal} holdout (the Debugger never sees holdout cases)`);

  // What the dashboard needs that no table holds: the legacy source ("before"
  // pane), the modern file name and the test names. Written now so a run in
  // progress shows them; the final report below replaces this row (same key).
  const reportBase = {
    component: component.name,
    legacy_path: component.path,
    legacy_language: component.language,
    legacy_source: ctx.source,
    modern_file: target.file,
    target: target.label,
    target_image: target.image,
    legacy_image: p.bundle.imageTag,
    legacy_build: legacyBuild,
    modern_build: target.build,
    modern_run: target.run,
    normalization: NORMALIZATION_POLICY,
    cases: cases.length,
    test_names: Object.fromEntries(cases.map(c => [c.id, c.tc.name])),
  };
  await db.addAnalysis(runId, 'verification', component.path, { ...reportBase, status: 'running', reason: '' });

  // 3. Translator, shown the legacy program's real output on a few DEBUG cases (never holdout).
  const examples = cases.filter(c => c.split === 'debug').slice(0, 4).map(c => ({ input: c.input, expected: c.expected }));
  await event('translator', `Translating ${component.name} (${component.path}, ${component.lines} lines, ${ctx.rules.length} rules) to ${target.label}${p.fallback ? ` (target "${p.targetLanguage}" has no sandbox profile yet, so Python is used)` : ''}`);
  let tr;
  try {
    tr = await translate(db, ctx, target, examples, problem => void event('translator', `Answer rejected (${problem.slice(0, 160)}); retrying`));
  } catch (e) {
    return fail(`translation failed: ${e instanceof Error ? e.message : e}`);
  }
  let code = tr.code;
  const writeCode = async (attempt: number, src: string) => {
    const dir = path.join(workDir, `attempt-${attempt}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, target.file), src);
    return dir;
  };
  let codeDir = await writeCode(0, code);
  await db.addCodeVersion(runId, 0, code, sha256(code), '');
  await db.addChange(`${runId}:chg-0`, runId, 0, 'translator', '', `Translated ${component.name} to ${target.label}`, tr.notes.slice(0, 2000), code.split('\n').map(l => `+${l}`).join('\n'));
  for (const m of tr.rule_map) {
    try {
      await db.setRuleModernLines(m.rule_id, m.start_line, m.end_line);
    } catch (e) {
      await event('translator', `Could not map ${m.rule_id}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
  await event('translator', `Wrote ${target.file}: ${code.split('\n').length} lines, ${tr.rule_map.length}/${ctx.rules.length} rules mapped to modern lines. Nemotron: ${tr.stats.turns} turns, ${tr.stats.reasoningTokens} reasoning tokens`);

  await db.setRunStatus(runId, 'verifying');

  // 4. Verify, then debug and re-verify until everything passes or attempts run out.
  const runModern = (dir: string, label: string): Promise<BatchResult> =>
    runBatch({
      image: target.image,
      build: target.build,
      run: target.run,
      workDir: path.join(workDir, label),
      mounts: [{ host: dir, container: '/work' }],
      cases: cases.map(c => ({ id: c.id.split(':tc-')[1], stdin: c.input })),
    });
  const score = (res: BatchResult) =>
    cases.map(c => {
      const r = res.cases.get(c.id.split(':tc-')[1]);
      const actual = res.built && r ? canonical(r.stdout, r.exitCode) : res.built ? '[no result]' : '[build failed]';
      return { c, passed: actual === c.expected, actual, stderr: r?.stderr ?? '' };
    });

  const history: string[] = [];
  let attempt = 0;
  let scored: ReturnType<typeof score>;
  let lastRun: BatchResult;
  let pendingDebug: { diagnosis: string; fix: string; errorSummary: string } | undefined;
  for (;;) {
    await event('verifier', `Attempt ${attempt}: running ${target.label} code on all ${cases.length} cases (${target.image}, no network, read-only)`);
    lastRun = await runModern(codeDir, `modern-${attempt}`);
    scored = score(lastRun);
    await db.addTestResults(runId, attempt, scored.map(s => ({ test_case_id: s.c.id, passed: s.passed, modern_output: s.actual })));
    const dPass = scored.filter(s => s.c.split === 'debug' && s.passed).length;
    const hPass = scored.filter(s => s.c.split === 'holdout' && s.passed).length;
    const allPass = dPass === debugTotal && hPass === holdoutTotal;
    await event('verifier', lastRun.built
      ? `Attempt ${attempt}: debug ${dPass}/${debugTotal}, holdout ${hPass}/${holdoutTotal} identical to legacy`
      : `Attempt ${attempt}: the ${target.label} code does not build`);

    if (pendingDebug) {
      const outcome = allPass ? 'fixed' : attempt >= p.maxAttempts ? 'unresolved' : 'still_failing';
      await db.addDebugAttempt(`${runId}:dbg-${attempt}`, runId, attempt, pendingDebug.errorSummary, pendingDebug.diagnosis.slice(0, 2000), pendingDebug.fix.slice(0, 2000), dPass + hPass, cases.length, outcome);
      pendingDebug = undefined;
    }
    if (allPass) break;
    if (attempt >= p.maxAttempts) break;
    const failures: Failure[] = scored
      .filter(s => s.c.split === 'debug' && !s.passed)
      .map(s => ({ name: s.c.tc.name, input: s.c.input, expected: s.c.expected, actual: s.actual, stderr: s.stderr }));
    if (lastRun.built && failures.length === 0) {
      await event('debugger', 'Every debug case passes but some holdout cases fail. The Debugger is not allowed to see holdout cases, so it stops here.');
      break;
    }

    attempt++;
    await db.setRunStatus(runId, 'debugging');
    const errorSummary = lastRun.built ? `${failures.length} debug case(s) differ from legacy` : `build failed: ${lastRun.buildLog.split('\n')[0]?.slice(0, 200)}`;
    await event('debugger', `Attempt ${attempt}: ${errorSummary}; diagnosing`);
    let fix;
    try {
      fix = await debugFix(db, ctx, target, { code, attempt, buildLog: lastRun.built ? undefined : lastRun.buildLog, failures, history }, problem =>
        void event('debugger', `Fix rejected (${problem.slice(0, 160)}); retrying`)
      );
    } catch (e) {
      await event('debugger', `Debugger failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      break;
    }
    history.push(`${fix.diagnosis} -> ${fix.fix_summary}`.slice(0, 400));
    await event('debugger', `Diagnosis: ${fix.diagnosis.slice(0, 300)}`);
    code = fix.code;
    codeDir = await writeCode(attempt, code);
    await db.addCodeVersion(runId, attempt, code, sha256(code), '');
    await db.addChange(`${runId}:chg-${attempt}`, runId, attempt, 'debugger', '', fix.fix_summary.slice(0, 500), fix.diagnosis.slice(0, 2000), code.split('\n').map(l => `+${l}`).join('\n'));
    pendingDebug = { diagnosis: fix.diagnosis, fix: fix.fix_summary, errorSummary };
    await db.setRunStatus(runId, 'verifying');
  }

  // 5. Rule status from the final results.
  for (const r of ctx.rules) {
    const mine = scored.filter(s => s.c.tc.rule_id === r.id);
    if (!mine.length) continue;
    const status = mine.every(s => s.passed) ? (attempt === 0 ? 'verified' : 'fixed') : 'unresolved';
    try {
      await db.updateRuleStatus(r.id, status);
    } catch {
      /* rule may have been approved already */
    }
  }

  const dPass = scored.filter(s => s.c.split === 'debug' && s.passed).length;
  const hPass = scored.filter(s => s.c.split === 'holdout' && s.passed).length;
  const base = { attempts: attempt, debugPassed: dPass, debugTotal, holdoutPassed: hPass, holdoutTotal };
  const report = async (status: string, reason: string) =>
    db.addAnalysis(runId, 'verification', component.path, { ...reportBase, ...base, status, reason });

  if (dPass !== debugTotal || hPass !== holdoutTotal) {
    const reason = `${debugTotal - dPass} debug and ${holdoutTotal - hPass} holdout case(s) still differ after ${attempt} debug attempt(s)`;
    await report('failed', reason);
    return fail(reason, base);
  }

  // 6. Shadow: run the final code again in a fresh container; outputs must be identical (no flakiness).
  await db.setRunStatus(runId, 'shadow');
  await event('verifier', 'Shadow run: re-running the final code in a fresh container to check the results are stable');
  const again = score(await runModern(codeDir, 'shadow'));
  const unstable = again.filter((s, i) => s.actual !== scored[i].actual).length;
  if (unstable) {
    const reason = `${unstable} case(s) gave different output on the shadow run (non-deterministic)`;
    await report('failed', reason);
    return fail(reason, base);
  }
  const reason = `All ${cases.length} cases identical to the legacy program (${holdoutTotal} unseen holdout cases included), stable on a shadow run`;
  await report('ready_for_cutover', reason);
  await event('verifier', `PROOF COMPLETE: ${reason}`);
  await db.finishRun(runId, 'ready_for_cutover');
  return { runId, component: component.name, target: target.label, status: 'ready_for_cutover', ...base, reason };
}
