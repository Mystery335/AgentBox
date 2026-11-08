// Backend smoke test: proves the published module really stores data.
//
//   npm run identity   -> prints a worker identity + token (put the token in .env)
//   npm run smoke      -> calls all 16 reducers with a fresh run id, reads every
//                         table back with SQL, and checks the rows.
//
// It writes real rows (run ids start with "smoke-"). There are no delete
// reducers, so they stay; republish with -Wipe to clear them.

import { randomBytes } from 'node:crypto';
import { newIdentity, Stdb, StdbError } from './stdb.ts';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function expectReject(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, 'call was accepted');
  } catch (e) {
    check(name, e instanceof StdbError, e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
}

async function smoke(): Promise<number> {
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) {
    console.error('STDB_TOKEN is empty in AgentBox/.env. Run `npm run identity` first, then add_writer (see scripts/README.md).');
    return 2;
  }
  console.log(`target: ${db.host} / ${db.db}\n`);

  const id = `smoke-${Date.now()}`;
  const sha = randomBytes(32).toString('hex');

  // Writes ------------------------------------------------------------------
  await db.addProgram(sha, 'SMOKE', 'cobol', 'ibm', '       IDENTIFICATION DIVISION.\n');
  await db.startRun(id, 'SMOKE', 'cobol', 'python', sha, 'smoke-test', '42');
  await db.setRunStatus(id, 'translating');
  await db.setDocumentation(id, '# Smoke\nTest run.');
  await db.addCodeVersion(id, 0, 'print("hi")\n', 'abc', '');
  await db.addRule(`${id}:r-1`, id, 'Rounds half-up', 'an amount', 'it is rounded', 'half-up', 10, 12, 3, 4, 'keep');
  await db.updateRuleStatus(`${id}:r-1`, 'verified');
  await db.addTestCases(id, [
    { id: `${id}:tc-1`, test_index: 1, split: 'debug', kind: 'boundary', origin: 'generated', rule_id: `${id}:r-1`, input: 'A', legacy_output: 'a' },
    { id: `${id}:tc-2`, test_index: 2, split: 'holdout', kind: 'existing', origin: 'existing', rule_id: '', input: 'B', legacy_output: 'b' },
  ]);
  check('add_test_cases accepts an array of objects', true);
  await db.addTestResults(id, 0, [
    { test_case_id: `${id}:tc-1`, passed: true, modern_output: 'a' },
    { test_case_id: `${id}:tc-2`, passed: false, modern_output: 'X' },
  ]);
  await db.addChange(`${id}:chg-1`, id, 0, 'translator', '', 'Initial', 'first pass', '+print("hi")');
  await db.addDebugAttempt(`${id}:dbg-1`, id, 1, '1 failing', 'case', 'fix', 2, 2, 'fixed');
  await db.logEvent(`${id}:evt-1`, id, 'analyzer', 'smoke event');
  await db.setTargetLanguage(id, 'Java 21');
  await db.addAnalysis(id, 'component', 'src/a.cbl', { name: 'A', verifiable: false });
  await db.addAnalysis(id, 'component', 'src/a.cbl', { name: 'A', verifiable: true }); // same key: replaces
  await db.heartbeat(id);
  await expectReject('rejects skipping a stage (translating -> shadow)', () => db.setRunStatus(id, 'shadow'));
  await db.setRunStatus(id, 'verifying');
  await db.setRunStatus(id, 'shadow');
  await db.finishRun(id, 'ready_for_cutover');
  check('all reducers accepted (writer token works)', true);

  // Validation must reject bad input ---------------------------------------
  await expectReject('rejects an unknown status', () => db.setRunStatus(id, 'bogus'));
  await expectReject('rejects writes to a finished run', () => db.setRunStatus(id, 'debugging'));
  // log_event is deliberately allowed after finish_run, so closing messages still land.
  try {
    await db.logEvent(`${id}:evt-2`, id, 'x', 'late');
    check('allows log_event after the run finished', true);
  } catch (e) {
    check('allows log_event after the run finished', false, e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
  await expectReject('rejects a duplicate run id', () => db.startRun(id, 'SMOKE', 'cobol', 'python', sha, 'x', '1'));

  // Writer check: a fresh identity must be rejected -------------------------
  const stranger = await newIdentity(db.host);
  const anon = new Stdb({ token: stranger.token });
  await expectReject('rejects an identity that is not a writer', () => anon.logEvent(`${id}:evt-3`, id, 'x', 'y'));
  await expectReject('dashboard identity cannot un-verify a rule', () => anon.updateRuleStatus(`${id}:r-1`, 'pending'));
  try {
    await anon.updateRuleStatus(`${id}:r-1`, 'approved');
    check('dashboard identity can approve a verified rule', true);
  } catch (e) {
    check('dashboard identity can approve a verified rule', false, e instanceof Error ? e.message.slice(0, 120) : String(e));
  }
  const summary = (await db.sql(`SELECT * FROM run_summary WHERE run_id = '${id}'`))[0];
  check('run_summary view counts tests and rules', !!summary && Number(summary.tests_total) === 2 && Number(summary.rules_approved) === 1,
    JSON.stringify(summary ?? {}).slice(0, 160));

  // Read back ---------------------------------------------------------------
  const one = async (q: string) => (await db.sql(q))[0];
  const count = async (table: string, where: string) => (await db.sql(`SELECT * FROM ${table} WHERE ${where}`)).length;

  const run = await one(`SELECT * FROM run WHERE id = '${id}'`);
  check('run row stored', !!run && run.status === 'ready_for_cutover', `status=${run?.status}`);
  check('run.documentation stored', run?.documentation === '# Smoke\nTest run.');
  check('run.finished_at set by server', !!run && run.finished_at !== null && JSON.stringify(run.finished_at) !== '{"none":[]}',
    JSON.stringify(run?.finished_at)?.slice(0, 60));
  const prog = await one(`SELECT * FROM program WHERE sha256 = '${sha}'`);
  check('program row stored (with language)', prog?.language === 'cobol');
  check('code_version stored', (await count('code_version', `run_id = '${id}'`)) === 1);
  const rule = await one(`SELECT * FROM rule WHERE run_id = '${id}'`);
  check('rule stored, status updated', rule?.status === 'verified' && rule?.when_ === 'it is rounded',
    `status=${rule?.status}`);
  check('test_case rows stored', (await count('test_case', `run_id = '${id}'`)) === 2);
  const tc2 = await one(`SELECT * FROM test_case WHERE id = '${id}:tc-2'`);
  check('test_case.origin stored', tc2?.origin === 'existing');
  check('test_result rows stored', (await count('test_result', `run_id = '${id}'`)) === 2);
  const passed = await one(`SELECT * FROM test_result WHERE id = '${id}:tc-1:0'`);
  check('passing result drops modern_output', passed?.modern_output === '');
  check('change stored', (await count('change', `run_id = '${id}'`)) === 1);
  check('debug_attempt stored', (await count('debug_attempt', `run_id = '${id}'`)) === 1);
  check('run.target_language set', run?.target_language === 'Java 21', `target=${run?.target_language}`);
  const an = await db.sql(`SELECT * FROM analysis WHERE run_id = '${id}'`);
  check('analysis row stored and replaced on same key', an.length === 1 && JSON.parse(String(an[0].json)).verifiable === true, `rows=${an.length}`);
  check('agent_event stored (incl. late event)', (await count('agent_event', `run_id = '${id}'`)) === 2);

  try {
    await db.sql('SELECT * FROM writer');
    check('writer table is private', false, 'SQL could read it');
  } catch (e) {
    check('writer table is private', true, e instanceof Error ? e.message.slice(0, 80) : '');
  }

  const failed = checks.filter(c => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (run id ${id})`);
  return failed.length ? 1 : 0;
}

const mode = process.argv[2];
if (mode === 'identity') {
  const ident = await newIdentity();
  console.log(`identity: ${ident.identity}`);
  console.log(`STDB_TOKEN=${ident.token}`);
  console.log('\nPut the STDB_TOKEN line in AgentBox/.env, then register the identity as a writer:');
  console.log(`  spacetime call legacy-data --server maincloud add_writer '"${ident.identity}"'`);
} else {
  smoke()
    .then(code => process.exit(code))
    .catch(e => {
      console.error(`smoke test crashed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
