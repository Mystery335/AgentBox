// Worker service for the dashboard's "Start modernization" button.
//
//   npm run serve
//
// Polls SpacetimeDB for queued jobs (the dashboard uploads a zip with the
// open submit_job reducer), claims one at a time, and runs the whole
// pipeline: Analyzer -> Translator -> Verifier -> Debugger -> shadow. The job
// is linked to its run as soon as the Analyzer creates it, so the dashboard
// can follow the run live. Needs Docker Desktop and a writer STDB_TOKEN.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT } from './dockerize.ts';
import { analyzeZip } from './analyzer/index.ts';
import { modernizeRun } from './modernize/index.ts';
import { Stdb, type Row } from './stdb.ts';

const POLL_MS = 3000;
/** How often the worker reports in; the dashboard treats ~45 s of silence as offline. */
const HEARTBEAT_MS = 15_000;
const micros = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : 0);
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Safe file name for the uploaded zip on disk. Exported for tests. */
export function uploadName(jobId: string, zipName: string): string {
  const base = path.basename(zipName.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_') || 'legacy.zip';
  return `${jobId.replace(/[^\w.-]+/g, '_')}-${/\.zip$/i.test(base) ? base : `${base}.zip`}`;
}

/** Runs one claimed job end to end. Returns the final job status. */
export async function runJob(db: Stdb, job: Row, log: (m: string) => void = console.log): Promise<'done' | 'failed'> {
  const id = String(job.id);
  const zipRow = (await db.sql(`SELECT * FROM job_zip WHERE job_id = ${sqlStr(id)}`))[0];
  if (!zipRow) throw new Error('the uploaded zip is missing');
  const dir = path.join(AGENTBOX_ROOT, '.cache', 'uploads');
  await mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, uploadName(id, String(job.zip_name)));
  await writeFile(zipPath, Buffer.from(String(zipRow.data), 'base64'));
  log(`job ${id}: ${job.zip_name} (${job.zip_bytes} bytes) -> ${zipPath}`);

  // 1. Analyzer (links the job to the run as soon as the run exists).
  const analysis = await analyzeZip(zipPath, {
    log,
    onRunStarted: runId => db.updateJob(id, runId, 'Analyzer running'),
  });
  if (!analysis.system) {
    await db.finishJob(id, 'failed', `The Analyzer did not reach a decision for run ${analysis.runId}`);
    return 'failed';
  }
  // 2-5. Translator, Verifier, Debugger, shadow.
  await db.updateJob(id, analysis.runId, 'Translating, verifying and debugging');
  const r = await modernizeRun(zipPath, analysis.runId, { bundle: analysis.bundle, log });
  const status = r.status === 'ready_for_cutover' ? 'done' : 'failed';
  await db.finishJob(id, status, r.reason);
  return status;
}

export async function serve(opts: { once?: boolean; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) throw new Error('STDB_TOKEN is empty in AgentBox/.env (see scripts/README.md)');
  const me = db.identityHex;
  log(`worker ${me.slice(0, 12) || '(unknown identity)'} watching ${db.host} / ${db.db} for dashboard jobs (Ctrl+C to stop)`);

  // A job this worker was running when it stopped can't resume: fail it so
  // the dashboard isn't left waiting and a new job can be submitted.
  for (const j of await db.sql(`SELECT * FROM job WHERE status = 'running'`)) {
    if (me && String(j.worker).toLowerCase().replace(/^0x/, '') === me.replace(/^0x/, '')) {
      await db.finishJob(String(j.id), 'failed', 'The worker restarted while this job was running; submit it again.');
      log(`job ${j.id}: marked failed (worker restarted mid-job)`);
    }
  }

  // Heartbeat so the dashboard can show whether a worker is online (and busy).
  const status = { state: 'idle' as 'idle' | 'busy', jobId: '' };
  const beat = () =>
    db.workerHeartbeat(status.state, status.jobId).catch(e => log(`heartbeat not stored (${errText(e).slice(0, 100)})`));
  await beat();
  const beatTimer = setInterval(() => void beat(), HEARTBEAT_MS);

  try {
    let idleLogged = false;
    for (;;) {
      let queued: Row[] = [];
      try {
        queued = (await db.sql(`SELECT * FROM job WHERE status = 'queued'`)).sort((a, b) => micros(a.created_at) - micros(b.created_at));
      } catch (e) {
        log(`could not read jobs (${errText(e).slice(0, 120)}); retrying`);
      }
      const job = queued[0];
      if (!job) {
        if (!idleLogged) log('waiting for a job from the dashboard...');
        idleLogged = true;
        if (opts.once) return;
        await sleep(POLL_MS);
        continue;
      }
      idleLogged = false;
      const id = String(job.id);
      try {
        await db.claimJob(id);
      } catch (e) {
        log(`job ${id}: could not claim (${errText(e).slice(0, 120)})`);
        continue; // another worker took it
      }
      Object.assign(status, { state: 'busy', jobId: id });
      await beat();
      try {
        const result = await runJob(db, job, log);
        log(`job ${id}: ${result}`);
      } catch (e) {
        log(`job ${id}: failed: ${errText(e)}`);
        try {
          await db.finishJob(id, 'failed', errText(e).slice(0, 1000));
        } catch {
          /* already finished */
        }
      }
      Object.assign(status, { state: 'idle', jobId: '' });
      await beat();
      if (opts.once) return;
    }
  } finally {
    clearInterval(beatTimer);
  }
}

if (process.argv[1] && /serve\.ts$/.test(process.argv[1])) {
  serve({ once: process.argv.includes('--once') }).catch(e => {
    console.error(errText(e));
    process.exitCode = 1;
  });
}
