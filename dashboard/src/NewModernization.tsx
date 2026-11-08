// New modernization. Runs are started by the AgentBox worker (it needs Docker
// and the database's writer token), not by this page: nothing is uploaded from
// the browser. The page builds the exact worker command for the chosen ZIP and
// options; the run then appears live in the run picker.

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import Button from "./components/Button";
import "./NewModernization.css";

const SAMPLE_NAME = "payroll-cobol.zip";
const SAMPLE_PATH = "../samples/payroll-cobol.zip";
const TARGETS = "Python 3.12, Java 21, TypeScript, JavaScript, C or Go";

const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
/** Quote an argument when it has characters a shell would split or expand. */
const arg = (value: string) => (/^[\w./:@+-]+$/.test(value) ? value : `"${value.replace(/["`$\\]/g, "")}"`);

type Shell = "bash" | "powershell";

export default function NewModernization() {
  const [zip, setZip] = useState<File | null>(null);
  const [program, setProgram] = useState("");
  const [attempts, setAttempts] = useState("5");
  const [shell, setShell] = useState<Shell>("bash");
  const [live, setLive] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);

  const addFiles = (incoming: File[]) => {
    const zips = incoming.filter((file) => /\.zip$/i.test(file.name) && file.size > 0);
    if (!zips.length) {
      setError("Choose a .zip of the legacy project. It must contain a Dockerfile that builds the legacy program.");
      return;
    }
    setError(zips.length > 1 || zips.length !== incoming.length ? `Using ${zips[0].name}; the worker takes one ZIP per run.` : "");
    setZip(zips[0]);
  };

  const zipPath = !zip || zip.name === SAMPLE_NAME ? SAMPLE_PATH : `path/to/${zip.name}`;
  const options = [program.trim() && `--only ${arg(program.trim())}`, attempts !== "5" && `--attempts ${attempts}`].filter(Boolean).join(" ");
  const modernize = `npm run modernize -- ${arg(zipPath)}${options ? ` ${options}` : ""}`;
  const command = [
    "cd worker",
    live ? (shell === "bash" ? `NEMOTRON_CACHE=0 ${modernize}` : `$env:NEMOTRON_CACHE = "0"; ${modernize}`) : modernize,
  ].join("\n");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCopied(false);
    confirmation.current?.showModal();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <p className="nm-eyebrow">NEW MODERNIZATION</p>
      <h1 className="nm-title">Bring your legacy code forward.</h1>
      <p className="nm-intro">
        Choose a legacy project, then start the run from the AgentBox worker and watch the agents here.
      </p>
      <form className="nm-form" onSubmit={submit}>
        <img className="ws-trim" src="/design/new-modernization/64a3d.svg" alt="" />
        <h2>1. Legacy system</h2>
        <div
          className={`nm-dropzone ${dragging ? "is-dragging" : ""}`}
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
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <h3 id="nm-upload-title">↑ &nbsp;Drop a project ZIP here (with its Dockerfile)</h3>
          {!zip ? (
            <p id="nm-upload-help">No ZIP chosen: the included payroll sample ({SAMPLE_PATH.slice(3)}) is used.</p>
          ) : (
            <div className="nm-selected" aria-live="polite">
              <p id="nm-upload-help">1 ZIP selected · {fileSize(zip.size)}</p>
              <ul>
                <li>
                  <span title={zip.name}>{zip.name}</span>
                  <small>{fileSize(zip.size)}</small>
                  <button type="button" aria-label={`Remove ${zip.name}`} onClick={() => setZip(null)}>
                    ×
                  </button>
                </li>
              </ul>
            </div>
          )}
          <button type="button" className="nm-browse" onClick={() => input.current?.click()}>
            Browse files
          </button>
          <input
            type="file"
            ref={input}
            accept=".zip,application/zip"
            className="nm-file-input"
            tabIndex={-1}
            aria-label="Legacy project ZIP"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <h2>2. Options</h2>
        <label className="nm-project-label" htmlFor="nm-project">
          Program to modernize (optional)
        </label>
        <input
          id="nm-project"
          value={program}
          onChange={(event) => setProgram(event.target.value)}
          placeholder="Picked by the Analyzer when empty, e.g. PAYCALC"
        />
        <div className="nm-languages">
          <label>
            Debug attempts (at most 5)
            <span className="nm-select">
              <select value={attempts} onChange={(event) => setAttempts(event.target.value)}>
                {["1", "2", "3", "4", "5"].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <span aria-hidden="true">▾</span>
            </span>
          </label>
          <label>
            Worker shell
            <span className="nm-select nm-long-value">
              <select value={shell} onChange={(event) => setShell(event.target.value as Shell)}>
                <option value="bash">Git Bash / macOS / Linux</option>
                <option value="powershell">PowerShell</option>
              </select>
              <span aria-hidden="true">▾</span>
            </span>
          </label>
        </div>
        <label className="nm-live">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          Call Nemotron live (skip the worker’s saved responses)
        </label>
        <p className="nm-isolation-note">
          The Analyzer detects the legacy language and picks the target ({TARGETS}). Both programs run in Docker
          with no network and a read-only file system.
        </p>
        <button className="button primary nm-submit" type="submit">
          Show worker command &nbsp;→
        </button>
        {error && (
          <p id="nm-form-error" className="nm-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <dialog
        ref={confirmation}
        className="nm-confirmation"
        aria-labelledby="nm-confirmation-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) confirmation.current?.close();
        }}
      >
        <button className="close" aria-label="Close" onClick={() => confirmation.current?.close()}>
          ×
        </button>
        <p className="eyebrow">NEW MODERNIZATION / WORKER COMMAND</p>
        <h2 id="nm-confirmation-title">Start the run on the worker</h2>
        <dl>
          <dt>Legacy ZIP</dt>
          <dd>{zip ? zip.name : `${SAMPLE_NAME} (included sample)`}</dd>
          <dt>Program</dt>
          <dd>{program.trim() || "picked by the Analyzer"}</dd>
          <dt>Debug attempts</dt>
          <dd>{attempts}</dd>
          <dt>Nemotron</dt>
          <dd>{live ? "live calls" : "saved responses reused when the request is identical"}</dd>
        </dl>
        <p>From the AgentBox folder on the machine that runs the worker:</p>
        <pre className="ws-evidence-pre nm-command">{command}</pre>
        {zip && zip.name !== SAMPLE_NAME && (
          <p>Replace path/to with where the ZIP is saved on that machine. Nothing is uploaded from this browser.</p>
        )}
        <p>
          The Analyzer, Translator, Verifier and Debugger (each a Nemotron agent) write every step to SpacetimeDB.
          The run appears in the run picker within seconds.
        </p>
        <div className="nm-confirmation-actions">
          <Button onPress={copy}>{copied ? "Copied ✓" : "Copy command"}</Button>
          <Button
            variant="secondary"
            onPress={() => {
              confirmation.current?.close();
              window.location.hash = "/workspace/activity";
            }}
          >
            Open agent activity
          </Button>
        </div>
      </dialog>
    </>
  );
}
