// AgentProof SpacetimeDB module (database "legacy-data" on Maincloud).
// Data contract: 10 public tables (incl. `analysis`) + private `writer`,
// 18 reducers (incl. delete_run, add_translation), 2 procedures (nemotron_ping, nemotron_chat).
//
// Field choice for the §7.12 conflict: the team's original plan fields, with the
// v2 additions on top (split, kind, rule_id, disposition, legacy_sha256,
// legacy_runtime, seed). Confirm at the H1 freeze.
//
// Every reducer except update_rule_status is writer-only (see `writer` table).
// Timestamps come from ctx.timestamp; callers never send them.

import {
  schema,
  table,
  t,
  SenderError,
  CaseConversionPolicy,
  type InferSchema,
  type ReducerCtx,
  type ProcedureCtx,
} from 'spacetimedb/server';
import { TimeDuration, ScheduleAt } from 'spacetimedb';

// ---------------------------------------------------------------- enums
const RUN_STATUSES = [
  'analyzing',
  'analyzed', // Analyzer done; waiting for the Translator (watchdog ignores it)
  'translating',
  'translated', // Translator done; waiting for the Verifier (watchdog ignores it)
  'verifying',
  'debugging',
  'shadow',
  'ready_for_cutover',
  'failed',
] as const;
const FINAL_RUN_STATUSES = ['ready_for_cutover', 'failed'] as const;
// Run state machine: the only status moves set_run_status / finish_run allow.
// Staying in the same status is always allowed (idempotent retries).
const NEXT_STATUS: Record<string, readonly string[]> = {
  analyzing: ['analyzed', 'translating', 'failed'],
  analyzed: ['translating', 'failed'],
  translating: ['translated', 'verifying', 'failed'],
  translated: ['translating', 'verifying', 'failed'],
  verifying: ['debugging', 'shadow', 'failed'],
  debugging: ['verifying', 'shadow', 'failed'],
  shadow: ['debugging', 'ready_for_cutover', 'failed'],
  ready_for_cutover: [],
  failed: [],
};
// Watchdog: a run with no writer activity for this long is marked failed.
// Longer than one Nemotron call (170 s) plus a Docker build, with headroom.
const STALL_MICROS = 15n * 60n * 1_000_000n;
// Statuses where the run is waiting on purpose, so no activity is expected.
const WAITING_STATUSES: readonly string[] = ['analyzed', 'translated'];
const WATCHDOG_EVERY_MICROS = 60n * 1_000_000n;
const RULE_STATUSES = ['pending', 'verified', 'fixed', 'unresolved', 'approved'] as const;
const DISPOSITIONS = ['keep', 'review', 'drop_candidate'] as const;
const SPLITS = ['debug', 'holdout', 'shadow'] as const;
const KINDS = ['boundary', 'random', 'regression', 'existing'] as const;
const ORIGINS = ['existing', 'generated'] as const;
const CHANGE_AGENTS = ['translator', 'debugger'] as const;
const OUTCOMES = ['fixed', 'still_failing', 'unresolved'] as const;
const MAX_ATTEMPT = 5;

function oneOf(field: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    throw new SenderError(`${field} must be one of ${allowed.join(', ')}; got "${value}"`);
  }
}

function nonEmpty(field: string, value: string): void {
  if (value.trim() === '') throw new SenderError(`${field} must not be empty`);
}

// --------------------------------------------------------------- tables
const program = table(
  { name: 'program', public: true },
  {
    sha256: t.string().primaryKey(), // sha256 of the uploaded legacy zip
    name: t.string(),
    language: t.string(), // detected by the Analyzer, e.g. "cobol", "asm-x86"
    dialect: t.string(),
    source: t.string(), // main source text (or a file manifest for multi-file systems)
    uploaded_at: t.timestamp(),
  }
);

const run = table(
  { name: 'run', public: true },
  {
    id: t.string().primaryKey(),
    legacy_name: t.string(),
    legacy_language: t.string(),
    target_language: t.string(),
    status: t.string(),
    documentation: t.string(),
    legacy_sha256: t.string(),
    legacy_runtime: t.string(),
    seed: t.string(),
    started_at: t.timestamp(),
    finished_at: t.option(t.timestamp()),
  }
);

