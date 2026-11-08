import NewModernization from "./NewModernization";
import Documentation from "./Documentation";
import { documentationData } from "./documentationData";
import ValidationInvestigation from "./ValidationInvestigation";
import { validationTests as tests } from "./validationData";
import Badge from "./components/StatusBadge";
import AgentActivity from "./AgentActivity";
import { activityEvents } from "./activityData";
import { useRef, useState } from "react";
import Button from "./components/Button";
import "./Workspace.css";

const art = (name: string) => `/design/workspace/${name}.svg`;
const icon = (name: string) => `/design/${name}.svg`;
const stages = [
  {
    title: "Analyze & document",
    status: "Complete",
    detail: "8 files · 12 rules extracted",
    icon: "98f06",
    progress: "79a1f",
  },
  {
    title: "Rewrite",
    status: "Complete",
    detail: "C → Java · 8 files generated",
    icon: "819a9",
    progress: "79a1f",
  },
  {
    title: "Debug",
    status: "Running",
    detail: "Fixing registration boundary",
    icon: "dd345",
    progress: "2107b",
  },
  {
    title: "Validate",
    status: "Waiting",
    detail: "23 / 24 completed tests match",
    icon: "31f35",
    progress: "d98c0",
  },
];
const rules = [
  {
    id: "BR-01",
    name: "Required fields",
    description:
      "Email is required. Both implementations must reject a missing email.",
    before: [
      "int valid_email(char *email) {",
      "  if (email == NULL || *email == '\\0') {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
      "",
      "// BR-01: email is required",
    ],
    after: [
      "boolean validEmail(String email) {",
      "  if (email == null || email.isEmpty()) {",
      "    return false;",
      "  }",
      "  return true;",
      "}",
      "",
      "// BR-01: email is required",
    ],
  },
  {
    id: "BR-02",
    name: "Unique registration ID",
    description:
      "Registration IDs must be unique. Both implementations must reject a duplicate ID.",
    before: [
      "int register_id(int id) {",
      "  if (exists(id)) {",
      "    return 0;",
      "  }",
      "  return save(id);",
      "}",
      "",
      "// BR-02: reject duplicate IDs",
    ],
    after: [
      "boolean registerId(int id) {",
      "  if (exists(id)) {",
      "    return false;",
      "  }",
      "  return save(id);",
      "}",
      "",
      "// BR-02: reject duplicate IDs",
    ],
  },
  {
    id: "BR-03",
    name: "Input length limit",
    description:
      "Input length must remain within the original limit. The example repair now matches.",
    before: [
      "int valid_length(char *input) {",
      "  if (strlen(input) <= 255) {",
      "    return 1;",
      "  }",
      "  return 0;",
      "}",
      "",
      "// BR-03: maximum length is 255",
    ],
    after: [
      "boolean validLength(String input) {",
      "  if (input.length() <= 255) {",
      "    return true;",
      "  }",
      "  return false;",
      "}",
      "",
      "// BR-03: length boundary fixed",
    ],
  },
  {
    id: "BR-04",
    name: "Age eligibility boundary",
    description:
      "minimum registration age is 18. Both implementations must accept the boundary value.",
    before: [
      "int eligible(int age) {",
      "  if (age >= 18) {",
      "    return 1;",
      "  }",
      "  return 0;",
      "}",
      "",
      "// BR-04: minimum age is 18",
    ],
    after: [
      "boolean eligible(int age) {",
      "  if (age > 18) {",
      "    return true;",
      "  }",
      "  return false;",
      "}",
      "",
      "// Boundary mismatch detected",
    ],
  },
];
function CodePane({ modern, lines }: { modern?: boolean; lines: string[] }) {
  return (
    <section
      className="ws-code-pane"
      aria-label={modern ? "Generated Java code" : "Original C code"}
    >
      <h3>
        {modern
          ? "AFTER · GENERATED JAVA  /  Registration.java"
          : "BEFORE · ORIGINAL C  /  registration.c"}
      </h3>
      <pre>
        {lines.map((line, i) => (
          <span key={i} className={i === 1 ? "ws-highlight" : ""}>
            <span className="ws-line-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            {line}
            {"\n"}
          </span>
        ))}
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
  const [activityAgent, setActivityAgent] = useState(2);
  const [tab, setTab] = useState("Code & rules");
  const [selected, setSelected] = useState("BR-04");
  const [filter, setFilter] = useState("All");
  const [agent, setAgent] = useState<number | null>(null);
  const [evidence, setEvidence] = useState<(typeof tests)[number] | null>(null);
  const details = useRef<HTMLDialogElement>(null);
  const rule = rules.find((r) => r.id === selected)!;
  const showAgent = (index: number) => {
    setAgent(index);
    setEvidence(null);
    details.current?.showModal();
  };
  const showEvidence = (test: (typeof tests)[number]) => {
    setEvidence(test);
    setAgent(null);
    setSelected(test.rule);
    details.current?.showModal();
  };
  const exportReport = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            project: "Registration service",
            run: "0042",
            source: "C",
            target: "Java 21",
            exampleData: true,
            status: "Needs review",
            summary: {
              matchingTests: 23,
              totalTests: 24,
              untestedRules: 2,
              security: "1 medium",
            },
            agents: stages,
            visibleEvidence: tests,
            ...(activity ? { timeline: activityEvents } : {}),
            ...(investigation ? { investigation: tests } : {}),
            ...(documentation ? { documentation: documentationData } : {}),
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
    link.download = "agentbox-run-0042-report.json";
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
            <p>HM &nbsp; Hailey’s workspace</p>
          </div>
        </aside>
        <div className="ws-main">
          <div className="ws-circuits" aria-hidden="true">
            <img src={art("f1cb4")} alt="" />
          </div>
          <header className="ws-breadcrumb">
            <p>
              Workspace &nbsp;/ &nbsp;Registration service &nbsp;/ &nbsp;Run
              0042
            </p>
            <span className="ws-isolated">● &nbsp;ISOLATED WORKSPACE</span>
          </header>
          <main className="ws-content" id="ws-content">
            {newModernization ? (
              <NewModernization />
            ) : (
              <>
                <div className="ws-heading">
                  <div className="ws-project">
                    <p>MODERNIZATION / RUN 0042</p>
                    <h1>
                      {activity
                        ? "Agent activity"
                        : documentation
                          ? "System documentation"
                          : investigation
                            ? "Validation"
                            : "Registration service"}
                    </h1>
                    <p>
                      {activity
                        ? "Run 0042   ·   Four specialized agents   ·   Example live state"
                        : documentation
                          ? "Registration service   ·   Generated from original source   ·   Review required"
                          : investigation
                            ? "Run 0042   ·   Same inputs, compared behavior   ·   Example run data"
                            : "C → Java 21   ·   Run 0042   ·   Example run data"}
                    </p>
                  </div>
                  <Badge text={activity ? "Debugging" : "Needs review"} />
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
                    {stages.map((stage, i) => (
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
                          aria-valuenow={[100, 100, 64, 96][i]}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <img src={art(stage.progress)} alt="" />
                        </div>
                        <img
                          className="ws-stage-icon"
                          src={icon(stage.icon)}
                          alt=""
                        />
                        {i === 2 && (
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
                    onNavigate={navigate}
                    onInspect={(ruleId) => {
                      setSelected(ruleId);
                      navigate("Code & rules");
                    }}
                  />
                ) : investigation ? (
                  <ValidationInvestigation
                    onNavigate={navigate}
                    onInspect={(ruleId) => {
                      setSelected(ruleId);
                      navigate("Code & rules");
                    }}
                  />
                ) : activity ? (
                  <AgentActivity
                    selected={activityAgent}
                    onSelect={setActivityAgent}
                    onInspect={(view) => {
                      setSelected("BR-04");
                      navigate(view);
                    }}
                  />
                ) : (
                  <>
                    <div className="ws-metrics">
                      {[
                        ["23 / 24", "Tests match"],
                        ["1", "Behavior mismatch"],
                        ["2", "Rules untested"],
                        ["1 medium", "Security finding"],
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
                              registration.c &nbsp;→ &nbsp; Registration.java
                            </p>
                            <Badge text={`Rule ${selected} selected`} />
                          </div>
                          <div className="ws-comparison-grid">
                            <section className="ws-rules">
                              <h3>BUSINESS RULES</h3>
                              {rules.map((item) => (
                                <button
                                  key={item.id}
                                  className={
                                    selected === item.id ? "selected" : ""
                                  }
                                  aria-pressed={selected === item.id}
                                  onClick={() => setSelected(item.id)}
                                >
                                  <span>
                                    {item.id} &nbsp;{item.name}
                                  </span>
                                  {item.id === "BR-04" && (
                                    <small>
                                      1 failed test · inspect evidence
                                    </small>
                                  )}
                                </button>
                              ))}
                            </section>
                            <CodePane lines={rule.before} />
                            <CodePane modern lines={rule.after} />
                          </div>
                          <p className="ws-linked-rule">
                            Linked rule: {rule.description}
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
                              {[
                                ["All", "24"],
                                ["Failed", "1"],
                                ["Passed", "22"],
                                ["Fixed", "1"],
                              ].map(([name, count]) => (
                                <button
                                  key={name}
                                  className={filter === name ? "selected" : ""}
                                  aria-pressed={filter === name}
                                  onClick={() => setFilter(name)}
                                >
                                  {name} {count}
                                </button>
                              ))}
                            </div>
                          </div>
                          <table>
                            <thead>
                              <tr>
                                <th>TEST CASE</th>
                                <th>RULE</th>
                                <th>LEGACY → JAVA</th>
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
                                  <tr key={test.name}>
                                    <td>
                                      <button
                                        onClick={() => showEvidence(test)}
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
                          {filter !== "All" && (
                            <p className="ws-filter-note">
                              Showing supplied example evidence. Summary counts
                              cover the full example run.
                            </p>
                          )}
                        </section>
                      )}
                      {tab === "Documentation" && (
                        <section className="ws-documentation ws-panel">
                          <h2>Registration service · Run documentation</h2>
                          <p>
                            Example migration from C to Java 21. The analysis
                            agent extracted 12 business rules across 8 source
                            files.
                          </p>
                          <h3>Rules available for review</h3>
                          {rules.map((item) => (
                            <button
                              key={item.id}
                              onClick={() => {
                                setSelected(item.id);
                                setTab("Code & rules");
                              }}
                            >
                              {item.id} · {item.name} →
                            </button>
                          ))}
                          <h3>Review before release</h3>
                          <p>
                            The minimum-age boundary differs at age 18. Two
                            rules remain untested and one medium security
                            finding needs review. Source files remain read-only
                            in the isolated workspace.
                          </p>
                        </section>
                      )}
                    </div>
                    <p className="ws-disclaimer">
                      Example evidence only · A passing test suite does not
                      establish equivalence for every possible input.
                    </p>
                  </>
                )}
              </>
            )}
          </main>
          <footer className="ws-footer">
            <p>AgentBox</p>
            <p>AI-powered legacy modernization</p>
            <p>NVIDIA Nemotron / NIM</p>
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
          <p className="eyebrow">RUN 0042 / EXAMPLE EVIDENCE</p>
          {evidence ? (
            <>
              <h2>{evidence.name}</h2>
              <Badge text={evidence.result} />
              <dl>
                <dt>Business rule</dt>
                <dd>{evidence.rule}</dd>
                <dt>Legacy → Java</dt>
                <dd>{evidence.output}</dd>
              </dl>
              <p>{rules.find((r) => r.id === evidence.rule)?.description}</p>
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
                  0{agent + 1} · {stages[agent].title}
                </h2>
                <Badge text={stages[agent].status} />
                <p>{stages[agent].detail}</p>
                <p>
                  {agent === 2
                    ? "The Java implementation excludes age 18. Compare the linked BR-04 boundary condition and inspect the failed test before accepting a repair."
                    : "This is a snapshot of the example run shown in the design."}
                </p>
                <Button
                  onPress={() => {
                    setSelected("BR-04");
                    setTab("Code & rules");
                    details.current?.close();
                  }}
                >
                  Review code & rules →
                </Button>
              </>
            )
          )}
        </dialog>
      </div>
    </div>
  );
}
