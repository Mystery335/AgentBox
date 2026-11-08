import WorkspaceSidebar from './WorkspaceSidebar';
import { useState } from 'react';
import LiveDocumentation from './LiveDocumentation';
import LiveValidation from './LiveValidation';
import { useConnectionStatus, useRuns, useRunEvents } from './stdb';
import Badge from './components/StatusBadge';
import './Workspace.css';
import './LiveAgentActivity.css';

const roles = [ ['analyzer', 'Analyze', '98f06'], ['translator', 'Translate', '819a9'], ['verifier', 'Verify', '31f35'], ['debugger', 'Debug', 'dd345'] ];
const time = (micros: bigint) => new Date(Number(micros / 1000n)).toLocaleString('en-US', {timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});
const statusText = (status: string) => status === 'ready_for_cutover' ? 'Tested cases match' : status === 'analyzed' ? 'Analysis complete · waiting' : status.replaceAll('_',' ');

function EventFeed({runId, runStatus}: {runId:string;runStatus:string}) {
  const [events, ready] = useRunEvents(runId);
  const [role, setRole] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const filtered = events.filter(event => (role === 'all' || event.agent === role) && `${event.agent} ${event.message}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered.find(event => event.id === selectedId) ?? filtered.at(-1);
  const modelEvent = [...events].reverse().find(event => /nvidia\/[\w.-]+/.test(event.message));
  const model = modelEvent?.message.match(/nvidia\/[\w.-]+/)?.[0];
  const latest = events.at(-1);
  const exportEvents = () => {
    const blob=new Blob([JSON.stringify({runId,status:runStatus,exportedAt:new Date().toISOString(),events:events.map(event=>({...event,createdAt:time(event.createdAt.microsSinceUnixEpoch)}))},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${runId}-events.json`;a.click();URL.revokeObjectURL(url);
  };
  return <>
    <div className="la-role-grid">{roles.map(([id,label,icon]) => {const count=events.filter(event=>event.agent===id).length;return <button key={id} className={role===id?'selected':''} onClick={()=>setRole(role===id?'all':id)} aria-pressed={role===id}><img src={`/design/${icon}.svg`} alt=""/><strong>{label}</strong><span>{count ? `${count} recorded events` : 'No recorded events'}</span></button>})}</div>
    <div className="la-toolbar"><label>Agent<select value={role} onChange={event=>setRole(event.target.value)}><option value="all">All agents</option>{[...new Set([...roles.map(([id])=>id),...events.map(event=>event.agent)])].map(id=><option key={id} value={id}>{id}</option>)}</select></label><label className="la-search">Search events<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Find errors, model names, attempts…"/></label><button className="button secondary" disabled={!events.length} onClick={exportEvents}>Export actual events</button></div>
    <div className="la-model"><strong>Model reported in events:</strong> {model ?? 'No model identity recorded yet.'}<span>Cached responses are identified only where the event message says so. Event counts are not completion percentages.</span></div>
    {!ready ? <div className="la-empty" role="status">Loading events for this run…</div> : !events.length ? <div className="la-empty">No events recorded for this run yet.</div> : <div className="la-panels"><section className="la-timeline" aria-labelledby="la-timeline-title"><div className="la-panel-title"><h2 id="la-timeline-title">Execution timeline</h2><span>{filtered.length} / {events.length} events</span></div><p className="la-latest" aria-live="polite">Latest event: {latest ? time(latest.createdAt.microsSinceUnixEpoch) : '—'}</p><ol>{[...filtered].reverse().map(event=><li key={event.id}><button className={selected?.id===event.id?'selected':''} onClick={()=>setSelectedId(event.id)} aria-pressed={selected?.id===event.id}><span><time>{time(event.createdAt.microsSinceUnixEpoch)}</time><strong>{event.agent}</strong></span><p>{event.message}</p></button></li>)}</ol>{!filtered.length && <p className="la-empty">No events match these filters.</p>}</section><section className="la-inspector" aria-labelledby="la-detail-title"><h2 id="la-detail-title">Event details</h2>{selected ? <><Badge text={selected.agent}/><time>{time(selected.createdAt.microsSinceUnixEpoch)} · Central time</time><p className="la-message">{selected.message}</p><dl><dt>Run</dt><dd>{runId}</dd><dt>Event</dt><dd>{selected.id}</dd></dl></> : <p>Select an event to inspect it.</p>}<p className="la-detail-note">These are recorded backend messages. Missing events do not establish that a stage completed.</p></section></div>}
  </>;
}