const code_version = table(
  { name: 'code_version', public: true },
  {
    id: t.string().primaryKey(), // `${run_id}:${attempt}`
    run_id: t.string().index('btree'),
    attempt: t.u32(), // 0 = Translator, 1-5 = Debugger
    source: t.string(),
    sha256: t.string(),
    lint: t.string(),
    created_at: t.timestamp(),
  }
);

const rule = table(
  { name: 'rule', public: true },
  {
    id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    title: t.string(),
    given: t.string(),
    when_: t.string(),
    then_: t.string(),
    legacy_start_line: t.u32(),
    legacy_end_line: t.u32(),
    modern_start_line: t.u32(),
    modern_end_line: t.u32(),
    status: t.string(),
    disposition: t.string(),
  }
);

const test_case = table(
  { name: 'test_case', public: true },
  {
    id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    test_index: t.u32(),
    split: t.string(),
    kind: t.string(),
    origin: t.string(), // "existing" (the legacy system's own test) or "generated"
    rule_id: t.string(), // "" if none
    input: t.string(),
    legacy_output: t.string(),
  }
);

const test_result = table(
  { name: 'test_result', public: true },
  {
    id: t.string().primaryKey(), // `${test_case_id}:${attempt}`
    run_id: t.string().index('btree'),
    test_case_id: t.string(),
    attempt: t.u32(),
    passed: t.bool(),
    modern_output: t.string(), // "" when passed
  }
);

const change = table(
  { name: 'change', public: true },
  {
    id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    attempt: t.u32(),
    agent: t.string(),
    rule_id: t.string(),
    summary: t.string(),
    reason: t.string(),
    diff: t.string(),
    created_at: t.timestamp(),
  }
);

const debug_attempt = table(
  { name: 'debug_attempt', public: true },
  {
    id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    attempt: t.u32(),
    error_summary: t.string(),
    diagnosis: t.string(),
    fix_summary: t.string(),
    passed_count: t.u32(),
    total_count: t.u32(),
    outcome: t.string(),
    created_at: t.timestamp(),
  }
);

const agent_event = table(
  { name: 'agent_event', public: true },
  {
    id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    agent: t.string(),
    message: t.string(),
    created_at: t.timestamp(),
  }
);

// Analyzer output, one row per artifact. `kind` says what `json` holds:
//   system     - overview, recommended target language + reasons, first slice
//   inventory  - every file with its kind and language
//   component  - one source program/module: facts, compile result,
//                verifiable/deferred + reasons, summary, rule ids, layouts
//   runtime    - how the legacy image was built (Dockerfile, toolchain)
// `key` is "" for system/inventory/runtime and the file path for component.
const analysis = table(
  { name: 'analysis', public: true },
  {
    id: t.string().primaryKey(), // `${run_id}:${kind}:${key}`
    run_id: t.string().index('btree'),
    kind: t.string(),
    key: t.string(),
    json: t.string(),
    created_at: t.timestamp(),
  }
);

// Translator output: one row per translated program (or the shared records
// module) per attempt. attempt 0 = Translator, 1-5 = Debugger.
const translation = table(
  { name: 'translation', public: true },
  {
    id: t.string().primaryKey(), // `${run_id}:${component}:${attempt}`
    run_id: t.string().index('btree'),
    component: t.string(), // legacy path, or "(shared)/records" for the shared module
    name: t.string(), // program name, e.g. INTEREST
    attempt: t.u32(),
    language: t.string(), // target language, e.g. "Python 3.12"
    file_name: t.string(), // e.g. "interest.py"
    source: t.string(),
    sha256: t.string(),
    check_status: t.string(), // ok | failed | unavailable
    check_output: t.string(),
    rule_map: t.string(), // JSON: [{ rule_id, function }]
    notes: t.string(),
    created_at: t.timestamp(),
  }
);

// Private: only reducers can read it.
const writer = table(
  { name: 'writer' },
  {
    identity_hex: t.string().primaryKey(),
  }
);

// Last writer activity per open run (every writer reducer touches it, plus
// the `heartbeat` reducer during long Docker steps). Read by the watchdog.
// Separate table so adding it is not a breaking change to `run`.
const run_heartbeat = table(
  { name: 'run_heartbeat', public: true },
  {
    run_id: t.string().primaryKey(),
    last_seen: t.timestamp(),
  }
);

// Which writer (worker) identities are connected right now. Filled by the
// client_connected / client_disconnected lifecycle reducers.
const worker_presence = table(
  { name: 'worker_presence', public: true },
  {
    identity_hex: t.string().primaryKey(),
    online: t.bool(),
    since: t.timestamp(),
  }
);

