// Modernize stage: continues an "analyzed" run for EVERY verifiable program:
//
//   Verifier (part 1)  Nemotron designs test inputs per program; the LEGACY
//                      program runs on them in its Docker image to record the
//                      golden outputs; cases are split debug / holdout.
//   Translator         one shared records module (copybooks), then every
//                      program in sections with a sandbox compile/lint gate,
//                      shown real legacy outputs from DEBUG cases (never holdout).
//   Verifier (part 2)  runs the modern program on all cases in a locked-down
//                      container; outputs and exit codes must match.
//   Debugger           sees only failing DEBUG cases; up to 5 attempts.
//   Shadow             re-runs passing code in a fresh container (stability).
//
// Everything goes to SpacetimeDB (status, translations, test cases/results,
// changes, debug attempts, rule status/lines, events) for the dashboard.
// The dashboard currently shows one program per run: the first program (the
// one the old single-program stage would have picked) also writes code_version.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT, dockerizeZip, type LegacyBundle } from '../dockerize.ts';
import { LEGACY_DIR, shq } from '../analyzer/runtime.ts';
import { Stdb, type Row } from '../stdb.ts';
import { relevantShared, ruleRanges, type Example, type TranslationResult } from '../translator/agent.ts';
import { contextFromDb, translateRun } from '../translator/index.ts';
import { ensureTargetImage, NORMALIZATION_POLICY, pickTarget, type TargetProfile } from '../translator/targets.ts';
import { debugFix, loadLegacyContext, writeTests, type Failure, type GeneratedCase, type LegacyContext, type ModernTarget, type RuleRow, type StoredComponent } from './agents.ts';
import { canonical, runBatch, type BatchResult, type CaseInput } from './sandbox.ts';

export interface ModernizeOptions {
  /** Program names to modernize (default: every verifiable program). */
  only?: string[];
  /** Debug attempts after the first translation (0-5). */
  maxAttempts?: number;
  log?: (msg: string) => void;
  /** Reuse an already-built bundle (when called right after the Analyzer). */
  bundle?: LegacyBundle;
}

export interface ProgramOutcome {
  name: string;
  path: string;
  file: string;
  status: 'passed' | 'failed';
  attempts: number;
  debugPassed: number;
  debugTotal: number;
  holdoutPassed: number;
  holdoutTotal: number;
  reason: string;
}

