import { useState } from 'react';
import { useRunDebugAttempts, useRunTestCases, useRunTestResults } from './stdb';
import './LiveValidation.css';

export default function LiveValidation({ runId }: { runId: string }) {
  const [cases, casesReady] = useRunTestCases(runId);
  const [results, resultsReady] = useRunTestResults(runId);
  const [repairs, repairsReady] = useRunDebugAttempts(runId);
  const [chosenAttempt, setChosenAttempt] = useState<number>();
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const attempts = [...new Set([...results.map(row => row.attempt), ...repairs.map(row => row.attempt)])].sort((a, b) => b - a);
  const attempt = chosenAttempt ?? attempts[0];
  const attemptResults = new Map(results.filter(row => row.attempt === attempt).map(row => [row.testCaseId, row]));
  const rows = [...cases].sort((a, b) => a.testIndex - b.testIndex).map(test => ({ test, result: attemptResults.get(test.id) }));
  const passed = rows.filter(row => row.result?.passed).length;
  const failed = rows.filter(row => row.result && !row.result.passed).length;
  const pending = rows.length - passed - failed;
  const visible = rows.filter(row => filter === 'all' || (filter === 'passed' ? row.result?.passed : filter === 'failed' ? row.result && !row.result.passed : !row.result));
  const selected = visible.find(row => row.test.id === selectedId) ?? visible[0];
  const selectedRepair = repairs.find(row => row.attempt === attempt);

  if (!casesReady || !resultsReady || !repairsReady) return <div className="la-empty" role="status">Loading recorded validation evidence…</div>;
  return <>
    <div className="la-toolbar"><label>Attempt<select value={attempt ?? ''} disabled={!attempts.length} onChange={event => setChosenAttempt(Number(event.target.value))}>{!attempts.length && <option value="">No attempts recorded</option>}{attempts.map(value => <option key={value} value={value}>{value === 0 ? '0 · Initial translation' : `${value} · Repair attempt`}{value === attempts[0] ? ' · Latest' : ''}</option>)}</select></label><label>Test status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All tests</option><option value="failed">Failed</option><option value="passed">Passed</option><option value="pending">Not run</option></select></label><a className="lv-activity" href={`#/workspace/activity?run=${encodeURIComponent(runId)}`}>View this run’s agent activity →</a></div>
    <div className="lv-counts" aria-label="Selected attempt results">{[[passed, 'Passed'], [failed, 'Failed'], [pending, 'Not run'], [cases.length, 'Recorded cases']].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <p className="la-detail-note">Results apply to the selected attempt and recorded inputs only. Expected output is the legacy program’s recorded output, including the normalized exit code. Matching these cases does not establish full system equivalence.</p>
    {!cases.length ? <div className="la-empty">No test cases recorded for this run yet. Check Agent activity for its progress or errors.</div> : <div className="la-panels"><section className="la-timeline"><div className="la-panel-title"><h2>Test cases</h2><span>{visible.length} / {cases.length}</span></div><ol className="lv-tests">{visible.map(({test, result}) => <li key={test.id}><button onClick={() => setSelectedId(test.id)} aria-pressed={selected?.test.id === test.id} className={selected?.test.id === test.id ? 'selected' : ''}><span><strong>Case {test.testIndex}</strong><b className={result ? result.passed ? 'lv-pass' : 'lv-fail' : ''}>{result ? result.passed ? 'Passed' : 'Failed' : 'Not run'}</b></span><p>{test.ruleId || 'No linked rule'} · {test.split} · {test.kind}</p><p>{test.input || '(empty input)'}</p></button></li>)}</ol>{!visible.length && <p className="la-empty">No tests match this filter.</p>}</section><section className="la-inspector lv-evidence"><h2>Input and output evidence</h2>{selected ? <><dl><dt>Test case</dt><dd>{selected.test.id}</dd><dt>Origin / split</dt><dd>{selected.test.origin} / {selected.test.split}</dd><dt>Linked rule</dt><dd>{selected.test.ruleId || 'Not recorded'}</dd></dl><h3>Input</h3><pre>{selected.test.input || '(empty input)'}</pre><h3>Expected · legacy output</h3><pre>{selected.test.legacyOutput || '(empty output)'}</pre><h3>Actual · modern output</h3><pre>{selected.result ? (selected.result.passed ? selected.test.legacyOutput : selected.result.modernOutput) || '(empty output)' : 'No result recorded for this attempt.'}</pre></> : <p>Select a test to inspect its evidence.</p>}</section></div>}
    <section className="la-timeline lv-repairs"><div className="la-panel-title"><h2>Repair history</h2><span>{repairs.length} recorded repairs</span></div><p className="la-detail-note">Attempt 0 is the initial translation. A repair record describes a debugger change and its subsequent test result.</p>{selectedRepair && <p>Selected attempt: {selectedRepair.passedCount} / {selectedRepair.totalCount} passed · {selectedRepair.outcome.replaceAll('_', ' ')}</p>}{[...repairs].sort((a,b) => b.attempt - a.attempt).map(repair => <details key={repair.id}><summary>Attempt {repair.attempt} · {repair.outcome.replaceAll('_', ' ')} · {repair.passedCount}/{repair.totalCount} passed</summary><h3>Error summary</h3><pre>{repair.errorSummary || 'Not recorded'}</pre><h3>Diagnosis</h3><pre>{repair.diagnosis || 'Not recorded'}</pre><h3>Proposed fix</h3><pre>{repair.fixSummary || 'Not recorded'}</pre><button className="button secondary" onClick={() => setChosenAttempt(repair.attempt)}>Inspect this attempt’s tests</button></details>)}{!repairs.length && <p>No repair attempts recorded. This does not imply tests passed.</p>}</section>
  </>;
}
