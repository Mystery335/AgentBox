import { useState } from 'react';
import { useConnectionStatus, useRuns, useRunSummaries } from './stdb';
import './Workspace.css';
import './LiveAgentActivity.css';
import './LiveOverview.css';

const statusLabel = (status: string) => status === 'ready_for_cutover' ? 'Tested cases match' : status === 'analyzed' ? 'Analysis complete · waiting' : status.replaceAll('_', ' ');
const formatTime = (micros: bigint) => new Date(Number(micros / 1000n)).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function LiveOverview() {
  const { isActive, connectionError } = useConnectionStatus();
  const [runs, runsReady] = useRuns();
  const [summaries, summariesReady] = useRunSummaries();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [includeChecks, setIncludeChecks] = useState(false);
  const summariesById = new Map(summaries.map(summary => [summary.runId, summary]));
  const available = runs.filter(run => includeChecks || !run.id.startsWith('smoke-'));
  const normalizeSearch = (value: string) => value.toLowerCase().trim().replace(/[\s_–—-]+/g, ' ');
  const matchingSearch = available.filter(run => normalizeSearch(`${run.legacyName} ${run.id} ${run.legacyLanguage} ${run.targetLanguage}`).includes(normalizeSearch(search)));
  const visible = available.filter(run => (status === 'all' || run.status === status) && normalizeSearch(`${run.legacyName} ${run.id} ${run.legacyLanguage} ${run.targetLanguage}`).includes(normalizeSearch(search)));
  const failed = available.filter(run => run.status === 'failed').length;
  const matched = available.filter(run => run.status === 'ready_for_cutover').length;
  const waiting = available.filter(run => run.status === 'analyzed').length;
  const ready = isActive && runsReady;

  return <div className="la-shell">
    <aside className="la-sidebar">
      <a href="#" className="brand">▣ AgentBox</a><p>ENGINEERING WORKSPACE</p>
      <nav aria-label="Workspace navigation">
        <a href="#/workspace" aria-current="page">▦ Modernizations <small>live</small></a>
        <a href="#/workspace/activity">◇ Agent activity <small>live</small></a>
        <a href="#/workspace/validation">✓ Validation <small>live</small></a>
        <a href="#/workspace/documentation">▤ Documentation <small>live</small></a>
      </nav>
      <div className="la-sidebar-note">Overview, Activity, Validation and Documentation read real database records.</div>
      <a href="#/workspace/new" className="la-new">+ Prepare a draft</a>
    </aside>
    <main className="la-main">
      <header><p className="eyebrow">WORKSPACE / MODERNIZATIONS</p><span className={isActive ? 'la-connected' : 'la-disconnected'}>{isActive ? '● Database connected' : connectionError ? '● Connection failed' : '○ Connecting to database'}</span></header>
      <div className="lo-heading"><div className="la-heading"><h1>Modernization workspace</h1><p>Actual runs, recorded progress, and evidence to investigate.</p></div><a className="button secondary" href="#/workspace/new">Prepare a modernization →</a></div>
      <div className="lo-metrics">{[[available.length, 'Recorded runs'], [waiting, 'Analysis complete · waiting'], [failed, 'Failed runs'], [matched, 'Tested cases match']].map(([value, label]) => <div key={label}><strong>{ready ? value : '—'}</strong><span>{label}</span></div>)}</div>
      <div className="la-toolbar"><label className="la-search">Search runs<input placeholder="Search project, run ID, or language…" value={search} onChange={event => setSearch(event.target.value)}/></label><label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{[...new Set(available.map(run => run.status)), ...(status === 'all' ? [] : [status])].filter((value, index, values) => values.indexOf(value) === index).sort().map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label><label className="la-checks"><input type="checkbox" checked={includeChecks} onChange={event => setIncludeChecks(event.target.checked)}/>Include smoke checks</label></div>
      {connectionError ? <div className="la-empty" role="alert"><h2>Couldn’t connect to SpacetimeDB</h2><p>{connectionError.message}</p><button className="button secondary" onClick={() => window.location.reload()}>Retry connection</button></div> : !ready ? <div className="la-empty" role="status">{isActive ? 'Loading run records…' : 'Connecting to SpacetimeDB…'}<p>No example runs are displayed here.</p><button className="button secondary" onClick={() => window.location.reload()}>Retry connection</button></div> : !available.length ? <div className="la-empty">No modernization runs recorded yet. Start a run with the worker, then return here to follow it.</div> : <>
        <div className="la-panel-title lo-list-title"><h2>Modernization runs</h2><span>{visible.length} / {available.length} runs · newest first</span></div>
        <div className="lo-runs">{visible.map(run => {
          const summary = summariesById.get(run.id);
          const query = `?run=${encodeURIComponent(run.id)}`;
          return <article className="lo-run" key={run.id}>
            <div className="lo-run-top"><div><h2>{run.legacyName}</h2><p>{run.legacyLanguage || 'Source not recorded'} → {run.targetLanguage || 'Target not chosen yet'}</p></div><span className={`lo-status ${run.status === 'failed' ? 'lo-failed' : run.status === 'ready_for_cutover' ? 'lo-matched' : ''}`}>{statusLabel(run.status)}</span></div>
            <p className="la-run-id">{run.id}</p>
            <dl className="lo-evidence"><div><dt>Passing / recorded cases</dt><dd>{!summariesReady ? 'Loading…' : summary ? `${summary.testsPassed} / ${summary.testsTotal}` : 'Summary unavailable'}</dd></div><div><dt>Business rules</dt><dd>{summary?.rulesTotal ?? '—'}</dd></div><div><dt>Recorded repairs</dt><dd>{summary?.debugAttempts ?? '—'}</dd></div><div><dt>Agent events</dt><dd>{summary?.events ?? '—'}</dd></div></dl>
            <div className="lo-run-footer"><p>Started {formatTime(run.startedAt.microsSinceUnixEpoch)} CT{run.finishedAt ? ` · Finished ${formatTime(run.finishedAt.microsSinceUnixEpoch)} CT` : ''}</p><div><a href={`#/workspace/activity${query}`}>Agent activity →</a><a href={`#/workspace/validation${query}`}>Validation →</a><a href={`#/workspace/documentation${query}`}>Documentation →</a></div></div>
          </article>;
        })}</div>
        {!visible.length && <div className="la-empty">{matchingSearch.length && status !== 'all' ? `Found ${matchingSearch.length} matching run(s), hidden by the ${statusLabel(status)} status filter.` : 'No runs match this search.'}{matchingSearch.length > 0 && status !== 'all' && <button className="button secondary" onClick={() => setStatus('all')}>Show matching runs in all statuses</button>}<button className="button secondary" onClick={() => { setSearch(''); setStatus('all'); }}>Clear filters</button></div>}
        <p className="la-detail-note">Passing counts use the latest recorded test attempt. Remaining cases can be failed or not run; inspect Validation for the breakdown. Run statuses are reported by the backend and do not guarantee that a worker is currently active. “Tested cases match” applies only to recorded inputs.</p>
      </>}
    </main>
  </div>;
}
