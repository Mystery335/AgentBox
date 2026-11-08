import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { submitJob, useJob, useWorkerState, type Job } from "./jobs";
import "./NewModernization.css";

const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const activityUrl = (runId: string) => `#/workspace/activity?run=${encodeURIComponent(runId)}`;

const STEPS = [
  { agent: "Analyzer", text: "Builds the legacy system in Docker, maps every program, extracts business rules and picks the target language." },
  { agent: "Translator", text: "Rewrites each verifiable program in the target language and checks that the new code compiles." },
  { agent: "Verifier", text: "Designs its own test inputs, records what the original program outputs, and compares the new code on every test, including holdout tests no other agent sees." },
  { agent: "Debugger", text: "Fixes the differences the Verifier found (from the debug tests only), then the Verifier re-runs everything to confirm." },
];

function WorkerBanner({ worker }: { worker: ReturnType<typeof useWorkerState> }) {
  if (worker.missingTables)
    return (
      <p className="nm-worker is-offline" role="status">
        The database has no job tables yet. Republish the module (scripts/publish.ps1) to enable Start modernization.
      </p>
    );
  if (worker.online === undefined) return <p className="nm-worker" role="status">Checking for a worker…</p>;
  if (!worker.online)
    return (
      <p className="nm-worker is-offline" role="status">
        No worker is online. On the laptop, run <code>npm run demo</code> (or <code>cd worker</code>, then <code>npm run serve</code>), then try again.
      </p>
    );
  if (worker.busy || worker.activeJob)
    return (
      <p className="nm-worker is-busy" role="status">
        The worker is busy with {worker.activeJob ? `${worker.activeJob.zipName}` : "another modernization"}.{" "}
        {worker.activeJob?.runId ? <a href={activityUrl(worker.activeJob.runId)}>Watch it live</a> : "Start when it has finished."}
      </p>
    );
  return <p className="nm-worker is-online" role="status">● Worker online and ready</p>;
}

function JobProgress({ job, jobId }: { job?: Job; jobId: string }) {
  const status = job?.status ?? "queued";
  const label = { queued: "Waiting for the worker", running: "Running", done: "Finished: every tested case matches", failed: "Finished with failures" }[status];
  return (
    <section className={`nm-progress is-${status}`} aria-live="polite">
      <p className="eyebrow">MODERNIZATION {jobId.toUpperCase()}</p>
      <h2>{label}</h2>
      <p>{job?.message || "Uploaded. The worker picks the job up within a few seconds."}</p>
      {job?.runId ? (
        <a className="button primary" href={activityUrl(job.runId)}>
          Open live agent activity &nbsp;→
        </a>
      ) : (
        <p className="nm-progress-wait">The live view opens as soon as the Analyzer has started the run.</p>
      )}
    </section>
  );
}

export default function NewModernization() {
  const [zip, setZip] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const dropZone = useRef<HTMLDivElement>(null);
  const worker = useWorkerState();
  const { job } = useJob(jobId);

  // Follow the run live as soon as the Analyzer has created it.
  const opened = useRef(false);
  useEffect(() => {
    if (job?.runId && !opened.current) {
      opened.current = true;
      window.setTimeout(() => (window.location.hash = activityUrl(job.runId)), 1200);
    }
  }, [job?.runId]);

  const choose = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (files.length > 1) return setError("Choose one ZIP file with the whole legacy project.");
    if (!/\.zip$/i.test(f.name)) return setError(`${f.name} is not a ZIP file. Zip the legacy project folder first.`);
    if (f.size === 0) return setError(`${f.name} is empty.`);
    if (f.size > MAX_ZIP_BYTES) return setError(`${f.name} is ${fileSize(f.size)}; the limit is 8 MB.`);
    setError("");
    setZip(f);
  };

  const canStart = !!zip && worker.online === true && !worker.busy && !worker.activeJob && !worker.missingTables && !submitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!zip) {
      setError("Choose the legacy project ZIP first.");
      dropZone.current?.focus();
      return;
    }
    if (!canStart) return;
    setSubmitting(true);
    setError("");
    try {
      setJobId(await submitJob(zip));
    } catch (e) {
      setError(`Could not start: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (jobId) return (
    <>
      <h1 className="nm-title">Modernizing {job?.zipName ?? zip?.name}</h1>
      <JobProgress job={job} jobId={jobId} />
    </>
  );

  return (
    <>
      <h1 className="nm-title">Bring your legacy code forward.</h1>
      <p className="nm-intro">Upload the legacy project as a ZIP. The agents analyze it, translate it and prove the new code behaves the same.</p>
      <form className="nm-form" onSubmit={submit}>
        <WorkerBanner worker={worker} />
        <h2>1. Legacy project</h2>
        <div
          className={`nm-dropzone ${dragging ? "is-dragging" : ""}`}
          ref={dropZone}
          tabIndex={-1}
          role="group"
          aria-labelledby="nm-upload-title"
          aria-describedby={error ? "nm-form-error" : "nm-upload-help"}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(Array.from(event.dataTransfer.files));
          }}
        >
          <h3 id="nm-upload-title">↑ &nbsp;Drop the project ZIP here</h3>
          {!zip ? (
            <p id="nm-upload-help">One .zip of the legacy project (up to 8 MB). A Dockerfile is optional: one is generated if missing.</p>
          ) : (
            <div className="nm-selected" aria-live="polite">
              <ul>
                <li>
                  <span title={zip.name}>{zip.name}</span>
                  <small>{fileSize(zip.size)}</small>
                  <button type="button" aria-label={`Remove ${zip.name}`} onClick={() => setZip(undefined)}>
                    ×
                  </button>
                </li>
              </ul>
            </div>
          )}
          <button type="button" className="nm-browse" onClick={() => input.current?.click()}>
            Browse for the ZIP
          </button>
          <input
            type="file"
            ref={input}
            accept=".zip,application/zip"
            className="nm-file-input"
            tabIndex={-1}
            aria-label="Legacy project ZIP"
            onChange={(event) => {
              choose(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <h2>2. What the agents will do</h2>
        <ol className="nm-steps">
          {STEPS.map((s) => (
            <li key={s.agent}>
              <strong>{s.agent}</strong> {s.text}
            </li>
          ))}
        </ol>
        <p className="nm-isolation-note">
          The Analyzer detects the source language and chooses the target. Legacy and generated code run in locked-down containers with no network.
        </p>
        <button className="button primary nm-submit" type="submit" disabled={!canStart} aria-disabled={!canStart}>
          {submitting ? "Uploading…" : "Start modernization"} &nbsp;→
        </button>
        {error && (
          <p id="nm-form-error" className="nm-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