// Private schedule table: one row, fires `watchdog` every minute.
const watchdog_schedule = table(
  { name: 'watchdog_schedule' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

const spacetimedb = schema(
  {
  program,
  run,
  code_version,
  rule,
  test_case,
  test_result,
  change,
  debug_attempt,
  agent_event,
  analysis,
  translation,
  writer,
  run_heartbeat,
  worker_presence,
  watchdog_schedule,
  },
  {
    // Keep names exactly as written (the default SnakeCase policy could rename
    // when_/then_), so the worker's HTTP calls and the dashboard see the same names.
    CASE_CONVERSION_POLICY: CaseConversionPolicy.None,
    // Set on spacetimedb.com (database -> Environment) or with
    // `spacetime publish --env-only`. Values are never built into the module.
    // Optional so the module still publishes before the key is set; the
    // Nemotron procedures fail with a clear message until it is.
    env: {
      NVIDIA_API_KEY: t.option(t.string()),
      NEMOTRON_MODEL: t.option(t.string()),
    },
  }
);
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function isWriter(ctx: Ctx): boolean {
  return !!ctx.db.writer.identity_hex.find(ctx.sender.toHexString());
}

function requireWriter(ctx: Ctx): void {
  if (!isWriter(ctx)) {
    throw new SenderError('not a writer: register this identity with add_writer');
  }
}

/** Records writer activity on a run, for the watchdog. */
function touch(ctx: Ctx, run_id: string): void {
  const hb = ctx.db.run_heartbeat.run_id.find(run_id);
  if (hb) ctx.db.run_heartbeat.run_id.update({ run_id, last_seen: ctx.timestamp });
  else ctx.db.run_heartbeat.insert({ run_id, last_seen: ctx.timestamp });
}

/** Returns the run, or throws if it doesn't exist or has already finished. Counts as activity. */
function openRun(ctx: Ctx, run_id: string) {
  const r = ctx.db.run.id.find(run_id);
  if (!r) throw new SenderError(`unknown run "${run_id}"`);
  if (r.finished_at !== undefined) throw new SenderError(`run "${run_id}" has already finished`);
  touch(ctx, run_id);
  return r;
}

function checkTransition(from: string, to: string): void {
  if (from === to) return;
  if (!(NEXT_STATUS[from] ?? []).includes(to)) {
    throw new SenderError(`run status cannot go from "${from}" to "${to}"`);
  }
}

/** Makes sure the watchdog schedule row exists (init only runs on the first publish). */
function ensureWatchdog(ctx: Ctx): void {
  if (ctx.db.watchdog_schedule.count() > 0n) return;
  ctx.db.watchdog_schedule.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(WATCHDOG_EVERY_MICROS) });
}

function checkAttempt(attempt: number): void {
  if (attempt > MAX_ATTEMPT) throw new SenderError(`attempt must be 0-${MAX_ATTEMPT}`);
}

// ------------------------------------------------------------ lifecycle
// The identity that publishes the module becomes the first writer.
export const init = spacetimedb.init(ctx => {
  ctx.db.writer.insert({ identity_hex: ctx.sender.toHexString() });
  ensureWatchdog(ctx);
});

// Presence is tracked for writers only, so dashboard visitors leave no rows.
function setPresence(ctx: Ctx, online: boolean): void {
  if (!isWriter(ctx)) return;
  const identity_hex = ctx.sender.toHexString();
  const row = { identity_hex, online, since: ctx.timestamp };
  if (ctx.db.worker_presence.identity_hex.find(identity_hex)) ctx.db.worker_presence.identity_hex.update(row);
  else ctx.db.worker_presence.insert(row);
}

export const client_connected = spacetimedb.clientConnected(ctx => setPresence(ctx, true));
export const client_disconnected = spacetimedb.clientDisconnected(ctx => setPresence(ctx, false));

