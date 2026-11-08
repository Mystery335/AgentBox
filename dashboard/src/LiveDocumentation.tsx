import { useState } from 'react';
import './LiveDocumentation.css';

const readable = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^- /gm, '• ');

function ReportText({ text }: { text: string }) {
  // Render generated content as React text; never execute embedded HTML.
  return <>{text.split(/\n\s*\n/).filter(Boolean).map((block, index) => {
    const lines = block.split('\n');
    const heading = lines[0].match(/^#{1,6}\s+(.+)$/);
    return <section key={index}>{heading ? <><h3>{heading[1]}</h3>{lines.length > 1 && <p>{readable(lines.slice(1).join('\n'))}</p>}</> : <p>{readable(block)}</p>}</section>;
  })}</>;
}

export default function LiveDocumentation({ runId, report }: { runId: string; report: string }) {
  const [raw, setRaw] = useState(false);
  const [search, setSearch] = useState('');
  const sections = report.split(/(?=^##\s)/m).filter(section => section.trim());
  const visible = sections.filter(section => section.toLowerCase().includes(search.trim().toLowerCase()));
  const download = () => {
    const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${runId}-report.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!report.trim()) return <div className="la-empty">No report has been generated for this run yet. Check Agent activity for analysis progress or errors.<p><a href={`#/workspace/activity?run=${encodeURIComponent(runId)}`}>View this run’s activity →</a></p></div>;
  return <>
    <div className="la-toolbar"><label className="la-search">Search report<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find architecture, risks, migration order…"/></label><button className="button secondary" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? 'Readable view' : 'View source'}</button><button className="button secondary" onClick={download}>Download report</button></div>
    <p className="la-detail-note">Generated analysis from this run, as stored by the backend. Review its claims against the source and Validation results. This report is not a certification of modernization success.</p>
    <div className="ld-layout"><nav aria-label="Report sections">{visible.map((section, index) => <a key={index} href={`#report-section-${index}`} onClick={event => { event.preventDefault(); document.getElementById(`report-section-${index}`)?.scrollIntoView({behavior:'smooth',block:'start'}); }}>{section.split('\n')[0].replace(/^#+\s*/, '')}</a>)}</nav><article className="ld-report" aria-label="Generated report">{visible.map((section,index) => <div id={`report-section-${index}`} key={index}>{raw ? <pre>{section}</pre> : <ReportText text={section}/>}</div>)}{!visible.length && <p>No report sections match your search.</p>}</article></div>
    <div className="la-toolbar"><a href={`#/workspace/activity?run=${encodeURIComponent(runId)}`}>Agent activity →</a><a href={`#/workspace/validation?run=${encodeURIComponent(runId)}`}>Validation evidence →</a></div>
  </>;
}