export interface ModernizeResult {
  runId: string;
  target: string;
  status: 'ready_for_cutover' | 'failed';
  programs: ProgramOutcome[];
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

const isCandidate = (c: StoredComponent) => c.verifiable && c.compile?.status === 'ok' && !!c.compile.command && c.role !== 'template';

/**
 * Verifiable programs in modernize order: first slice first, then programs
 * that only use stdin/stdout (fully covered by this proof), no parameters,
 * with rules; smaller first. Exported for tests.
 */
export function pickComponents(components: StoredComponent[], firstSlice: string[], only?: string[]): StoredComponent[] {
  const ok = components.filter(isCandidate);
  if (only?.length) {
    const want = only.map(o => o.toUpperCase());
    return ok.filter(c => want.includes(c.name.toUpperCase()) || only.includes(c.path));
  }
  const inSlice = (c: StoredComponent) => firstSlice.some(s => s === c.path || s.endsWith(c.path) || c.path.endsWith(s) || s.toUpperCase() === c.name.toUpperCase());
  const score = (c: StoredComponent) =>
    (inSlice(c) ? 100 : 0) + (c.file_io.length === 0 ? 50 : 0) + (c.takes_parameters ? 0 : 20) + (c.rule_ids.length ? 10 : 0) - c.lines / 1000;
  return [...ok].sort((a, b) => score(b) - score(a));
}

/** The single best program (kept for the old CLI flag and tests). */
export function pickComponent(components: StoredComponent[], firstSlice: string[], only?: string): StoredComponent | undefined {
  return pickComponents(components, firstSlice, only ? [only] : undefined)[0];
}

/** debug / holdout split: every third case is holdout. Exported for tests. */
export const splitOf = (i: number): 'debug' | 'holdout' => (i % 3 === 2 ? 'holdout' : 'debug');

interface PreparedProgram {
  component: StoredComponent;
  ctx: LegacyContext;
  legacyBuild: string;
  cases: { id: string; index: number; tc: GeneratedCase; input: string; expected: string; split: 'debug' | 'holdout' }[];
}

type Event = (agent: string, message: string) => Promise<void>;

export async function modernizeRun(zipPath: string, runId: string, opts: ModernizeOptions = {}): Promise<ModernizeResult> {
  const say = opts.log ?? ((m: string) => console.log(m));
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) throw new Error('STDB_TOKEN is empty in AgentBox/.env (see scripts/README.md)');
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 5, 0), 5);

  let seq = 0;
  const stamp = Date.now().toString(36);
  const event: Event = async (agent, message) => {
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
  const system = json('system')[0] as { first_slice?: string[]; target_runtime?: string } | undefined;
  const components = json('component') as StoredComponent[];
  if (!inventory) throw new Error('run has no inventory analysis');

  const bundle = opts.bundle ?? (await dockerizeZip(zipPath));
  if (bundle.zipSha256 !== run.legacy_sha256) throw new Error(`this zip (sha256 ${bundle.zipSha256.slice(0, 12)}) is not the one run ${runId} analyzed`);

  const chosen = pickComponents(components, system?.first_slice ?? [], opts.only);
  if (!chosen.length) throw new Error(opts.only?.length ? `no verifiable, compiling program named ${opts.only.join(', ')}` : 'no verifiable program that compiles; nothing to modernize');
  const ruleRows = (await db.sql(`SELECT * FROM rule WHERE run_id = ${sqlStr(runId)}`)) as unknown as (RuleRow & Row)[];
  const { profile: target, fallback } = pickTarget(String(run.target_language));
  const projectDir = path.join(bundle.extractDir, inventory.root);
  const workDir = path.join(AGENTBOX_ROOT, '.cache', 'modernize', runId.replace(/[^\w.-]/g, '_'));
  await mkdir(workDir, { recursive: true });

  const stopBeat = db.keepAlive(runId);
  try {
    await db.setRunStatus(runId, 'translating');
    await event('verifier', `Modernizing ${chosen.length} verifiable program(s) to ${target.label}${fallback ? ` (target "${run.target_language}" has no sandbox profile, so Python is used)` : ''}: ${chosen.map(c => c.name).join(', ')}`);

    // 2. Verifier part 1: test inputs and golden outputs, per program.
    const outcomes: ProgramOutcome[] = [];
    const prepared: PreparedProgram[] = [];
    let index = 0;
    for (const component of chosen) {
      const p = await prepareProgram({ db, runId, bundle, component, ruleRows, projectDir, workDir, inventoryRoot: inventory.root, event, firstIndex: index });
      if ('reason' in p) {
        outcomes.push(failedOutcome(component, target, p.reason));
        await event('verifier', `${component.name}: skipped (${p.reason})`);
        continue;
      }
      index += p.cases.length;
      prepared.push(p);
      if (component.file_io.length) {
        await event('verifier', `${component.name} also uses files (${component.file_io.map(f => f.name).join(', ')}); this proof covers its stdin/stdout behaviour only.`);
      }
    }
    if (!prepared.length) return finish(db, runId, target, outcomes, event);

    // 3. Translator: shared records module + every prepared program, with real
    // legacy outputs from DEBUG cases as examples (never holdout).
    const examples = new Map<string, Example[]>(
      prepared.map(p => [p.component.path, p.cases.filter(c => c.split === 'debug').slice(0, 4).map(c => ({ input: c.input, expected: c.expected }))])
    );
    const tctx = await contextFromDb(db, runId, zipPath);
    const translated = await translateRun(tctx, { only: prepared.map(p => p.component.name), examples, keepStatus: true, log: say });
    const image = await ensureTargetImage(target, system?.target_runtime ?? '');
    const shared = translated.shared;

    // 4. Verify -> debug -> shadow, one program at a time.
    await db.setRunStatus(runId, 'verifying');
    for (const [i, p] of prepared.entries()) {
      const tr = translated.programs.find(x => x.path === p.component.path);
      if (!tr?.result) {
        outcomes.push(failedOutcome(p.component, target, `translation failed: ${tr?.error ?? 'no result'}`));
        await reportVerification(db, runId, p, target, { status: 'failed', reason: `translation failed: ${tr?.error ?? 'no result'}` });
        continue;
      }
      outcomes.push(
        await verifyProgram({ db, runId, p, target, image, shared: shared!, translation: tr.result, file: tr.fileName, maxAttempts, event, workDir, primary: i === 0 })
      );
    }
    return finish(db, runId, target, outcomes, event);
  } finally {
    stopBeat();
  }
}

function failedOutcome(c: StoredComponent, target: TargetProfile, reason: string): ProgramOutcome {
  return { name: c.name, path: c.path, file: target.fileName(c.name), status: 'failed', attempts: 0, debugPassed: 0, debugTotal: 0, holdoutPassed: 0, holdoutTotal: 0, reason };
}