// Scheduled every minute. Fails any open run with no writer activity for
// STALL_MICROS, so a crashed worker never leaves a run "running" forever.
export const watchdog = spacetimedb.reducer(
  { onSchedule: watchdog_schedule },
  { arg: watchdog_schedule.rowType },
  ctx => {
    // Only the scheduler (the database's own identity) may run this.
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('watchdog is internal');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const r of ctx.db.run.iter()) {
      if (r.finished_at !== undefined || WAITING_STATUSES.includes(r.status)) continue;
      const hb = ctx.db.run_heartbeat.run_id.find(r.id);
      const last = (hb ? hb.last_seen : r.started_at).microsSinceUnixEpoch;
      if (now - last < STALL_MICROS) continue;
      ctx.db.run.id.update({ ...r, status: 'failed', finished_at: ctx.timestamp });
      ctx.db.agent_event.insert({
        id: `${r.id}:watchdog:${now}`,
        run_id: r.id,
        agent: 'system',
        message: `Run timed out: no worker activity for ${STALL_MICROS / 60_000_000n} minutes while "${r.status}".`,
        created_at: ctx.timestamp,
      });
    }
  }
);

// ------------------------------------------------------------- reducers
// 1
export const add_writer = spacetimedb.reducer({ identity_hex: t.string() }, (ctx, { identity_hex }) => {
  requireWriter(ctx);
  const hex = identity_hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new SenderError('identity_hex must be 64 hex characters');
  if (!ctx.db.writer.identity_hex.find(hex)) ctx.db.writer.insert({ identity_hex: hex });
});

// 2: does nothing if the same source is already stored.
export const add_program = spacetimedb.reducer(
  { sha256: t.string(), name: t.string(), language: t.string(), dialect: t.string(), source: t.string() },
  (ctx, { sha256, name, language, dialect, source }) => {
    requireWriter(ctx);
    nonEmpty('sha256', sha256);
    nonEmpty('source', source);
    if (ctx.db.program.sha256.find(sha256)) return;
    ctx.db.program.insert({ sha256, name, language, dialect, source, uploaded_at: ctx.timestamp });
  }
);

// 3
export const start_run = spacetimedb.reducer(
  {
    run_id: t.string(),
    legacy_name: t.string(),
    legacy_language: t.string(),
    target_language: t.string(),
    legacy_sha256: t.string(),
    legacy_runtime: t.string(),
    seed: t.string(),
  },
  (ctx, a) => {
    requireWriter(ctx);
    nonEmpty('run_id', a.run_id);
    if (ctx.db.run.id.find(a.run_id)) throw new SenderError(`run "${a.run_id}" already exists`);
    if (!ctx.db.program.sha256.find(a.legacy_sha256)) {
      throw new SenderError(`no program with sha256 ${a.legacy_sha256}; call add_program first`);
    }
    ensureWatchdog(ctx);
    touch(ctx, a.run_id);
    ctx.db.run.insert({
      id: a.run_id,
      legacy_name: a.legacy_name,
      legacy_language: a.legacy_language,
      target_language: a.target_language,
      status: 'analyzing',
      documentation: '',
      legacy_sha256: a.legacy_sha256,
      legacy_runtime: a.legacy_runtime,
      seed: a.seed,
      started_at: ctx.timestamp,
      finished_at: undefined,
    });
  }
);

// 4
export const set_run_status = spacetimedb.reducer(
  { run_id: t.string(), status: t.string() },
  (ctx, { run_id, status }) => {
    requireWriter(ctx);
    oneOf('status', status, RUN_STATUSES);
    if ((FINAL_RUN_STATUSES as readonly string[]).includes(status)) {
      throw new SenderError(`use finish_run to set "${status}"`);
    }
    const r = openRun(ctx, run_id);
    checkTransition(r.status, status);
    ctx.db.run.id.update({ ...r, status });
  }
);

// Keeps a run alive for the watchdog during long steps (Docker builds, test batches).
export const heartbeat = spacetimedb.reducer({ run_id: t.string() }, (ctx, { run_id }) => {
  requireWriter(ctx);
  openRun(ctx, run_id);
});

// 5
export const set_documentation = spacetimedb.reducer(
  { run_id: t.string(), documentation: t.string() },
  (ctx, { run_id, documentation }) => {
    requireWriter(ctx);
    const r = openRun(ctx, run_id);
    ctx.db.run.id.update({ ...r, documentation });
  }
);

// 6
export const add_code_version = spacetimedb.reducer(
  { run_id: t.string(), attempt: t.u32(), source: t.string(), sha256: t.string(), lint: t.string() },
  (ctx, { run_id, attempt, source, sha256, lint }) => {
    requireWriter(ctx);
    openRun(ctx, run_id);
    checkAttempt(attempt);
    const id = `${run_id}:${attempt}`;
    if (ctx.db.code_version.id.find(id)) throw new SenderError(`code version ${id} already exists`);
    ctx.db.code_version.insert({ id, run_id, attempt, source, sha256, lint, created_at: ctx.timestamp });
  }
);

