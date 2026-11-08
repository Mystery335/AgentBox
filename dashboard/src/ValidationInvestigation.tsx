import { useRef, useState } from "react";
import Button from "./components/Button";
import Badge from "./components/StatusBadge";
import type { LiveRun } from "./liveRun";
import "./ValidationInvestigation.css";

const FILTERS = ["All", "Failed", "Passed", "Fixed"] as const;

export default function ValidationInvestigation({
  live,
  onNavigate,
  onInspect,
}: {
  live: LiveRun;
  onNavigate: (view: string) => void;
  onInspect: (ruleKey: string) => void;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [selectedKey, setSelectedKey] = useState("");
  const fixDialog = useRef<HTMLDialogElement>(null);
  const tests = live.tests;
  const visibleTests = tests.filter((t) => filter === "All" || t.result === filter);
  const selected =
    visibleTests.find((t) => t.key === selectedKey) ??
    visibleTests.find((t) => t.result === "Failed") ??
    visibleTests[0];
  const count = (name: (typeof FILTERS)[number]) =>
    name === "All" ? tests.length : tests.filter((t) => t.result === name).length;
  const run = tests.filter((t) => t.result !== "Waiting").length;
  const matching = tests.filter((t) => t.result === "Passed" || t.result === "Fixed").length;
  const pct = run ? `${((matching / run) * 100).toFixed(1)}%` : "—";
  const target = live.run?.targetLanguage || "modern";
  const lastDebug = live.debugs[live.debugs.length - 1];

  return (
    <>
      <div className="vi-metrics">
        {[
          [pct, `${matching} of ${run} completed tests match`],
          [`${count("Failed")} failed`, count("Failed") ? "Requires investigation" : "No open mismatches"],
          [`${count("Fixed")} fixed`, "Passed after repair"],
          [`${live.metrics.untested} untested`, "Business rules without a test"],
        ].map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <p>{label}</p>
          </div>
        ))}
      </div>
      <div className="ws-tabs vi-tabs" role="tablist" aria-label="Run views">
        {["Overview", "Code & rules", "Validation", "Documentation"].map(
          (name) => (
            <button
              key={name}
              id={`vi-tab-${name.replaceAll(" ", "-")}`}
              role="tab"
              aria-selected={name === "Validation"}
              aria-controls={name === "Validation" ? "vi-tab-panel" : undefined}
              onClick={() => onNavigate(name)}
            >
              {name}
            </button>
          ),
        )}
      </div>
      <div
        id="vi-tab-panel"
        className="vi-tab-panel"
        role="tabpanel"
        aria-labelledby="vi-tab-Validation"
      >
        <section
          className="ws-validation ws-panel vi-tests"
          aria-labelledby="vi-tests-title"
        >
          <img className="ws-trim" src="/design/workspace/88f71.svg" alt="" />
          <div className="vi-filters">
            <h2 id="vi-tests-title">Test cases</h2>
            {FILTERS.map((name) => (
              <button
                key={name}
                className={`ws-badge ${name === "Failed" ? "ws-failed" : ""}`}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name} {count(name)}
              </button>
            ))}
          </div>
          <table aria-label="Validation test cases" aria-describedby="vi-example-note">
            <thead>
              <tr>
                <th scope="col">TEST CASE</th>
                <th scope="col">RULE</th>
                <th scope="col">LEGACY → {target.toUpperCase()}</th>
                <th scope="col">RESULT</th>
              </tr>
            </thead>
            <tbody>
              {visibleTests.map((test) => (
                <tr key={test.key} aria-selected={selected?.key === test.key}>
                  <td>
                    <button
                      onClick={() => setSelectedKey(test.key)}
                      aria-pressed={selected?.key === test.key}
                    >
                      {test.label} · {test.name}
                    </button>
                  </td>
                  <td>{test.rule}</td>
                  <td>{test.output}</td>
                  <td>
                    <Badge text={test.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="vi-example-note" id="vi-example-note">
            {tests.length
              ? `${tests.length} cases: inputs designed by Nemotron, expected outputs recorded by running the legacy program. Holdout cases are never shown to the Debugger.`
              : "No test cases yet."}
          </p>
        </section>
        <section
          className="ws-panel vi-evidence"
          aria-labelledby="vi-evidence-title"
          aria-live="polite"
        >
          <img className="ws-trim" src="/design/validation/d5e92.svg" alt="" />
          {selected ? (
            <>
              <div className="vi-evidence-heading">
                <h2 id="vi-evidence-title">
                  {selected.label} · {selected.name}
                </h2>
                <Badge text={selected.result} />
              </div>
              <p>
                {selected.rule} · {selected.kind} case · {selected.split} set
              </p>
              <div className="vi-outputs">
                {[
                  ["TEST INPUT", selected.input, "Fed on standard input"],
                  ["ORIGINAL", selected.legacyOutput, `${live.run?.legacyLanguage ?? "Legacy"} program in its Docker image`],
                  [
                    `GENERATED ${target.toUpperCase()}`,
                    selected.result === "Waiting" ? "(not run yet)" : selected.modernOutput,
                    selected.output,
                  ],
                  ["EXPECTED BEHAVIOR", selected.legacyOutput, "Identical to the original"],
                ].map(([label, value, note]) => (
                  <div key={label}>
                    <h3>{label}</h3>
                    <strong
                      className={
                        label.startsWith("GENERATED") && selected.result === "Failed"
                          ? "vi-mismatch"
                          : ""
                      }
                    >
                      <pre className="ws-evidence-pre">{value || "(empty)"}</pre>
                    </strong>
                    <p>{note}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <h2 id="vi-evidence-title">No test selected</h2>
          )}
        </section>
        <section
          className="ws-panel vi-history"
          aria-labelledby="vi-history-title"
        >
          <img className="ws-trim" src="/design/validation/ea934.svg" alt="" />
          <h2 id="vi-history-title">Debug history</h2>
          {selected?.history.length ? (
            selected.history.map((h, i) => (
              <p
                key={h.attempt}
                className={i === selected.history.length - 1 ? "vi-latest-attempt" : ""}
              >
                Attempt {h.attempt} · {h.passed ? "identical to legacy" : "differs from legacy"}
                {h.attempt > 0 && live.debugs.find((d) => d.attempt === h.attempt)
                  ? ` · after fix: ${live.debugs.find((d) => d.attempt === h.attempt)!.fixSummary.slice(0, 140)}`
                  : ""}
              </p>
            ))
          ) : (
            <p>This test has not been run yet.</p>
          )}
          <div className="vi-actions">
            {lastDebug && (
              <Button size="small" onPress={() => fixDialog.current?.showModal()}>
                Inspect latest fix
              </Button>
            )}
            {selected?.ruleKey && (
              <Button
                variant="neutral"
                size="small"
                onPress={() => onInspect(selected.ruleKey)}
              >
                View linked code
              </Button>
            )}
          </div>
        </section>
        <p className="vi-disclaimer">
          Fixed = failed on an earlier attempt, then passed on a later one.
          Every attempt's results stay in SpacetimeDB.
        </p>
      </div>
      <dialog
        ref={fixDialog}
        className="vi-fix-dialog"
        aria-labelledby="vi-fix-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) fixDialog.current?.close();
        }}
      >
        <button
          className="close"
          aria-label="Close fix details"
          onClick={() => fixDialog.current?.close()}
        >
          ×
        </button>
        {lastDebug && (
          <>
            <p className="eyebrow">
              {live.run?.id} / DEBUG ATTEMPT {lastDebug.attempt}
            </p>
            <h2 id="vi-fix-title">{lastDebug.errorSummary}</h2>
            <div className="vi-fix-code">
              <p>Diagnosis</p>
              <pre>{lastDebug.diagnosis}</pre>
              <p>Fix applied</p>
              <pre>{lastDebug.fixSummary}</pre>
            </div>
            <Badge text={lastDebug.outcome === "fixed" ? "Fixed" : "Failed"} />
            <p>
              After this fix: {lastDebug.passedCount} of {lastDebug.totalCount}{" "}
              cases identical to legacy ({lastDebug.outcome.replace("_", " ")}).
            </p>
          </>
        )}
      </dialog>
    </>
  );
}