/** Designs tests for one program and records the legacy program's outputs. */
async function prepareProgram(a: {
  db: Stdb;
  runId: string;
  bundle: LegacyBundle;
  component: StoredComponent;
  ruleRows: (RuleRow & Row)[];
  projectDir: string;
  workDir: string;
  inventoryRoot: string;
  event: Event;
  firstIndex: number;
}): Promise<PreparedProgram | { reason: string }> {
  const { db, runId, component, event } = a;
  const rules = a.ruleRows.filter(r => component.rule_ids.includes(String(r.id)));
  const ctx = await loadLegacyContext(a.projectDir, component, rules);
  await event('verifier', `${component.name}: designing test inputs from ${rules.length} business rules`);
  let gen: GeneratedCase[];
  try {
    gen = (await writeTests(db, ctx, problem => void event('verifier', `${component.name}: tests rejected (${problem.slice(0, 160)}); retrying`))).cases;
  } catch (e) {
    return { reason: `test design failed: ${e instanceof Error ? e.message.slice(0, 200) : e}` };
  }
  const extraSources = component.calls.map(c => c.file).filter((f): f is string => !!f && f !== component.path);
  let legacyBuild: string;
  try {
    legacyBuild = legacyBuildCommand(component.compile!.command!, extraSources);
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  }
  const inputs: CaseInput[] = gen.map((c, i) => ({ id: String(i + 1).padStart(2, '0'), stdin: c.input }));
  await event('verifier', `${component.name}: running the legacy program on ${inputs.length} inputs in its Docker image (${a.bundle.imageTag}, no network, read-only)`);
  const legacy = await runBatch({
    image: a.bundle.imageTag,
    build: legacyBuild,
    run: '/tmp/legacy_prog',
    workDir: path.join(a.workDir, component.name, 'legacy'),
    mounts: [{ host: a.bundle.extractDir, container: LEGACY_DIR }],
    cases: inputs,
    cwd: `${LEGACY_DIR}/${a.inventoryRoot}`,
  });
  if (!legacy.built) return { reason: `the legacy program did not build in its image: ${legacy.buildLog.slice(0, 300)}` };

  const cases: PreparedProgram['cases'] = [];
  let dropped = 0;
  for (const [i, inp] of inputs.entries()) {
    const r = legacy.cases.get(inp.id);
    if (!r || r.timedOut) {
      dropped++;
      continue;
    }
    cases.push({
      id: `${runId}:${component.name}:tc-${inp.id}`,
      index: a.firstIndex + cases.length + 1,
      tc: gen[i],
      input: inp.stdin,
      expected: canonical(r.stdout, r.exitCode),
      split: splitOf(cases.length),
    });
  }
  if (dropped) await event('verifier', `${component.name}: dropped ${dropped} input(s) where the legacy program hung (no reproducible output)`);
  if (cases.length < 4) return { reason: `only ${cases.length} usable test cases` };
  await db.addTestCases(
    runId,
    cases.map(c => ({ id: c.id, test_index: c.index, split: c.split, kind: c.tc.kind, origin: 'generated', rule_id: c.tc.rule_id, input: c.input, legacy_output: c.expected }))
  );
  const holdout = cases.filter(c => c.split === 'holdout').length;
  await event('verifier', `${component.name}: recorded ${cases.length} golden outputs from the legacy program: ${cases.length - holdout} debug, ${holdout} holdout (the Debugger never sees holdout cases)`);
  const p = { component, ctx, legacyBuild, cases };
  await reportVerification(db, runId, p, undefined, { status: 'running', reason: '' });
  return p;
}

/** The per-program "verification" analysis row the dashboard reads. */
async function reportVerification(
  db: Stdb,
  runId: string,
  p: Pick<PreparedProgram, 'component' | 'ctx' | 'legacyBuild' | 'cases'>,
  target: TargetProfile | undefined,
  extra: Record<string, unknown>
): Promise<void> {
  await db.addAnalysis(runId, 'verification', p.component.path, {
    component: p.component.name,
    legacy_path: p.component.path,
    legacy_language: p.component.language,
    legacy_source: p.ctx.source,
    legacy_build: p.legacyBuild,
    ...(target ? { modern_file: target.fileName(p.component.name), target: target.label } : {}),
    normalization: NORMALIZATION_POLICY,
    cases: p.cases.length,
    test_names: Object.fromEntries(p.cases.map(c => [c.id, `${p.component.name}: ${c.tc.name}`])),
    ...extra,
  });
}

