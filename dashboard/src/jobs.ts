// Dashboard side of "Start modernization": uploads the legacy zip as a job
// (submit_job reducer) and follows the job and the worker's heartbeat.
//
// Uses SpacetimeDB's HTTP API (same database as the live views) so the new
// `job` / `worker_status` tables need no regenerated bindings. Reads are
// polled every 2 s; the run itself is then followed live on Agent activity.

import { useEffect, useState } from "react";

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? "wss://maincloud.spacetimedb.com";
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? "legacy-data";
const HTTP = URI.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
const TOKEN_KEY = `stdb-token:${DB}`;
const POLL_MS = 2000;
/** A worker reports every 15 s; after this long without one it counts as offline. */
const WORKER_STALE_MS = 45_000;

type Row = Record<string, unknown>;

function token(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const t = token();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

const columnName = (name: unknown, i: number) =>
  typeof name === "string" ? name : name && typeof name === "object" && "some" in name ? String((name as { some: unknown }).some) : `col${i}`;

async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`${HTTP}/v1/database/${encodeURIComponent(DB)}/sql`, { method: "POST", headers: headers(false), body: query });
  if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
  const out = (await res.json()) as { schema: { elements: { name: unknown }[] }; rows: unknown[][] }[];
  return out.flatMap((r) => {
    const names = r.schema.elements.map((e, i) => columnName(e.name, i));
    return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
  });
}

/** Timestamp column -> ms. Plain: [micros]; option: [0, [micros]] = some, [1, []] = none. */
function ms(v: unknown): number | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.length === 1 && typeof v[0] === "number") return v[0] / 1000;
  if (v.length === 2 && v[0] === 0) return ms(v[1]);
  return undefined;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface Job {
  id: string;
  zipName: string;
  zipBytes: number;
  status: "queued" | "running" | "done" | "failed";
  runId: string;
  message: string;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

const toJob = (r: Row): Job => ({
  id: String(r.id),
  zipName: String(r.zip_name),
  zipBytes: Number(r.zip_bytes),
  status: String(r.status) as Job["status"],
  runId: String(r.run_id ?? ""),
  message: String(r.message ?? ""),
  createdAt: ms(r.created_at),
  startedAt: ms(r.started_at),
  finishedAt: ms(r.finished_at),
});

/** Reads a File as base64 (no data: prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(file);
  });
}

/** Uploads the zip as a queued job. Throws with the module's message if rejected. */
export async function submitJob(zip: File): Promise<string> {
  const id = `job-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 6)}`;
  const data = await fileToBase64(zip);
  const res = await fetch(`${HTTP}/v1/database/${encodeURIComponent(DB)}/call/submit_job`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify([id, zip.name, data]),
  });
  if (!res.ok) throw new Error((await res.text()).trim().replace(/^.*?:\s*/, "") || `HTTP ${res.status}`);
  return id;
}

/** Polls one job (undefined until it's found). */
export function useJob(jobId: string | undefined): { job?: Job; error?: string } {
  const [state, setState] = useState<{ job?: Job; error?: string }>({});
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const row = (await sql(`SELECT * FROM job WHERE id = ${lit(jobId)}`))[0];
        if (!stop) setState({ job: row ? toJob(row) : undefined });
      } catch (e) {
        if (!stop) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);
  return jobId ? state : {};
}

export interface WorkerState {
  /** undefined while the first check is in flight. */
  online?: boolean;
  busy: boolean;
  busyJobId: string;
  /** The module has no job tables yet (needs a republish). */
  missingTables: boolean;
  activeJob?: Job;
}

/** Polls worker heartbeats and the job queue. */
export function useWorkerState(): WorkerState {
  const [state, setState] = useState<WorkerState>({ busy: false, busyJobId: "", missingTables: false });
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const [workers, active] = await Promise.all([
          sql("SELECT * FROM worker_status"),
          sql("SELECT * FROM job WHERE status = 'running'").then(async (r) => (r.length ? r : sql("SELECT * FROM job WHERE status = 'queued'"))),
        ]);
        const now = Date.now();
        const live = workers.filter((w) => now - (ms(w.last_seen) ?? 0) < WORKER_STALE_MS);
        const busy = live.find((w) => w.state === "busy");
        if (!stop)
          setState({
            online: live.length > 0,
            busy: !!busy && live.every((w) => w.state === "busy"),
            busyJobId: busy ? String(busy.job_id) : "",
            missingTables: false,
            activeJob: active[0] ? toJob(active[0]) : undefined,
          });
      } catch (e) {
        const missing = /no such table/i.test(e instanceof Error ? e.message : String(e));
        if (!stop) setState((s) => ({ ...s, online: missing ? false : s.online, missingTables: missing }));
      }
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);
  return state;
}