// 7
export const add_rule = spacetimedb.reducer(
  {
    rule_id: t.string(),
    run_id: t.string(),
    title: t.string(),
    given: t.string(),
    when_: t.string(),
    then_: t.string(),
    legacy_start_line: t.u32(),
    legacy_end_line: t.u32(),
    modern_start_line: t.u32(),
    modern_end_line: t.u32(),
    disposition: t.string(),
  },
  (ctx, a) => {
    requireWriter(ctx);
    openRun(ctx, a.run_id);
    oneOf('disposition', a.disposition, DISPOSITIONS);
    if (ctx.db.rule.id.find(a.rule_id)) throw new SenderError(`rule "${a.rule_id}" already exists`);
    const { rule_id, ...rest } = a;
    ctx.db.rule.insert({ id: rule_id, ...rest, status: 'pending' });
  }
);

// 8: writers may set any status. Anyone else (the dashboard's Approve button,
// §7.15) may only approve, and only a rule the agents have already checked.
const APPROVABLE = ['verified', 'fixed', 'unresolved'];
export const update_rule_status = spacetimedb.reducer(
  { rule_id: t.string(), status: t.string() },
  (ctx, { rule_id, status }) => {
    oneOf('status', status, RULE_STATUSES);
    const r = ctx.db.rule.id.find(rule_id);
    if (!r) throw new SenderError(`unknown rule "${rule_id}"`);
    if (!isWriter(ctx)) {
      if (status !== 'approved') throw new SenderError('the dashboard can only approve rules');
      if (!APPROVABLE.includes(r.status)) {
        throw new SenderError(`rule "${rule_id}" is "${r.status}"; only ${APPROVABLE.join(', ')} rules can be approved`);
      }
    }
    ctx.db.rule.id.update({ ...r, status });
  }
);

// 9: one call per batch (debug + holdout, then shadow).
const TestCaseInput = t.object('TestCaseInput', {
  id: t.string(),
  test_index: t.u32(),
  split: t.string(),
  kind: t.string(),
  origin: t.string(),
  rule_id: t.string(),
  input: t.string(),
  legacy_output: t.string(),
});

export const add_test_cases = spacetimedb.reducer(
  { run_id: t.string(), cases: t.array(TestCaseInput) },
  (ctx, { run_id, cases }) => {
    requireWriter(ctx);
    openRun(ctx, run_id);
    for (const c of cases) {
      oneOf('split', c.split, SPLITS);
      oneOf('kind', c.kind, KINDS);
      oneOf('origin', c.origin, ORIGINS);
      if (ctx.db.test_case.id.find(c.id)) throw new SenderError(`test case "${c.id}" already exists`);
      ctx.db.test_case.insert({ ...c, run_id });
    }
  }
);

// 10: one call per attempt.
const TestResultInput = t.object('TestResultInput', {
  test_case_id: t.string(),
  passed: t.bool(),
  modern_output: t.string(),
});

export const add_test_results = spacetimedb.reducer(
  { run_id: t.string(), attempt: t.u32(), results: t.array(TestResultInput) },
  (ctx, { run_id, attempt, results }) => {
    requireWriter(ctx);
    openRun(ctx, run_id);
    checkAttempt(attempt);
    for (const r of results) {
      const tc = ctx.db.test_case.id.find(r.test_case_id);
      if (!tc || tc.run_id !== run_id) {
        throw new SenderError(`test case "${r.test_case_id}" is not part of run "${run_id}"`);
      }
      const id = `${r.test_case_id}:${attempt}`;
      if (ctx.db.test_result.id.find(id)) throw new SenderError(`test result ${id} already exists`);
      ctx.db.test_result.insert({
        id,
        run_id,
        test_case_id: r.test_case_id,
        attempt,
        passed: r.passed,
        modern_output: r.passed ? '' : r.modern_output,
      });
    }
  }
);

// 11
export const add_change = spacetimedb.reducer(
  {
    change_id: t.string(),
    run_id: t.string(),
    attempt: t.u32(),
    agent: t.string(),
    rule_id: t.string(),
    summary: t.string(),
    reason: t.string(),
    diff: t.string(),
  },
  (ctx, a) => {
    requireWriter(ctx);
    openRun(ctx, a.run_id);
    checkAttempt(a.attempt);
    oneOf('agent', a.agent, CHANGE_AGENTS);
    if (ctx.db.change.id.find(a.change_id)) throw new SenderError(`change "${a.change_id}" already exists`);
    const { change_id, ...rest } = a;
    ctx.db.change.insert({ id: change_id, ...rest, created_at: ctx.timestamp });
  }
);

