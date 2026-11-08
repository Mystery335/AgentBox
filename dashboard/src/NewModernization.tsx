import { useRef, useState } from "react";
import type { FormEvent } from "react";
import Button from "./components/Button";
import "./NewModernization.css";

const fileKey = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

export default function NewModernization() {
  const [project, setProject] = useState("Registration service");
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState("C");
  const [target, setTarget] = useState("Java 21");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dropZone = useRef<HTMLDivElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const addFiles = (incoming: File[]) => {
    const valid = incoming.filter((file) => file.size > 0);
    setError(
      valid.length !== incoming.length
        ? "Empty files were skipped. Choose source files or a project ZIP with content."
        : "",
    );
    setFiles((current) => {
      const merged = new Map(current.map((file) => [fileKey(file), file]));
      valid.forEach((file) => merged.set(fileKey(file), file));
      return [...merged.values()];
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!project.trim()) {
      setError("Enter a project name.");
      projectInput.current?.focus();
      return;
    }
    if (!files.length) {
      setError("Choose at least one source file or project ZIP.");
      dropZone.current?.focus();
      return;
    }
    setError("");
    confirmation.current?.showModal();
  };
  const downloadDraft = () => {
    const draft = {
      project: project.trim(),
      sourceLanguage: source,
      targetLanguage: target,
      status: "draft",
      files: files.map((file) => ({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      })),
      execution: "Not started. Backend connection required.",
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "agentbox-modernization-draft.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <h1 className="nm-title">Bring your legacy code forward.</h1>
      <p className="nm-intro">
        Upload source files, choose a target language, then review the agents’
        work.
      </p>
      <form className="nm-form" onSubmit={submit}>
        <h2>1. Project details</h2>
        <label className="nm-project-label" htmlFor="nm-project">
          Project name
        </label>
        <input
          id="nm-project"
          ref={projectInput}
          value={project}
          onChange={(event) => setProject(event.target.value)}
          required
          aria-invalid={!!error && !project.trim()}
        />
        <h2>2. Original source</h2>
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
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <h3 id="nm-upload-title">
            ↑ &nbsp;Drop source files or a project ZIP here
          </h3>
          {!files.length ? (
            <p id="nm-upload-help">
              Example input: registration.c and supporting source files
            </p>
          ) : (
            <div className="nm-selected" aria-live="polite">
              <p id="nm-upload-help">
                {files.length} {files.length === 1 ? "file" : "files"} selected
                · {fileSize(files.reduce((sum, file) => sum + file.size, 0))}
              </p>
              <ul>
                {files.map((file) => (
                  <li key={fileKey(file)}>
                    <span title={file.name}>{file.name}</span>
                    <small>{fileSize(file.size)}</small>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter(
                            (item) => fileKey(item) !== fileKey(file),
                          ),
                        )
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="nm-browse"
            onClick={() => input.current?.click()}
          >
            Browse files
          </button>
          <input
            type="file"
            ref={input}
            multiple
            className="nm-file-input"
            tabIndex={-1}
            aria-label="Source files"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <h2>3. Migration path</h2>
        <div className="nm-languages">
          <label>
            Source language
            <span className={`nm-select ${source !== "C" ? "nm-long-value" : ""}`}>
              <select
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option>C</option>
                <option>COBOL</option>
                <option>C++</option>
              </select>
              <span aria-hidden="true">▾</span>
            </span>
          </label>
          <label>
            Target language
            <span className={`nm-select ${target !== "Java 21" ? "nm-long-value" : ""}`}>
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option>Java 21</option>
                <option>TypeScript</option>
                <option>Python</option>
              </select>
              <span aria-hidden="true">▾</span>
            </span>
          </label>
        </div>
        <p className="nm-isolation-note">
          Source remains read-only. Generated code runs in an isolated
          workspace.
        </p>
        <button className="button primary nm-submit" type="submit">
          Start modernization &nbsp;→
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
          if (event.target === event.currentTarget)
            confirmation.current?.close();
        }}
      >
        <button
          className="close"
          aria-label="Close draft summary"
          onClick={() => confirmation.current?.close()}
        >
          ×
        </button>
        <p className="eyebrow">NEW MODERNIZATION / LOCAL DRAFT</p>
        <h2 id="nm-confirmation-title">Modernization draft ready</h2>
        <dl>
          <dt>Project</dt>
          <dd>{project.trim()}</dd>
          <dt>Migration</dt>
          <dd>
            {source} → {target}
          </dd>
          <dt>Original source</dt>
          <dd>
            {files.length} {files.length === 1 ? "file" : "files"} ·{" "}
            {fileSize(files.reduce((sum, file) => sum + file.size, 0))}
          </dd>
        </dl>
        <p>
          No agents have run. Connect a backend to execute this draft. Your
          source files remain in this browser and have not been uploaded.
        </p>
        <div className="nm-confirmation-actions">
          <Button onPress={downloadDraft}>Download draft</Button>
          <Button
            variant="secondary"
            onPress={() => confirmation.current?.close()}
          >
            Continue editing
          </Button>
        </div>
        <p className="nm-draft-note">
          The download contains project settings and file metadata. Source file
          contents are not included.
        </p>
      </dialog>
    </>
  );
}