/** Verifier part 2 + Debugger + shadow for one translated program. */
async function verifyProgram(a: {
  db: Stdb;
  runId: string;
  p: PreparedProgram;
  target: TargetProfile;
  image: string;
  shared: TranslationResult;
  translation: TranslationResult;
  file: string;
  maxAttempts: number;
  event: Event;
  workDir: string;
  /** Also write code_version rows (the dashboard shows one program per run). */
  primary: boolean;
}): Promise<ProgramOutcome> {
  const { db, runId, p, target, event } = a;
  const name = p.component.name;
  const cases = p.cases;
  const sharedFile = target.sharedFileName;
  const holdoutTotal = cases.filter(c => c.split === 'holdout').length;
  const debugTotal = cases.length - holdoutTotal;
  const modernTarget: ModernTarget = {
    profile: target,
    file: a.file,
    shared: { fileName: sharedFile, text: relevantShared(a.shared, { includes: p.component.includes }) },
  };
  const base = { modern_file: a.file, target: target.label, target_image: a.image, modern_build: target.build(a.file), modern_run: target.run(a.file) };

  let code = a.translation.source;
  let ruleMap = a.translation.ruleMap;
  const writeCode = async (attempt: number, src: string) => {
    const dir = path.join(a.workDir, name, `attempt-${attempt}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, sharedFile), a.shared.source);
    await writeFile(path.join(dir, a.file), src);
    return dir;
  };
  const mapRules = async () => {
    for (const m of ruleRanges(code, ruleMap)) {
      try {
        await db.setRuleModernLines(m.rule_id, m.start_line, m.end_line);
      } catch {
        /* rule may belong to an older run */
      }
    }
  };
  let codeDir = await writeCode(0, code);
  if (a.primary) await db.addCodeVersion(runId, 0, code, sha256(code), a.translation.check.output.slice(0, 2000));
  await db.addChange(`${runId}:${name}:chg-0`, runId, 0, 'translator', '', `Translated ${name} to ${target.label}`, a.translation.notes.slice(0, 2000), code.split('\n').map(l => `+${l}`).join('\n'));
  await mapRules();

  const runModern = (dir: string, label: string): Promise<BatchResult> =>
    runBatch({
      image: a.image,
      build: target.build(a.file),
      run: target.run(a.file),
      workDir: path.join(a.workDir, name, label),
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
  await db.setRunStatus(runId, 'verifying');
  for (;;) {
    await event('verifier', `${name} attempt ${attempt}: running the ${target.label} code on all ${cases.length} cases (no network, read-only)`);
    lastRun = await runModern(codeDir, `modern-${attempt}`);
    scored = score(lastRun);
    await db.addTestResults(runId, attempt, scored.map(s => ({ test_case_id: s.c.id, passed: s.passed, modern_output: s.actual })));
    const dPass = scored.filter(s => s.c.split === 'debug' && s.passed).length;
    const hPass = scored.filter(s => s.c.split === 'holdout' && s.passed).length;
    const allPass = dPass === debugTotal && hPass === holdoutTotal;
    await event('verifier', lastRun.built
      ? `${name} attempt ${attempt}: debug ${dPass}/${debugTotal}, holdout ${hPass}/${holdoutTotal} identical to legacy`
      : `${name} attempt ${attempt}: the ${target.label} code does not build`);

    if (pendingDebug) {
      const outcome = allPass ? 'fixed' : attempt >= a.maxAttempts ? 'unresolved' : 'still_failing';
      await db.addDebugAttempt(`${runId}:${name}:dbg-${attempt}`, runId, attempt, `${name}: ${pendingDebug.errorSummary}`.slice(0, 500), pendingDebug.diagnosis.slice(0, 2000), pendingDebug.fix.slice(0, 2000), dPass + hPass, cases.length, outcome);
      pendingDebug = undefined;
    }
    if (allPass || attempt >= a.maxAttempts) break;
    const failures: Failure[] = scored
      .filter(s => s.c.split === 'debug' && !s.passed)
      .map(s => ({ name: s.c.tc.name, input: s.c.input, expected: s.c.expected, actual: s.actual, stderr: s.stderr }));
    if (lastRun.built && failures.length === 0) {
      await event('debugger', `${name}: every debug case passes but some holdout cases fail. The Debugger is not allowed to see holdout cases, so it stops here.`);
      break;
    }

    attempt++;
    await db.setRunStatus(runId, 'debugging');
    const errorSummary = lastRun.built ? `${failures.length} debug case(s) differ from legacy` : `build failed: ${lastRun.buildLog.split('\n')[0]?.slice(0, 200)}`;
    await event('debugger', `${name} attempt ${attempt}: ${errorSummary}; diagnosing`);
    let fix;
    try {
      fix = await debugFix(db, p.ctx, modernTarget, { code, attempt, buildLog: lastRun.built ? undefined : lastRun.buildLog, failures, history }, problem =>
        void event('debugger', `${name}: fix rejected (${problem.slice(0, 160)}); retrying`)
      );
    } catch (e) {
      await event('debugger', `${name}: Debugger failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      break;
    }
    history.push(`${fix.diagnosis} -> ${fix.fix_summary}`.slice(0, 400));
    await event('debugger', `${name}: ${fix.diagnosis.slice(0, 300)}`);
    code = fix.code;
    codeDir = await writeCode(attempt, code);
    await db.addTranslation({
      runId, component: p.component.path, name, attempt, language: target.label, fileName: a.file, source: code, sha256: sha256(code),
      checkStatus: 'unavailable', checkOutput: 'Debugger fix: checked by the Verifier build', ruleMap, notes: `${fix.diagnosis}\n${fix.fix_summary}`.slice(0, 2000),
    });
    if (a.primary) await db.addCodeVersion(runId, attempt, code, sha256(code), '');
    await db.addChange(`${runId}:${name}:chg-${attempt}`, runId, attempt, 'debugger', '', fix.fix_summary.slice(0, 500), fix.diagnosis.slice(0, 2000), code.split('\n').map(l => `+${l}`).join('\n'));
    // Functions may have moved: refresh the rule -> modern line ranges.
    ruleMap = ruleMap.filter(m => code.includes(m.function.split('.').pop()!));
    await mapRules();
    pendingDebug = { diagnosis: fix.diagnosis, fix: fix.fix_summary, errorSummary };
    await db.setRunStatus(runId, 'verifying');
  }

  // Rule status from the final results.
  for (const r of p.ctx.rules) {
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
  const counts = { attempts: attempt, debugPassed: dPass, debugTotal, holdoutPassed: hPass, holdoutTotal };
  const outcome = (status: 'passed' | 'failed', reason: string): ProgramOutcome => ({ name, path: p.component.path, file: a.file, status, ...counts, reason });
  const report = (status: string, reason: string) => reportVerification(db, runId, p, target, { ...base, ...counts, status, reason });

  if (dPass !== debugTotal || hPass !== holdoutTotal) {
    const reason = `${debugTotal - dPass} debug and ${holdoutTotal - hPass} holdout case(s) still differ after ${attempt} debug attempt(s)`;
    await report('failed', reason);
    await event('verifier', `${name}: FAILED: ${reason}`);
    return outcome('failed', reason);
  }

  // Shadow: the same code again in a fresh container; outputs must not change.
  await event('verifier', `${name}: shadow run (fresh container) to check the results are stable`);
  const again = score(await runModern(codeDir, 'shadow'));
  const unstable = again.filter((s, i) => s.actual !== scored[i].actual).length;
  if (unstable) {
    const reason = `${unstable} case(s) gave different output on the shadow run (non-deterministic)`;
    await report('failed', reason);
    await event('verifier', `${name}: FAILED: ${reason}`);
    return outcome('failed', reason);
  }
  const reason = `All ${cases.length} cases identical to the legacy program (${holdoutTotal} unseen holdout cases included), stable on a shadow run`;
  await report('ready_for_cutover', reason);
  await event('verifier', `${name}: PROOF COMPLETE: ${reason}`);
  return outcome('passed', reason);
}

/** Ends the run: ready_for_cutover only when every chosen program is proven. */
async function finish(db: Stdb, runId: string, target: TargetProfile, programs: ProgramOutcome[], event: Event): Promise<ModernizeResult> {
  const passed = programs.filter(p => p.status === 'passed');
  const allPassed = programs.length > 0 && passed.length === programs.length;
  const reason = `${passed.length}/${programs.length} program(s) proven identical to the legacy system${passed.length ? ` (${passed.map(p => p.name).join(', ')})` : ''}`;
  await event('verifier', allPassed ? `ALL PROGRAMS PROVEN: ${reason}` : `Run finished: ${reason}`);
  if (allPassed) {
    await db.setRunStatus(runId, 'shadow');
    await db.finishRun(runId, 'ready_for_cutover');
  } else {
    await db.finishRun(runId, 'failed');
  }
  return { runId, target: target.label, status: allPassed ? 'ready_for_cutover' : 'failed', programs, reason };
}
