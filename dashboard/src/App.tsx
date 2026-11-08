import LiveOverview from "./LiveOverview";
import LiveAgentActivity from "./LiveAgentActivity";
import { useSyncExternalStore } from "react";
import Button from "./components/Button";
import Workspace from "./Workspace";
import "./App.css";

const asset = (name: string) => `/design/${name}.svg`;
const agents = [
  [
    "Analyze & document",
    "Extract business rules, map dependencies and explain the original system.",
    "98f06",
  ],
  [
    "Rewrite",
    "Translate the implementation into a modern language while retaining its business logic.",
    "819a9",
  ],
  [
    "Debug",
    "Investigate mismatches, propose targeted fixes and track each repair attempt.",
    "dd345",
  ],
  [
    "Validate",
    "Run both versions against shared inputs and surface differences for review.",
    "31f35",
  ],
];
const subscribeToRoute = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};
function App() {
  const route = useSyncExternalStore(
    subscribeToRoute,
    () => window.location.hash,
  );
  const isWorkspace = route.startsWith("#/workspace");
  const open = (next: "new" | "dashboard") => {
    window.location.hash = next === "new" ? "/workspace/new" : "/workspace";
    window.scrollTo(0, 0);
  };
  return (
    <>
      {(route.startsWith("#/workspace/activity") || route.startsWith("#/workspace/validation")) ? (
        <LiveAgentActivity validation={route.startsWith("#/workspace/validation")} requestedRunId={new URLSearchParams(route.split("?")[1] ?? "").get("run") ?? undefined} />
      ) : route.split("?")[0].replace(/\/$/, "") === "#/workspace" ? (
        <LiveOverview />
      ) : isWorkspace ? (
        <Workspace
          onNew={() => open("new")}
          activity={route.startsWith("#/workspace/activity")}
          investigation={route.startsWith("#/workspace/validation")}
          documentation={route.startsWith("#/workspace/documentation")}
          newModernization={route.startsWith("#/workspace/new")}
        />
      ) : (
        <div className="landing">
          <header className="navigation">
            <a className="brand" href="#">
              ▣ AgentBox
            </a>
            <nav aria-label="Main navigation">
              <a href="#product">The product</a>
              <a href="#workflow">How it works</a>
              <a href="#stack">Built with</a>
              <Button variant="secondary" onPress={() => open("dashboard")}>
                Open dashboard →
              </Button>
            </nav>
          </header>
          <main>
            <section className="hero" id="product">
              <div className="category eyebrow">
                <span>●</span> AI-POWERED LEGACY MODERNIZATION
              </div>
              <h1>
                Old code.
                <br />
                New possibilities.
              </h1>
              <p className="hero-description">
                Understand, rewrite and validate legacy software with a team of
                AI agents.
                <br />
                Review the code, the evidence and every unresolved issue in one
                workspace.
              </p>
              <div className="hero-actions">
                <Button onPress={() => open("new")}>
                  Start modernization →
                </Button>
                <Button variant="secondary" onPress={() => open("dashboard")}>
                  Explore dashboard
                </Button>
              </div>
              <p className="source-note eyebrow">
                FOR ENGINEERING TEAMS&nbsp; / &nbsp;ORIGINAL SOURCE STAYS
                READ-ONLY
              </p>
              <div className="illustration-wrap">
                <div
                  className="illustration"
                  role="img"
                  aria-label="Legacy source transformed into a modern implementation with the same business rule"
                >
                  <img
                    className="illustration-art"
                    src={asset("164e6")}
                    alt=""
                  />
                  {[false, true].map((modern) => (
                    <div
                      key={String(modern)}
                      className={`code-card ${modern ? "modern" : "legacy"}`}
                    >
                      <img className="code-trim" src={asset("b6494")} alt="" />
                      <p className="eyebrow">
                        {modern ? "02 / MODERNIZED" : "01 / ORIGINAL"}
                      </p>
                      <h3>
                        {modern ? "Modern implementation" : "Legacy source"}
                      </h3>
                      <pre>
                        {modern
                          ? "boolean eligible(int age)\n    return age >= 18;"
                          : "if (age >= 18) {\n    return 1;\n}"}
                      </pre>
                    </div>
                  ))}
                  <img
                    className="modernization-arrow"
                    src={asset("eb1a1")}
                    alt=""
                  />
                  <p className="illustration-caption eyebrow">
                    SAME BUSINESS RULE. NEW IMPLEMENTATION.
                  </p>
                </div>
              </div>
            </section>
            <section className="stack" id="stack">
              <p className="eyebrow">BUILT WITH</p>
              <p>
                NVIDIA Nemotron / NIM <span>·</span> SpacetimeDB <span>·</span>{" "}
                Docker <span>·</span> GnuCOBOL
              </p>
            </section>
            <section className="workflow" id="workflow">
              <p className="eyebrow">01 / THE WORKFLOW</p>
              <h2>Four agents. One reviewable process.</h2>
              <p className="workflow-description">
                Follow the work from understanding the source to investigating
                the final test results.
              </p>
              <div className="agent-grid">
                {agents.map(([title, description, icon], i) => (
                  <article className="agent-card" key={title}>
                    <img className="agent-trim" src={asset("bfcaf")} alt="" />
                    <p className="eyebrow">0{i + 1} / AGENT</p>
                    <h3>{title}</h3>
                    <p className="agent-description">{description}</p>
                    <img className="agent-icon" src={asset(icon)} alt="" />
                    {i === 2 && (
                      <img className="activity" src={asset("14845")} alt="" />
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="review">
              <div>
                <p className="eyebrow">02 / BUILT FOR ENGINEERING REVIEW</p>
                <h2>
                  See what changed.
                  <br />
                  Know what needs review.
                </h2>
              </div>
              <div className="capabilities">
                {[
                  [
                    "Before / after code",
                    "Trace business rules to the original and rewritten implementation.",
                  ],
                  [
                    "Evidence you can inspect",
                    "Compare inputs, outputs, failures and the history of attempted fixes.",
                  ],
                  [
                    "An isolated workspace",
                    "Inspect security findings and review the result before deciding what ships.",
                  ],
                ].map(([title, description]) => (
                  <div key={title}>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="get-started">
              <p className="eyebrow">THE NEXT CHAPTER OF YOUR CODEBASE</p>
              <h2>Bring the past forward.</h2>
              <Button onPress={() => open("new")}>Start modernization →</Button>
              <p>Upload source. Watch the agents. Review the evidence.</p>
            </section>
          </main>
          <footer>
            <a className="brand" href="#">
              ▣ AgentBox
            </a>
            <p>A multi-agent workspace for legacy software modernization.</p>
            <p>Frontend: Vite · React · TypeScript</p>
          </footer>
          <div className="circuit-overlay" aria-hidden="true">
            <img src={asset("a9e67")} alt="" />
          </div>
        </div>
      )}
    </>
  );
}
export default App;