// 12
export const add_debug_attempt = spacetimedb.reducer(
  {
    debug_attempt_id: t.string(),
    run_id: t.string(),
    attempt: t.u32(),
    error_summary: t.string(),
    diagnosis: t.string(),
    fix_summary: t.string(),
    passed_count: t.u32(),
    total_count: t.u32(),
    outcome: t.string(),
  },
  (ctx, a) => {
    requireWriter(ctx);
    openRun(ctx, a.run_id);
    if (a.attempt < 1) throw new SenderError('debug attempts start at 1');
    checkAttempt(a.attempt);
    oneOf('outcome', a.outcome, OUTCOMES);
    if (a.passed_count > a.total_count) throw new SenderError('passed_count is larger than total_count');
    if (ctx.db.debug_attempt.id.find(a.debug_attempt_id)) {
      throw new SenderError(`debug attempt "${a.debug_attempt_id}" already exists`);
    }
    const { debug_attempt_id, ...rest } = a;
    ctx.db.debug_attempt.insert({ id: debug_attempt_id, ...rest, created_at: ctx.timestamp });
  }
);

// 15: Analyzer output. Re-sending the same kind+key replaces the row, so a
// re-run of one analysis step doesn't fail.
const ANALYSIS_KINDS = ['system', 'inventory', 'component', 'runtime', 'verification'] as const;
export const add_analysis = spacetimedb.reducer(
  { run_id: t.string(), kind: t.string(), key: t.string(), json: t.string() },
  (ctx, { run_id, kind, key, json }) => {
    requireWriter(ctx);
    openRun(ctx, run_id);
    oneOf('kind', kind, ANALYSIS_KINDS);
    try {
      JSON.parse(json);
    } catch {
      throw new SenderError('json must be valid JSON');
    }
    const id = `${run_id}:${kind}:${key}`;
    const row = { id, run_id, kind, key, json, created_at: ctx.timestamp };
    if (ctx.db.analysis.id.find(id)) ctx.db.analysis.id.update(row);
    else ctx.db.analysis.insert(row);
  }
);

// 16: the Analyzer decides the target language after start_run.
// The Translator records where each rule lives in the modern code.
export const set_rule_modern_lines = spacetimedb.reducer(
  { rule_id: t.string(), modern_start_line: t.u32(), modern_end_line: t.u32() },
  (ctx, { rule_id, modern_start_line, modern_end_line }) => {
    requireWriter(ctx);
    const r = ctx.db.rule.id.find(rule_id);
    if (!r) throw new SenderError(`unknown rule "${rule_id}"`);
    openRun(ctx, r.run_id);
    if (modern_end_line < modern_start_line) throw new SenderError('modern_end_line is before modern_start_line');
    ctx.db.rule.id.update({ ...r, modern_start_line, modern_end_line });
  }
);

export const set_target_language = spacetimedb.reducer(
  { run_id: t.string(), target_language: t.string() },
  (ctx, { run_id, target_language }) => {
    requireWriter(ctx);
    nonEmpty('target_language', target_language);
    const r = openRun(ctx, run_id);
    ctx.db.run.id.update({ ...r, target_language });
  }
);

// 18: Translator output. Same id again replaces the row (re-runs don't fail).
const CHECK_STATUSES = ['ok', 'failed', 'unavailable'] as const;
export const add_translation = spacetimedb.reducer(
  {
    run_id: t.string(),
    component: t.string(),
    name: t.string(),
    attempt: t.u32(),
    language: t.string(),
    file_name: t.string(),
    source: t.string(),
    sha256: t.string(),
    check_status: t.string(),
    check_output: t.string(),
    rule_map: t.string(),
    notes: t.string(),
  },
  (ctx, a) => {
    requireWriter(ctx);
    openRun(ctx, a.run_id);
    checkAttempt(a.attempt);
    nonEmpty('component', a.component);
    nonEmpty('file_name', a.file_name);
    oneOf('check_status', a.check_status, CHECK_STATUSES);
    try {
      JSON.parse(a.rule_map);
    } catch {
      throw new SenderError('rule_map must be valid JSON');
    }
    const id = `${a.run_id}:${a.component}:${a.attempt}`;
    const row = { id, ...a, created_at: ctx.timestamp };
    if (ctx.db.translation.id.find(id)) ctx.db.translation.id.update(row);
    else ctx.db.translation.insert(row);
  }
);

