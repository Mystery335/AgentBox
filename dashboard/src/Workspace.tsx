import NewModernization from "./NewModernization";
import Documentation from "./Documentation";
import ValidationInvestigation from "./ValidationInvestigation";
import Badge from "./components/StatusBadge";
import AgentActivity from "./AgentActivity";
import { useRef, useState } from "react";
import Button from "./components/Button";
import { runBadge, selectRun, statusLabel, useLiveRun, type LiveTest } from "./liveRun";
import "./Workspace.css";

const art = (name: string) => `/design/workspace/${name}.svg`;
const icon = (name: string) => `/design/${name}.svg`;
const STAGE_ICONS = ["98f06", "819a9", "dd345", "31f35"];
const progressArt = (status: string) =>
  status === "Complete" || status === "Not needed" ? "79a1f" : status === "Running" ? "2107b" : "d98c0";
const progressValue = (status: string) =>
  status === "Complete" || status === "Not needed" ? 100 : status === "Running" ? 60 : status === "Failed" ? 100 : 0;

function CodePane({
  modern,
  heading,
  start,
  lines,
  empty,
}: {
  modern?: boolean;
  heading: string;
  start: number;
  lines: string[];
  empty: string;
}) {
  return (
    <section
      className="ws-code-pane"
      aria-label={modern ? "Generated code" : "Original code"}
    >
      <h3>{heading}</h3>
      <pre>
        {lines.length
          ? lines.map((line, i) => (
              <span key={i}>
                <span className="ws-line-number">
                  {String(start + i).padStart(2, "0")}
                </span>
                {line}
                {"\n"}
              </span>
            ))
          : empty}
      </pre>
    </section>
  );
}