export default function LiveAgentActivity({requestedRunId, validation = false, documentation = false}:{requestedRunId?:string; validation?:boolean; documentation?:boolean}) {
  const {isActive,connectionError}=useConnectionStatus();
  const [runs,ready]=useRuns();
  const [showChecks,setShowChecks]=useState(false);
  const realRuns=runs.filter(run=>!run.id.startsWith('smoke-'));
  const visible=showChecks?runs:realRuns;
  const run=requestedRunId?runs.find(run=>run.id===requestedRunId):realRuns[0];
  return <div className="la-shell"><WorkspaceSidebar current={documentation ? 'documentation' : validation ? 'validation' : 'activity'}/><main className="la-main"><header><p className="eyebrow">WORKSPACE / LIVE RUN EVIDENCE</p><span className={isActive?'la-connected':'la-disconnected'}>{isActive?'● Database connected':connectionError?'● Connection failed':'○ Connecting to database'}</span></header><div className="la-heading"><h1>{documentation ? "Documentation" : validation ? "Validation investigation" : "Agent activity"}</h1><p>{documentation ? "Read the generated analysis for your selected run." : validation ? "Compare recorded test outputs and inspect repair attempts." : "Follow actual agent actions, errors, and repair attempts."}</p></div><div className="la-run-picker"><label>Select run<select value={run?.id??''} onChange={event=>{window.location.hash=`/workspace/${documentation ? "documentation" : validation ? "validation" : "activity"}?run=${encodeURIComponent(event.target.value)}`;}} disabled={!ready}><option value="" disabled>{ready?'Choose a run':'Loading runs…'}</option>{visible.map(item=><option key={item.id} value={item.id}>{item.legacyName} · {item.id} · {item.status}</option>)}{run && !visible.some(item=>item.id===run.id) && <option value={run.id}>{run.legacyName} · {run.id}</option>}</select></label><label className="la-checks"><input type="checkbox" checked={showChecks} onChange={event=>setShowChecks(event.target.checked)}/>Include smoke checks</label></div>
    {connectionError ? <div className="la-empty" role="alert"><h2>Couldn’t connect to SpacetimeDB</h2><p>{connectionError.message}</p><p>Check internet access and the dashboard’s VITE_STDB_URI / VITE_STDB_DB settings. Never put a worker token in browser settings.</p><button className="button secondary" onClick={()=>window.location.reload()}>Retry connection</button></div> : !isActive ? <div className="la-empty" role="status">Connecting to SpacetimeDB. No example results are shown here.<p>If this does not connect, check your network and database settings.</p><button className="button secondary" onClick={()=>window.location.reload()}>Retry connection</button></div> : !ready ? <div className="la-empty" role="status">Connected. Loading run records…</div> : !run ? <div className="la-empty">{requestedRunId?'This run was not found. Choose another run above.':'No modernization runs yet. Start the worker, then select its run here.'}</div> : <><section className="la-run-summary"><div><h2>{run.legacyName}</h2><p>{run.legacyLanguage || 'Source not recorded'} → {run.targetLanguage || 'Target not chosen yet'}</p></div><Badge text={statusText(run.status)}/><p>Started {time(run.startedAt.microsSinceUnixEpoch)} CT</p></section><p className="la-run-id">{run.id}</p>{documentation ? <LiveDocumentation key={run.id} runId={run.id} report={run.documentation}/> : validation ? <LiveValidation key={run.id} runId={run.id}/> : <EventFeed key={run.id} runId={run.id} runStatus={run.status}/>}</>}
  </main></div>;
}