// 17: permanently deletes one run and every row that belongs to it, plus its
// program row when no other run uses that program. Writer-only. Works on
// finished and unfinished runs.
export const delete_run = spacetimedb.reducer({ run_id: t.string() }, (ctx, { run_id }) => {
  requireWriter(ctx);
  const r = ctx.db.run.id.find(run_id);
  if (!r) throw new SenderError(`unknown run "${run_id}"`);
  ctx.db.analysis.run_id.delete(run_id);
  ctx.db.rule.run_id.delete(run_id);
  ctx.db.agent_event.run_id.delete(run_id);
  ctx.db.test_case.run_id.delete(run_id);
  ctx.db.test_result.run_id.delete(run_id);
  ctx.db.code_version.run_id.delete(run_id);
  ctx.db.change.run_id.delete(run_id);
  ctx.db.debug_attempt.run_id.delete(run_id);
  ctx.db.translation.run_id.delete(run_id);
  ctx.db.run_heartbeat.run_id.delete(run_id);
  ctx.db.run.id.delete(run_id);
  let shared = false;
  for (const other of ctx.db.run.iter()) {
    if (other.legacy_sha256 === r.legacy_sha256) {
      shared = true;
      break;
    }
  }
  if (!shared) ctx.db.program.sha256.delete(r.legacy_sha256);
});

// 13: allowed after a run finishes too, so closing messages still land.
export const log_event = spacetimedb.reducer(
  { event_id: t.string(), run_id: t.string(), agent: t.string(), message: t.string() },
  (ctx, { event_id, run_id, agent, message }) => {
    requireWriter(ctx);
    const r = ctx.db.run.id.find(run_id);
    if (!r) throw new SenderError(`unknown run "${run_id}"`);
    if (ctx.db.agent_event.id.find(event_id)) throw new SenderError(`event "${event_id}" already exists`);
    if (r.finished_at === undefined) touch(ctx, run_id);
    ctx.db.agent_event.insert({ id: event_id, run_id, agent, message, created_at: ctx.timestamp });
  }
);

// 14
export const finish_run = spacetimedb.reducer(
  { run_id: t.string(), status: t.string() },
  (ctx, { run_id, status }) => {
    requireWriter(ctx);
    oneOf('status', status, FINAL_RUN_STATUSES);
    const r = openRun(ctx, run_id);
    checkTransition(r.status, status);
    ctx.db.run.id.update({ ...r, status, finished_at: ctx.timestamp });
    ctx.db.run_heartbeat.run_id.delete(run_id);
  }
);

// --------------------------------------------------------------- views
// One row per run with the numbers the dashboard header needs, computed on
// the server and pushed to subscribers whenever an underlying row changes.
// "Latest attempt" is the highest attempt with test results.
const RunSummary = t.row('RunSummaryRow', {
  run_id: t.string().primaryKey(),
  status: t.string(),
  target_language: t.string(),
  latest_attempt: t.u32(),
  tests_total: t.u32(),
  tests_passed: t.u32(), // in the latest attempt, all splits
  holdout_total: t.u32(),
  holdout_passed: t.u32(),
  existing_tests: t.u32(), // the legacy system's own tests
  rules_total: t.u32(),
  rules_verified: t.u32(), // verified + fixed + approved
  rules_approved: t.u32(),
  rules_unresolved: t.u32(),
  debug_attempts: t.u32(),
  events: t.u32(),
  last_activity: t.option(t.timestamp()),
});

