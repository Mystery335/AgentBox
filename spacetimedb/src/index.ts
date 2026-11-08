// AgentProof SpacetimeDB module (database "legacy-data" on Maincloud).
// Data contract: .claude/shared-context-v2.md §6 (9 tables, 14 reducers).
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
} from 'spacetimedb/server';

// ---------------------------------------------------------------- enums
const RUN_STATUSES = [
  'analyzing',
  'translating',
  'verifying',
  'debugging',
  'shadow',
  'ready_for_cutover',
  'failed',
] as const;
const FINAL_RUN_STATUSES = ['ready_for_cutover', 'failed'] as const;
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

// Private: only reducers can read it.
const writer = table(
  { name: 'writer' },
  {
    identity_hex: t.string().primaryKey(),
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
  writer,
  },
  // Keep names exactly as written (the default SnakeCase policy could rename
  // when_/then_), so Python's HTTP calls and the dashboard see the same names.
  { CASE_CONVERSION_POLICY: CaseConversionPolicy.None }
);
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function requireWriter(ctx: Ctx): void {
  if (!ctx.db.writer.identity_hex.find(ctx.sender.toHexString())) {
    throw new SenderError('not a writer: register this identity with add_writer');
  }
}

/** Returns the run, or throws if it doesn't exist or has already finished. */
function openRun(ctx: Ctx, run_id: string) {
  const r = ctx.db.run.id.find(run_id);
  if (!r) throw new SenderError(`unknown run "${run_id}"`);
  if (r.finished_at !== undefined) throw new SenderError(`run "${run_id}" has already finished`);
  return r;
}

function checkAttempt(attempt: number): void {
  if (attempt > MAX_ATTEMPT) throw new SenderError(`attempt must be 0-${MAX_ATTEMPT}`);
}

// ------------------------------------------------------------ lifecycle
// The identity that publishes the module becomes the first writer.
export const init = spacetimedb.init(ctx => {
  ctx.db.writer.insert({ identity_hex: ctx.sender.toHexString() });
});

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
    const r = openRun(ctx, run_id);
    ctx.db.run.id.update({ ...r, status });
  }
);

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

// 8: open to any caller so the dashboard's Approve button works (§7.15).
export const update_rule_status = spacetimedb.reducer(
  { rule_id: t.string(), status: t.string() },
  (ctx, { rule_id, status }) => {
    oneOf('status', status, RULE_STATUSES);
    const r = ctx.db.rule.id.find(rule_id);
    if (!r) throw new SenderError(`unknown rule "${rule_id}"`);
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

// 13: allowed after a run finishes too, so closing messages still land.
export const log_event = spacetimedb.reducer(
  { event_id: t.string(), run_id: t.string(), agent: t.string(), message: t.string() },
  (ctx, { event_id, run_id, agent, message }) => {
    requireWriter(ctx);
    if (!ctx.db.run.id.find(run_id)) throw new SenderError(`unknown run "${run_id}"`);
    if (ctx.db.agent_event.id.find(event_id)) throw new SenderError(`event "${event_id}" already exists`);
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
    ctx.db.run.id.update({ ...r, status, finished_at: ctx.timestamp });
  }
);
