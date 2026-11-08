import { activityEvents } from "./activityData";
import Button from "./components/Button";
import "./AgentActivity.css";

const inspectors = [
  {
    label: "01 · Analyze & document agent",
    title: "Documented registration business logic",
    task: "Extract and explain the business rules in the original registration service.",
    inputs: ["8 source files", "Protected baseline: registration.c"],
    output: "12 business rules mapped to source code.",
    attempt: "Analysis complete",
    next: "Next: review the extracted business rules and documentation.",
    action: "Inspect business rules",
    view: "Documentation",
  },
  {
    label: "02 · Rewrite agent",
    title: "Generated Java implementation",
    task: "Translate the C registration service to Java 21 while preserving its business rules.",
    inputs: [
      "8 source files",
      "12 extracted business rules",
      "Protected baseline: registration.c",
    ],
    output: "8 Java output files generated.",
    attempt: "Rewrite complete",
    next: "Next: compare generated code against the original implementation.",
    action: "Inspect generated code",
    view: "Code & rules",
  },
  {
    label: "03 · Debug agent",
    title: "Repairing a boundary mismatch",
    task: "Preserve BR-04: registration accepts applicants aged 18 and above.",
    inputs: [
      "Failed test T-017",
      "Registration.java",
      "Protected baseline: registration.c",
    ],
    output: "Change age > 18 to age >= 18.",
    attempt: "Attempt 2 of 3",
    next: "Next: rerun validation against the unchanged source baseline.",
    action: "Inspect code change",
    view: "Code & rules",
  },
  {
    label: "04 · Validate agent",
    title: "Investigating a boundary mismatch",
    task: "Compare both implementations on shared inputs, including the minimum registration age.",
    inputs: [
      "Test T-017 · age = 18",
      "Registration.java",
      "Protected baseline: registration.c",
    ],
    output: "Legacy: true → Java: false.",
    attempt: "23 / 24 tests match",
    next: "Next: inspect the failed test and review the proposed boundary repair.",
    action: "Inspect validation evidence",
    view: "Validation",
  },
  {
    label: "System · Isolated workspace",
    title: "Created isolated run workspace",
    task: "Keep the original source protected while the agents analyze and rewrite the service.",
    inputs: ["Run 0042", "Source: registration.c", "Isolated run workspace"],
    output: "Source mounted read-only.",
    attempt: "Workspace ready",
    next: "Baseline write and network access attempts were blocked in this example run.",
    action: "Inspect run overview",
    view: "Overview",
  },
];
export default function AgentActivity({
  selected,
  onSelect,
  onInspect,
}: {
  selected: number;
  onSelect: (value: number) => void;
  onInspect: (view: string) => void;
}) {
  const inspector = inspectors[selected];
  return (
    <>
      <div className="aa-details">
        <section
          className="aa-timeline ws-panel"
          aria-labelledby="timeline-title"
        >
          <img className="ws-trim" src="/design/activity/1a568.svg" alt="" />
          <h2 id="timeline-title">Execution timeline</h2>
          <p>Observable actions, outputs and retries</p>
          <ol>
            {activityEvents.map((event) => (
              <li key={event.time}>
                <button
                  className="aa-event"
                  onClick={() => onSelect(event.selection)}
                  aria-pressed={selected === event.selection}
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
                  <span className="aa-event-detail">{event.detail}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section
          className="aa-inspector ws-panel"
          aria-labelledby="inspector-title"
        >
          <img className="ws-trim" src="/design/activity/61a53.svg" alt="" />
          <span
            className={`ws-badge aa-agent-badge ${selected === 2 ? "ws-running" : selected === 3 ? "ws-waiting" : "ws-complete"}`}
          >
            {inspector.label}
          </span>
          <h2 id="inspector-title">{inspector.title}</h2>
          <h3 className="aa-task-label">Current task</h3>
          <p className="aa-task">{inspector.task}</p>
          <hr />
          <h3 className="aa-section-label">INPUTS</h3>
          <ul className="aa-inputs">
            {inspector.inputs.map((input) => (
              <li key={input}>{input}</li>
            ))}
          </ul>
          <h3 className="aa-section-label">LATEST OUTPUT</h3>
          <p className="aa-output">{inspector.output}</p>
          <span className="ws-badge aa-attempt">{inspector.attempt}</span>
          <p className="aa-next">{inspector.next}</p>
          <Button
            variant="neutral"
            size="small"
            onPress={() => onInspect(inspector.view)}
          >
            {inspector.action}
          </Button>
        </section>
      </div>
      <section
        className="aa-security ws-panel"
        aria-labelledby="security-title"
      >
        <h2 id="security-title">Security &amp; red-team checks</h2>
        <p>
          1 medium finding requires review · Baseline write attempt blocked ·
          Network access attempt blocked
        </p>
      </section>
    </>
  );
}