export const run_summary = spacetimedb.anonymousView({ name: 'run_summary', public: true }, t.array(RunSummary), ctx => {
  const out = [];
  for (const r of ctx.db.run.iter()) {
    const cases = [...ctx.db.test_case.run_id.filter(r.id)];
    const split = new Map(cases.map(c => [c.id, c.split]));
    const results = [...ctx.db.test_result.run_id.filter(r.id)];
    const latest = results.reduce((m, x) => Math.max(m, x.attempt), 0);
    const now = results.filter(x => x.attempt === latest);
    const holdout = now.filter(x => split.get(x.test_case_id) === 'holdout');
    const rules = [...ctx.db.rule.run_id.filter(r.id)];
    const hb = ctx.db.run_heartbeat.run_id.find(r.id);
    out.push({
      run_id: r.id,
      status: r.status,
      target_language: r.target_language,
      latest_attempt: latest,
      tests_total: cases.length,
      tests_passed: now.filter(x => x.passed).length,
      holdout_total: cases.filter(c => c.split === 'holdout').length,
      holdout_passed: holdout.filter(x => x.passed).length,
      existing_tests: cases.filter(c => c.origin === 'existing').length,
      rules_total: rules.length,
      rules_verified: rules.filter(x => ['verified', 'fixed', 'approved'].includes(x.status)).length,
      rules_approved: rules.filter(x => x.status === 'approved').length,
      rules_unresolved: rules.filter(x => x.status === 'unresolved').length,
      debug_attempts: [...ctx.db.debug_attempt.run_id.filter(r.id)].length,
      events: [...ctx.db.agent_event.run_id.filter(r.id)].length,
      last_activity: hb ? hb.last_seen : r.finished_at,
    });
  }
  return out;
});

// ------------------------------------------------------------ Nemotron
// Procedures (not reducers) because they make HTTP calls. The API key lives
// only in the database's environment (ctx.env); it is never returned, logged
// or stored in a table. Both procedures are writer-only so nobody else can
// spend the key's quota.
const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
// Maincloud allows procedures at most 180 s; leave headroom.
const NEMOTRON_TIMEOUT = TimeDuration.fromMillis(170_000);

type PCtx = ProcedureCtx<InferSchema<typeof spacetimedb>>;

function requireWriterProc(ctx: PCtx): void {
  const hex = ctx.sender.toHexString();
  const ok = ctx.withTx(tx => !!tx.db.writer.identity_hex.find(hex));
  if (!ok) throw new SenderError('not a writer: register this identity with add_writer');
}

/** Sends one chat-completions request. Returns { status, body } with the key scrubbed from the body. */
function postNemotron(ctx: PCtx, request: Record<string, unknown>): { status: number; body: string; model: string } {
  const key = ctx.env.NVIDIA_API_KEY;
  if (!key) throw new SenderError('NVIDIA_API_KEY is not set in the database environment');
  const model = typeof request.model === 'string' && request.model ? request.model : ctx.env.NEMOTRON_MODEL || DEFAULT_MODEL;
  const res = ctx.http.fetch(NVIDIA_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...request, model, stream: false }),
    timeout: NEMOTRON_TIMEOUT,
  });
  return { status: res.status, body: res.text().split(key).join('[redacted]'), model };
}

/** Health check: proves the key is set and accepted. Returns status only, never the key. */
export const nemotron_ping = spacetimedb.procedure(t.string(), ctx => {
  requireWriterProc(ctx);
  const r = postNemotron(ctx, {
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    max_tokens: 16,
    temperature: 0,
    // Nemotron 3.5 is a reasoning model; thinking tokens count against
    // max_tokens, so turn it off for this tiny check.
    chat_template_kwargs: { enable_thinking: false },
  });
  let reply = '';
  if (r.status === 200) {
    try {
      reply = String(JSON.parse(r.body).choices?.[0]?.message?.content ?? '').slice(0, 100);
    } catch {
      reply = '(unparseable response)';
    }
  }
  return JSON.stringify({ ok: r.status === 200, status: r.status, model: r.model, reply, error: r.status === 200 ? '' : r.body.slice(0, 300) });
});

/**
 * Chat completion for the agents. `request_json` is an OpenAI-style request
 * body (messages, tools, temperature, max_tokens, ...); `model` defaults to
 * NEMOTRON_MODEL or nemotron-3.5-lightning. Returns NVIDIA's response JSON.
 * The model reasons before answering (message.reasoning_content) and those
 * tokens count against max_tokens: give it room (2000+), or pass
 * chat_template_kwargs: { enable_thinking: false } for quick calls.
 */
export const nemotron_chat = spacetimedb.procedure({ request_json: t.string() }, t.string(), (ctx, { request_json }) => {
  requireWriterProc(ctx);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(request_json);
  } catch {
    throw new SenderError('request_json is not valid JSON');
  }
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
    throw new SenderError('request_json must be an object with a messages array');
  }
  const r = postNemotron(ctx, request);
  if (r.status !== 200) throw new SenderError(`Nemotron returned HTTP ${r.status}: ${r.body.slice(0, 500)}`);
  return r.body;
});
