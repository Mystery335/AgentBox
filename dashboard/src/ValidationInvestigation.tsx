import { useRef, useState } from "react";
import Button from "./components/Button";
import Badge from "./components/StatusBadge";
import { validationTests } from "./validationData";
import "./ValidationInvestigation.css";

export default function ValidationInvestigation({
  onNavigate,
  onInspect,
}: {
  onNavigate: (view: string) => void;
  onInspect: (rule: string) => void;
}) {
  const [filter, setFilter] = useState("All");
  const [selectedRule, setSelectedRule] = useState("BR-04");
  const fixDialog = useRef<HTMLDialogElement>(null);
  const selected = validationTests.find((test) => test.rule === selectedRule)!;
  const visibleTests = validationTests.filter(
    (test) => filter === "All" || test.result === filter,
  );
  const changeFilter = (next: string) => {
    setFilter(next);
    const matches = validationTests.filter(
      (test) => next === "All" || test.result === next,
    );
    if (!matches.some((test) => test.rule === selectedRule))
      setSelectedRule(matches[0].rule);
  };
  return (
    <>
      <div className="vi-metrics">
        {[
          ["95.8%", "23 of 24 completed tests match"],
          ["1 failed", "Requires investigation"],
          ["1 fixed", "Passed after repair"],
          ["0 skipped", "2 business rules remain untested"],
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
            {[
              ["All", "24"],
              ["Failed", "1"],
              ["Passed", "22"],
              ["Fixed", "1"],
            ].map(([name, count]) => (
              <button
                key={name}
                className={`ws-badge ${name === "Failed" ? "ws-failed" : ""}`}
                aria-pressed={filter === name}
                onClick={() => changeFilter(name)}
              >
                {name} {count}
              </button>
            ))}
          </div>
          <table aria-label="Example validation test cases" aria-describedby="vi-example-note">
            <thead>
              <tr>
                <th scope="col">TEST CASE</th>
                <th scope="col">RULE</th>
                <th scope="col">LEGACY → JAVA</th>
                <th scope="col">RESULT</th>
              </tr>
            </thead>
            <tbody>
              {visibleTests.map((test) => (
                <tr key={test.rule} aria-selected={selectedRule === test.rule}>
                  <td>
                    <button
                      onClick={() => setSelectedRule(test.rule)}
                      aria-pressed={selectedRule === test.rule}
                    >
                      {test.name}
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
            Showing supplied example cases; summary counts cover the full
            24-test example run.
          </p>
        </section>
        <section
          className="ws-panel vi-evidence"
          aria-labelledby="vi-evidence-title"
          aria-live="polite"
        >
          <img className="ws-trim" src="/design/validation/d5e92.svg" alt="" />
          <div className="vi-evidence-heading">
            <h2 id="vi-evidence-title">{selected.title}</h2>
            <Badge text={selected.result} />
          </div>
          <p>{selected.description}</p>
          <div className="vi-outputs">
            {[
              ["TEST INPUT", selected.input, selected.inputNote],
              ["ORIGINAL C", selected.original, selected.originalNote],
              ["GENERATED JAVA", selected.generated, selected.generatedNote],
              ["EXPECTED BEHAVIOR", selected.expected, selected.expectedNote],
            ].map(([label, value, note]) => (
              <div key={label}>
                <h3>{label}</h3>
                <strong
                  className={
                    label === "GENERATED JAVA" && selected.result === "Failed"
                      ? "vi-mismatch"
                      : ""
                  }
                >
                  {value}
                </strong>
                <p>{note}</p>
              </div>
            ))}
          </div>
        </section>
        <section
          className="ws-panel vi-history"
          aria-labelledby="vi-history-title"
        >
          <img className="ws-trim" src="/design/validation/ea934.svg" alt="" />
          <h2 id="vi-history-title">Debug history</h2>
          {selected.result === "Failed" ? (
            <>
              <p>Attempt 1 · Reworked validation branch → rerun failed</p>
              <p className="vi-latest-attempt">
                Attempt 2 · Proposed age &gt;= 18 boundary fix → awaiting rerun
              </p>
            </>
          ) : selected.result === "Fixed" ? (
            <>
              <p>Earlier attempt · Input length boundary failed</p>
              <p className="vi-latest-attempt">
                Later attempt · Preserved maximum length of 255 → passed after
                repair
              </p>
            </>
          ) : (
            <>
              <p>
                Shared input produced matching outputs in both implementations.
              </p>
              <p className="vi-latest-attempt">
                No repair required for this example test.
              </p>
            </>
          )}
          <div className="vi-actions">
            {selected.result === "Failed" && (
              <Button
                size="small"
                onPress={() => fixDialog.current?.showModal()}
              >
                Inspect proposed fix
              </Button>
            )}
            <Button
              variant="neutral"
              size="small"
              onPress={() => onInspect(selected.rule)}
            >
              View linked code
            </Button>
          </div>
        </section>
        <p className="vi-disclaimer">
          Fixed = previously failed, then passed on a later attempt. Earlier
          evidence remains available.
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
          aria-label="Close proposed fix"
          onClick={() => fixDialog.current?.close()}
        >
          ×
        </button>
        <p className="eyebrow">RUN 0042 / BR-04 / ATTEMPT 2</p>
        <h2 id="vi-fix-title">Proposed boundary fix</h2>
        <p>Registration.java · line 2</p>
        <div className="vi-fix-code">
          <p>Current implementation</p>
          <pre>{"if (age > 18) {"}</pre>
          <p>Proposed change</p>
          <pre>{"if (age >= 18) {"}</pre>
        </div>
        <Badge text="Awaiting rerun" />
        <p>
          This example proposal restores the age-18 boundary. It has not been
          applied or rerun.
        </p>
        <Button
          onPress={() => {
            fixDialog.current?.close();
            onInspect("BR-04");
          }}
        >
          View linked code →
        </Button>
      </dialog>
    </>
  );
}