export default function Workspace({
  onNew,
  activity = false,
  investigation = false,
  documentation = false,
  newModernization = false,
}: {
  onNew: () => void;
  activity?: boolean;
  investigation?: boolean;
  documentation?: boolean;
  newModernization?: boolean;
}) {
  const live = useLiveRun();
  const [activityAgent, setActivityAgent] = useState(0);
  const [tab, setTab] = useState("Code & rules");
  const [selectedKey, setSelected] = useState("");
  const [filter, setFilter] = useState("All");
  const [agent, setAgent] = useState<number | null>(null);
  const [evidence, setEvidence] = useState<LiveTest | null>(null);
  const details = useRef<HTMLDialogElement>(null);

  const run = live.run;
  const rules = live.rules;
  const rule = rules.find((r) => r.key === selectedKey) ?? rules[0];
  const tests = live.tests;
  const legacyLang = run?.legacyLanguage ?? "legacy";
  const target = run?.targetLanguage || "target";
  const legacyFile = live.verification?.legacy_path ?? "original source";
  const modernFile = live.verification?.modern_file ?? "generated code";
  const runLabel = run ? run.id : "no run";

  const showAgent = (index: number) => {
    setAgent(index);
    setEvidence(null);
    details.current?.showModal();
  };
  const showEvidence = (test: LiveTest) => {
    setEvidence(test);
    setAgent(null);
    if (test.ruleKey) setSelected(test.ruleKey);
    details.current?.showModal();
  };
  const exportReport = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            project: run?.legacyName,
            run: run?.id,
            source: run?.legacyLanguage,
            target: run?.targetLanguage,
            status: run?.status,
            summary: live.metrics,
            verification: live.verification
              ? { ...live.verification, legacy_source: undefined }
              : undefined,
            agents: live.stages,
            rules: rules.map((r) => ({ id: r.id, title: r.name, status: r.status, tests: r.tests })),
            tests: tests.map((t) => ({
              id: t.label,
              name: t.name,
              rule: t.rule,
              split: t.split,
              result: t.result,
              history: t.history,
            })),
            debugAttempts: live.debugs.map((d) => ({
              attempt: d.attempt,
              diagnosis: d.diagnosis,
              fix: d.fixSummary,
              outcome: d.outcome,
            })),
            timeline: live.timeline.map((e) => ({ time: e.time, agent: e.agent, message: e.title })),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `agentbox-${run?.id ?? "run"}-report.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const navigate = (next: string) => {
    setTab(next);
    window.location.hash =
      next === "Validation"
        ? "/workspace/validation"
        : next === "Documentation"
          ? "/workspace/documentation"
          : "/workspace";
    document.getElementById("ws-content")?.scrollIntoView({ block: "start" });
  };
  const counts = {
    All: tests.length,
    Failed: tests.filter((t) => t.result === "Failed").length,
    Passed: tests.filter((t) => t.result === "Passed").length,
    Fixed: tests.filter((t) => t.result === "Fixed").length,
  };
  const latestFor = (stage: number) => live.timeline.find((e) => e.stage === stage);

  return (
    <div className="workspace-viewport">
      <div
        className={`workspace-shell ${activity ? "ws-activity" : ""} ${investigation ? "ws-investigation" : ""} ${documentation ? "ws-docs" : ""} ${newModernization ? "ws-new" : ""}`}
      >
        <aside className="ws-sidebar">
          <a href="#" className="brand">
            ▣ AgentBox
          </a>
          <p className="ws-sidebar-label">ENGINEERING WORKSPACE</p>
          <nav aria-label="Workspace navigation">
            <button
              className={
                newModernization ||
                (!activity &&
                  !investigation &&
                  !documentation &&
                  tab !== "Validation" &&
                  tab !== "Documentation")
                  ? "active"
                  : ""
              }
              onClick={() => navigate("Code & rules")}
            >
              ▦ &nbsp;Modernizations
            </button>
            <button
              className={activity ? "active" : ""}
              aria-current={activity ? "page" : undefined}
              onClick={() => {
                window.location.hash = "/workspace/activity";
              }}
            >
              ◇ &nbsp;Agent activity
            </button>
            <button
              className={investigation ? "active" : ""}
              aria-current={investigation ? "page" : undefined}
              onClick={() => navigate("Validation")}
            >
              ✓ &nbsp;Validation
            </button>
            <button
              className={documentation ? "active" : ""}
              aria-current={documentation ? "page" : undefined}
              onClick={() => navigate("Documentation")}
            >
              ▤ &nbsp;Documentation
            </button>
          </nav>
          <div className="ws-account">
            <p className="ws-isolated">● &nbsp;Sandbox isolated</p>
            <p>NVIDIA Nemotron / NIM</p>
            <hr />
            <label className="ws-run-picker">
              <span>RUN</span>
              <select
                value={run?.id ?? ""}
                onChange={(e) => selectRun(e.target.value)}
                aria-label="Select a modernization run"
              >
                {live.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.legacyName} · {statusLabel(r.status)} · {r.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </aside>
        <div className="ws-main">
          <div className="ws-circuits" aria-hidden="true">
            <img src={art("f1cb4")} alt="" />
          </div>
          <header className="ws-breadcrumb">
            <p>
              Workspace &nbsp;/ &nbsp;{run?.legacyName ?? "No runs"} &nbsp;/ &nbsp;
              {runLabel}
            </p>
            <span className="ws-isolated">● &nbsp;LIVE · SPACETIMEDB</span>
          </header>
          <main className="ws-content" id="ws-content">
            {newModernization ? (
              <NewModernization />
            ) : !run ? (
              <div className="ws-heading">
                <div className="ws-project">
                  <p>MODERNIZATION</p>
                  <h1>{live.ready ? "No runs yet" : "Connecting…"}</h1>
                  <p>
                    {live.ready
                      ? "Start one from the worker: npm run modernize -- path/to/legacy.zip. It appears here live."
                      : "Connecting to SpacetimeDB on Maincloud."}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="ws-heading">
                  <div className="ws-project">
                    <p>MODERNIZATION / {runLabel.toUpperCase()}</p>
                    <h1>
                      {activity
                        ? "Agent activity"
                        : documentation
                          ? "System documentation"
                          : investigation
                            ? "Validation"
                            : run.legacyName}
                    </h1>
                    <p>
                      {legacyLang} → {target} &nbsp; · &nbsp; {statusLabel(run.status)}
                    </p>
                  </div>
                  <Badge text={runBadge(run.status)} />
                  <Button variant="neutral" size="small" onPress={exportReport}>
                    Export report
                  </Button>
                  {!activity && !investigation && !documentation && (
                    <Button size="small" onPress={onNew}>
                      + New modernization
                    </Button>
                  )}
                </div>
                {!investigation && !documentation && (
                  <div className="ws-stages">
                    {live.stages.map((stage, i) => (
                      <button
                        className="ws-stage"
                        key={stage.title}
                        onClick={() =>
                          activity ? setActivityAgent(i) : showAgent(i)
                        }
                      >
                        <img className="ws-trim" src={art("faa64")} alt="" />
                        <div className="ws-stage-title">
                          <h2>
                            0{i + 1} &nbsp;{stage.title}
                          </h2>
                          <Badge text={stage.status} />
                        </div>
                        <p>{stage.detail}</p>
                        <div
                          className="ws-progress"
                          role="progressbar"
                          aria-label={`${stage.title} progress`}
                          aria-valuenow={progressValue(stage.status)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <img src={art(progressArt(stage.status))} alt="" />
                        </div>
                        <img
                          className="ws-stage-icon"
                          src={icon(STAGE_ICONS[i])}
                          alt=""
                        />
                        {stage.status === "Running" && (
                          <img
                            className="ws-running-icon"
                            src={icon("14845")}
                            alt=""
                          />
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {documentation ? (
                  <Documentation
                    live={live}
                    onNavigate={navigate}
                    onInspect={(ruleKey) => {
                      setSelected(ruleKey);
                      navigate("Code & rules");
                    }}
                  />
                ) : investigation ? (
                  <ValidationInvestigation
                    live={live}
                    onNavigate={navigate}
                    onInspect={(ruleKey) => {
                      setSelected(ruleKey);
                      navigate("Code & rules");
                    }}
                  />
                ) : activity ? (
                  <AgentActivity
                    live={live}
                    selected={activityAgent}
                    onSelect={setActivityAgent}
                    onInspect={(view) => navigate(view)}
                  />
                ) : (
                  <>
                    <div className="ws-metrics">
                      {[
                        [live.metrics.matching, "Tests match legacy"],
                        [String(live.metrics.mismatches), "Behavior mismatches"],
                        [String(live.metrics.untested), "Rules untested"],
                        [String(live.metrics.debugAttempts), "Debug attempts"],
                      ].map(([value, label]) => (
                        <div key={label}>
                          <strong>{value}</strong>
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                    <div
                      className="ws-tabs"
                      role="tablist"
                      aria-label="Run views"
                    >
                      {[
                        "Overview",
                        "Code & rules",
                        "Validation",
                        "Documentation",
                      ].map((name) => (
                        <button
                          key={name}
                          id={`tab-${name.replaceAll(" ", "-")}`}
                          role="tab"
                          aria-selected={tab === name}
                          aria-controls="ws-tab-panel"
                          onClick={() => navigate(name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <div
                      id="ws-tab-panel"
                      role="tabpanel"
                      aria-labelledby={`tab-${tab.replaceAll(" ", "-")}`}
                    >
                      {(tab === "Code & rules" || tab === "Overview") && (
                        <section className="ws-comparison ws-panel">
                          <img className="ws-trim" src={art("d96b1")} alt="" />
                          <div className="ws-panel-heading">
                            <h2>Before / after</h2>
                            <p>
                              {legacyFile} &nbsp;→ &nbsp; {modernFile}
                            </p>
                            {rule && <Badge text={`Rule ${rule.id} selected`} />}
                          </div>
                          <div className="ws-comparison-grid">
                            <section className="ws-rules">
                              <h3>BUSINESS RULES ({rules.length})</h3>
                              {rules.map((item) => (
                                <button
                                  key={item.key}
                                  className={
                                    rule?.key === item.key ? "selected" : ""
                                  }
                                  aria-pressed={rule?.key === item.key}
                                  onClick={() => setSelected(item.key)}
                                >
                                  <span>
                                    {item.id} &nbsp;{item.name}
                                  </span>
                                  {item.failing > 0 ? (
                                    <small>
                                      {item.failing} failed test
                                      {item.failing === 1 ? "" : "s"} · inspect
                                      evidence
                                    </small>
                                  ) : (
                                    <small>
                                      {item.status} · {item.tests} test
                                      {item.tests === 1 ? "" : "s"}
                                    </small>
                                  )}
                                </button>
                              ))}
                            </section>
                            <CodePane
                              heading={`BEFORE · ORIGINAL ${legacyLang.toUpperCase()}  /  ${legacyFile}`}
                              start={rule?.before.start ?? 1}
                              lines={rule?.before.lines ?? []}
                              empty={
                                !live.verification
                                  ? "Original source appears when the run reaches verification."
                                  : !live.verification.legacy_source
                                    ? "The original source was not recorded for this (older) run."
                                    : "This rule has no legacy line range."
                              }
                            />
                            <CodePane
                              modern
                              heading={`AFTER · GENERATED ${target.toUpperCase()}  /  ${modernFile}`}
                              start={rule?.after.start ?? 1}
                              lines={rule?.after.lines ?? []}
                              empty={
                                live.latestCode
                                  ? "The Translator did not map this rule to modern lines."
                                  : "Not translated yet."
                              }
                            />
                          </div>
                          <p className="ws-linked-rule">
                            {rule
                              ? `Linked rule ${rule.id} (${rule.status}): ${rule.description}`
                              : "No business rules extracted yet."}
                          </p>
                        </section>
                      )}
                      {tab !== "Documentation" && (
                        <section className="ws-validation ws-panel">
                          <img className="ws-trim" src={art("88f71")} alt="" />
                          <div className="ws-panel-heading">
                            <h2>Validation evidence</h2>
                            <div
                              className="ws-filters"
                              aria-label="Filter validation evidence"
                            >
                              {(["All", "Failed", "Passed", "Fixed"] as const).map(
                                (name) => (
                                  <button
                                    key={name}
                                    className={
                                      filter === name ? "selected" : ""
                                    }
                                    aria-pressed={filter === name}
                                    onClick={() => setFilter(name)}
                                  >
                                    {name} {counts[name]}
                                  </button>
                                ),
                              )}
                            </div>
                          </div>
                          <table>
                            <thead>
                              <tr>
                                <th>TEST CASE</th>
                                <th>RULE</th>
                                <th>LEGACY → {target.toUpperCase()}</th>
                                <th>RESULT</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tests
                                .filter(
                                  (test) =>
                                    filter === "All" || test.result === filter,
                                )
                                .map((test) => (
                                  <tr key={test.key}>
                                    <td>
                                      <button
                                        onClick={() => showEvidence(test)}
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
                          {!tests.length && (
                            <p className="ws-filter-note">
                              No test cases yet. The Verifier records them when
                              it runs the legacy program.
                            </p>
                          )}
                        </section>
                      )}
                      {tab === "Documentation" && (
                        <section className="ws-documentation ws-panel">
                          <h2>{run.legacyName} · Run documentation</h2>
                          <p>{live.doc.overview}</p>
                          <h3>Rules available for review</h3>
                          {rules.map((item) => (
                            <button
                              key={item.key}
                              onClick={() => {
                                setSelected(item.key);
                                setTab("Code & rules");
                              }}
                            >
                              {item.id} · {item.name} →
                            </button>
                          ))}
                          <h3>Verification</h3>
                          <p>
                            {live.verification?.reason ||
                              statusLabel(run.status)}
                          </p>
                        </section>
                      )}
                    </div>
                    <p className="ws-disclaimer">
                      Live run data · A passing test suite does not establish
                      equivalence for every possible input.
                    </p>
                  </>
                )}
              </>
            )}
          </main>
          <footer className="ws-footer">
            <p>AgentBox</p>
            <p>AI-powered legacy modernization</p>
            <p>NVIDIA Nemotron / NIM · SpacetimeDB</p>
          </footer>
        </div>
        <dialog
          ref={details}
          className="ws-details"
          aria-label={evidence ? "Test evidence" : "Agent activity"}
          onClick={(e) => {
            if (e.target === e.currentTarget) details.current?.close();
          }}
        >
          <button
            className="close"
            aria-label="Close details"
            onClick={() => details.current?.close()}
          >
            ×
          </button>
          <p className="eyebrow">{runLabel.toUpperCase()} / LIVE EVIDENCE</p>
          {evidence ? (
            <>
              <h2>
                {evidence.label} · {evidence.name}
              </h2>
              <Badge text={evidence.result} />
              <dl>
                <dt>Business rule</dt>
                <dd>{evidence.rule}</dd>
                <dt>Set</dt>
                <dd>
                  {evidence.split}
                  {evidence.split === "holdout" ? " (never shown to the Debugger)" : ""}
                </dd>
                <dt>Legacy → {target}</dt>
                <dd>{evidence.output}</dd>
              </dl>
              <p>Input</p>
              <pre className="ws-evidence-pre">{evidence.input}</pre>
              <p>Legacy output</p>
              <pre className="ws-evidence-pre">{evidence.legacyOutput}</pre>
              {evidence.result === "Failed" && (
                <>
                  <p>{target} output</p>
                  <pre className="ws-evidence-pre">{evidence.modernOutput}</pre>
                </>
              )}
              <Button
                onPress={() => {
                  setTab("Code & rules");
                  details.current?.close();
                }}
              >
                Inspect linked code →
              </Button>
            </>
          ) : (
            agent !== null && (
              <>
                <h2>
                  0{agent + 1} · {live.stages[agent].title}
                </h2>
                <Badge text={live.stages[agent].status} />
                <p>{live.stages[agent].detail}</p>
                <p>{latestFor(agent)?.title ?? "No activity from this agent yet."}</p>
                <Button
                  onPress={() => {
                    details.current?.close();
                    window.location.hash = "/workspace/activity";
                    setActivityAgent(agent);
                  }}
                >
                  Open agent activity →
                </Button>
              </>
            )
          )}
        </dialog>
      </div>
    </div>
  );
}
