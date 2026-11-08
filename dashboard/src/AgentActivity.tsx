import Button from "./components/Button";
import type { LiveRun } from "./liveRun";
import "./AgentActivity.css";

const AGENTS = [
  {
    label: "01 · Analyze & document agent",
    task: "Scan the legacy system, compile-check every program in the sandbox, extract business rules and choose the target language.",
    action: "Inspect business rules",
    view: "Documentation",
  },
  {
    label: "02 · Rewrite agent",
    task: "Translate the chosen program into the target language, preserving every business rule, and map each rule to modern lines.",
    action: "Inspect generated code",
    view: "Code & rules",
  },
  {
    label: "03 · Debug agent",
    task: "Diagnose failing debug cases against the legacy source and fix the modern code. Holdout cases are never shown to it.",
    action: "Inspect validation evidence",
    view: "Validation",
  },
  {
    label: "04 · Validate agent",
    task: "Run the legacy and modern programs on the same inputs in isolated containers and compare outputs and exit codes.",
    action: "Inspect validation evidence",
    view: "Validation",
  },
  {
    label: "System · Isolated workspace",
    task: "Dockerize the uploaded legacy system and keep every run isolated.",
    action: "Inspect run overview",
    view: "Overview",
  },
];

export default function AgentActivity({
  live,
  selected,
  onSelect,
  onInspect,
}: {
  live: LiveRun;
  selected: number;
  onSelect: (value: number) => void;
  onInspect: (view: string) => void;
}) {
  const agent = AGENTS[selected] ?? AGENTS[0];
  const stage = live.stages[selected];
  const mine = live.timeline.filter((e) => e.stage === selected);
  const latest = mine[0];
  const failing = live.tests.filter((t) => t.result === "Failed" && t.split === "debug").length;
  const inputs = [
    [
      `Legacy system: ${live.run?.legacyName ?? "—"} (${live.run?.legacyLanguage ?? "?"})`,
      `${live.doc.rules.length} business rules`,
      `Runtime: ${live.run?.legacyRuntime ?? "—"}`,
    ],
    [
      `Legacy program: ${live.verification?.legacy_path ?? "not chosen yet"}`,
      `${live.rules.length} business rules to preserve`,
      `Target: ${live.run?.targetLanguage || "not chosen yet"}`,
    ],
    [
      `${failing} failing debug case(s)`,
      `Code version: attempt ${live.latestCode?.attempt ?? "—"}`,
      `Protected baseline: ${live.verification?.legacy_path ?? "legacy source"}`,
    ],
    [
      `${live.tests.length} test cases (${live.tests.filter((t) => t.split === "holdout").length} holdout)`,
      `Legacy image: ${live.verification?.legacy_image ?? "—"}`,
      `Modern image: ${live.verification?.target_image ?? "—"}`,
    ],
    [`Run ${live.run?.id ?? "—"}`, `Zip sha256 ${live.run?.legacySha256.slice(0, 12) ?? "—"}`, "Source mounted read-only"],
  ][selected] ?? [];
  const badgeClass =
    stage?.status === "Running" ? "ws-running" : stage?.status === "Failed" ? "ws-failed" : stage?.status === "Complete" ? "ws-complete" : "ws-waiting";
  return (
    <>
      <div className="aa-details">
        <section
          className="aa-timeline ws-panel"
          aria-labelledby="timeline-title"
        >
          <img className="ws-trim" src="/design/activity/1a568.svg" alt="" />
          <h2 id="timeline-title">Execution timeline</h2>
          <p>
            {live.timeline.length} live events · newest first · streamed from
            SpacetimeDB
          </p>
          <ol>
            {live.timeline.slice(0, 60).map((event) => (
              <li key={event.key}>
                <button
                  className="aa-event"
                  onClick={() => onSelect(event.stage)}
                  aria-pressed={selected === event.stage}
                >
                  <span className="aa-event-meta">
                    <time>{event.time}</time>
                    <span className="aa-agent-name">{event.agent}</span>
                    <span
                      className={`ws-badge ws-${event.status.toLowerCase()}`}
                    >
                      {event.status}
                    </span>
                  </span>
                  <strong>{event.title}</strong>
                </button>
              </li>
            ))}
            {!live.timeline.length && <li>No events yet.</li>}
          </ol>
        </section>
        <section
          className="aa-inspector ws-panel"
          aria-labelledby="inspector-title"
        >
          <img className="ws-trim" src="/design/activity/61a53.svg" alt="" />
          <span className={`ws-badge aa-agent-badge ${badgeClass}`}>
            {agent.label}
          </span>
          <h2 id="inspector-title">{stage?.title ?? "System"}</h2>
          <h3 className="aa-task-label">Task</h3>
          <p className="aa-task">{agent.task}</p>
          <hr />
          <h3 className="aa-section-label">INPUTS</h3>
          <ul className="aa-inputs">
            {inputs.map((input) => (
              <li key={input}>{input}</li>
            ))}
          </ul>
          <h3 className="aa-section-label">LATEST OUTPUT</h3>
          <p className="aa-output" title={latest?.title}>
            {latest?.title ?? "No output from this agent yet."}
          </p>
          <span className="ws-badge aa-attempt">
            {stage ? `${stage.status} · ${stage.detail}` : `${mine.length} events`}
          </span>
          <p className="aa-next">
            {mine.length} event{mine.length === 1 ? "" : "s"} from this agent
            {latest ? `, last at ${latest.time}` : ""}.
          </p>
          <Button
            variant="neutral"
            size="small"
            onPress={() => onInspect(agent.view)}
          >
            {agent.action}
          </Button>
        </section>
      </div>
      <section
        className="aa-security ws-panel"
        aria-labelledby="security-title"
      >
        <h2 id="security-title">Sandbox isolation</h2>
        <p>
          Every legacy and generated program runs in Docker with no network, a
          read-only file system, all capabilities dropped, memory and process
          limits, and no environment variables (API keys never enter a
          container).
        </p>
      </section>
    </>
  );
}
