// Live view of one modernization run, built from SpacetimeDB subscriptions.
// Every page of the workspace reads from useLiveRun(); nothing here is mock
// data. Rows arrive and update over the WebSocket as the worker writes them.

import { useMemo, useSyncExternalStore } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "./module_bindings";

// ------------------------------------------------------- selected run
// Remembered per browser (try/catch: storage can be blocked).
const KEY = "agentbox:selected-run";
const listeners = new Set<() => void>();
let selected: string | null = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();
export function selectRun(id: string) {
  selected = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}
function useSelectedRunPreference() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selected,
  );
}

// -------------------------------------------------------------- types
export type StageStatus = "Complete" | "Running" | "Waiting" | "Failed" | "Not needed";

export interface Stage {
  title: string;
  status: StageStatus;
  detail: string;
}

export interface LiveRule {
  /** Full rule id in the database. */
  key: string;
  /** Short id shown in the UI, e.g. BR-04. */
  id: string;
  name: string;
  description: string;
  status: string;
  before: { start: number; lines: string[] };
  after: { start: number; lines: string[] };
  tests: number;
  failing: number;
}

export interface LiveTest {
  key: string;
  label: string;
  name: string;
  rule: string;
  ruleKey: string;
  split: string;
  kind: string;
  result: "Passed" | "Failed" | "Fixed" | "Waiting";
  output: string;
  input: string;
  legacyOutput: string;
  modernOutput: string;
  history: { attempt: number; passed: boolean }[];
}

export interface LiveEvent {
  key: string;
  time: string;
  agent: string;
  stage: number;
  status: "Complete" | "Running" | "Failed";
  title: string;
}

export interface DocSection {
  title: string;
  paragraphs: string[];
}

interface Verification {
  component?: string;
  legacy_path?: string;
  legacy_source?: string;
  modern_file?: string;
  target?: string;
  target_image?: string;
  legacy_image?: string;
  normalization?: string;
  test_names?: Record<string, string>;
  status?: string;
  reason?: string;
}

interface SystemAnalysis {
  overview?: string;
  architecture?: string;
  target_language?: string;
  target_runtime?: string;
  target_reasons?: string[];
  alternatives?: { language: string; why_not: string }[];
  first_slice?: string[];
  first_slice_reason?: string;
  migration_order?: { step: number; components: string[]; note: string }[];
  risks?: string[];
}

interface ComponentRow {
  name: string;
  path: string;
  verifiable?: boolean;
  deferred_reasons?: string[];
  analysis?: { summary?: string; risks?: string[]; data_layouts?: { name: string; description: string }[] };
}

const parse = <T,>(json: string): T | undefined => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
};
const micros = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const shortRule = (key: string) => key.split(":").pop() || key;
/** Program part of a rule key ("<run>:<PROGRAM>:<rule>"). */
const ruleProgram = (key: string) => {
  const parts = key.split(":");
  return parts.length >= 3 ? parts[parts.length - 2] : "";
};
/** "Attempt 5: debug 0/8, holdout 0/4 identical to legacy" is a failure, not a completed step. */
const notAllIdentical = (message: string) =>
  /identical/i.test(message) &&
  [...message.matchAll(/(\d+)\/(\d+)/g)].some((m) => Number(m[1]) < Number(m[2]));
const slice = (text: string | undefined, start: number, end: number) => {
  if (!text || !start) return [];
  return text.replace(/\r\n?/g, "\n").split("\n").slice(start - 1, Math.max(end, start));
};

const AGENT_STAGE: Record<string, number> = { analyzer: 0, translator: 1, debugger: 2, verifier: 3 };
const AGENT_LABEL: Record<string, string> = {
  analyzer: "ANALYZE",
  translator: "REWRITE",
  debugger: "DEBUG",
  verifier: "VALIDATE",
};

/** First differing line, for the "LEGACY → MODERN" column. */
function diffSummary(legacy: string, modern: string): string {
  if (modern === "[build failed]") return "modern code did not build";
  const a = legacy.split("\n");
  const b = modern.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `differs at line ${i + 1}`;
  }
  return "differs";
}

// --------------------------------------------------------------- hook
export function useLiveRun() {
  const [runRows, runsReady] = useTable(tables.run);
  const runs = useMemo(
    () => [...runRows].sort((a, b) => micros(b.startedAt) - micros(a.startedAt)),
    [runRows],
  );
  const preferred = useSelectedRunPreference();
  // Server-computed counts per run: default to the newest run with something to show.
  const [summaries] = useTable(tables.run_summary);
  const hasContent = (id: string) => summaries.some((s) => s.runId === id && (s.testsTotal > 0 || s.latestAttempt > 0 || s.rulesTotal > 0));
  const real = runs.filter((r) => !r.id.startsWith("smoke-"));
  const run =
    runs.find((r) => r.id === preferred) ??
    real.find((r) => hasContent(r.id) && summaries.some((s) => s.runId === r.id && s.testsTotal > 0)) ??
    real.find((r) => hasContent(r.id)) ??
    real[0] ??
    runs[0];
  const id = run?.id ?? "";

  const [rules] = useTable(tables.rule.where((r) => r.runId.eq(id)));
  const [cases] = useTable(tables.test_case.where((r) => r.runId.eq(id)));
  const [results] = useTable(tables.test_result.where((r) => r.runId.eq(id)));
  const [codes] = useTable(tables.code_version.where((r) => r.runId.eq(id)));
  const [events] = useTable(tables.agent_event.where((r) => r.runId.eq(id)));
  const [debugs] = useTable(tables.debug_attempt.where((r) => r.runId.eq(id)));
  const [analysis] = useTable(tables.analysis.where((r) => r.runId.eq(id)));

  return useMemo(() => {
    const one = <T,>(kind: string) => {
      const row = analysis.find((a) => a.kind === kind);
      return row ? parse<T>(row.json) : undefined;
    };
    const verification = one<Verification>("verification");
    const system = one<SystemAnalysis>("system");
    const components = analysis.filter((a) => a.kind === "component").map((a) => parse<ComponentRow>(a.json)).filter((c): c is ComponentRow => !!c);
    const component = components.find((c) => c.name === verification?.component);

    const latestCode = [...codes].sort((a, b) => b.attempt - a.attempt)[0];
    const latestAttempt = results.reduce((m, r) => Math.max(m, r.attempt), -1);
    const status = run?.status ?? "";
    const finished = status === "ready_for_cutover" || status === "failed";

    // Tests, with per-attempt history.
    const byCase = new Map<string, (typeof results)[number][]>();
    for (const r of results) byCase.set(r.testCaseId, [...(byCase.get(r.testCaseId) ?? []), r]);
    const tests: LiveTest[] = [...cases]
      .sort((a, b) => a.testIndex - b.testIndex)
      .map((c) => {
        const hist = (byCase.get(c.id) ?? []).sort((a, b) => a.attempt - b.attempt);
        const last = hist[hist.length - 1];
        const result: LiveTest["result"] = !last ? "Waiting" : !last.passed ? "Failed" : hist.some((h) => !h.passed) ? "Fixed" : "Passed";
        const modern = last ? (last.passed ? c.legacyOutput : last.modernOutput) : "";
        return {
          key: c.id,
          label: `T-${String(c.testIndex).padStart(2, "0")}`,
          name: verification?.test_names?.[c.id] || `${c.kind} case ${c.testIndex}`,
          rule: c.ruleId ? shortRule(c.ruleId) : "—",
          ruleKey: c.ruleId,
          split: c.split,
          kind: c.kind,
          result,
          output: !last ? "not run yet" : last.passed ? "identical" : diffSummary(c.legacyOutput, last.modernOutput),
          input: c.input,
          legacyOutput: c.legacyOutput,
          modernOutput: modern,
          history: hist.map((h) => ({ attempt: h.attempt, passed: h.passed })),
        };
      });

    // Rules: those of the modernized program when there is one, else all.
    const scoped = verification?.component ? rules.filter((r) => r.id.includes(`:${verification.component}:`)) : rules;
    // Rule ids restart at BR-01 in every program: name the program when several are listed.
    const manyPrograms = new Set(scoped.map((r) => ruleProgram(r.id))).size > 1;
    const liveRules: LiveRule[] = [...scoped]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const mine = tests.filter((t) => t.ruleKey === r.id);
        return {
          key: r.id,
          id: manyPrograms && ruleProgram(r.id) ? `${ruleProgram(r.id)} ${shortRule(r.id)}` : shortRule(r.id),
          name: r.title,
          description: `Given ${r.given}; when ${r.when}; then ${r.then}.`,
          status: r.status,
          before: { start: r.legacyStartLine, lines: slice(verification?.legacy_source, r.legacyStartLine, r.legacyEndLine) },
          after: { start: r.modernStartLine, lines: slice(latestCode?.source, r.modernStartLine, r.modernEndLine) },
          tests: mine.length,
          failing: mine.filter((t) => t.result === "Failed").length,
        };
      });

    // Timeline (newest first).
    const sortedEvents = [...events].sort((a, b) => micros(b.createdAt) - micros(a.createdAt));
    const timeline: LiveEvent[] = sortedEvents.map((e, i) => ({
      key: e.id,
      time: clock(micros(e.createdAt)),
      agent: AGENT_LABEL[e.agent] ?? "SYSTEM",
      stage: AGENT_STAGE[e.agent] ?? 4,
      status: /\bfail|rejected|does not build|differ|timed out/i.test(e.message) || notAllIdentical(e.message) ? "Failed" : i === 0 && !finished && status !== "analyzed" ? "Running" : "Complete",
      title: e.message,
    }));

    // Stages.
    const passed = tests.filter((t) => t.result === "Passed" || t.result === "Fixed").length;
    const ruleCount = rules.length;
    const stages: Stage[] = [
      {
        title: "Analyze & document",
        status: status === "analyzing" ? "Running" : run ? "Complete" : "Waiting",
        detail: `${components.length} program${components.length === 1 ? "" : "s"} · ${ruleCount} rules extracted`,
      },
      {
        title: "Rewrite",
        status: latestCode ? "Complete" : status === "translating" ? "Running" : finished ? "Failed" : "Waiting",
        detail: latestCode
          ? `${run?.legacyLanguage} → ${run?.targetLanguage} · ${verification?.modern_file ?? "1 file"}`
          : `${run?.legacyLanguage ?? "legacy"} → ${run?.targetLanguage || "target not chosen"}`,
      },
      {
        title: "Debug",
        status: status === "debugging" ? "Running" : debugs.length ? (finished ? (status === "failed" ? "Failed" : "Complete") : "Complete") : finished && status === "ready_for_cutover" ? "Not needed" : "Waiting",
        detail: debugs.length
          ? `${debugs.length} attempt${debugs.length === 1 ? "" : "s"} · last: ${[...debugs].sort((a, b) => b.attempt - a.attempt)[0].outcome.replace("_", " ")}`
          : "No repairs yet",
      },
      {
        title: "Validate",
        status: status === "ready_for_cutover" ? "Complete" : status === "failed" && tests.length ? "Failed" : ["verifying", "shadow"].includes(status) ? "Running" : "Waiting",
        detail: tests.length ? `${passed} / ${tests.length} tests match legacy` : "No tests yet",
      },
    ];

    // Documentation from the Analyzer's system and component analysis.
    const sections: DocSection[] = [];
    if (system?.architecture) sections.push({ title: "Architecture", paragraphs: [system.architecture] });
    if (system?.target_language)
      sections.push({
        title: "Target language",
        paragraphs: [
          `${system.target_language}${system.target_runtime ? ` (${system.target_runtime})` : ""}.`,
          ...(system.target_reasons ?? []),
          ...(system.alternatives ?? []).map((a) => `Not ${a.language}: ${a.why_not}`),
        ],
      });
    if (system?.first_slice?.length || system?.migration_order?.length)
      sections.push({
        title: "Migration plan",
        paragraphs: [
          ...(system.first_slice?.length ? [`First slice: ${system.first_slice.join(", ")}. ${system.first_slice_reason ?? ""}`] : []),
          ...(system.migration_order ?? []).map((s) => `Step ${s.step}: ${s.components.join(", ")}. ${s.note}`),
        ],
      });
    const risks = [...(system?.risks ?? []), ...(component?.analysis?.risks ?? [])];
    if (risks.length) sections.push({ title: "Known risks", paragraphs: risks });
    if (verification)
      sections.push({
        title: "Verification",
        paragraphs: [
          verification.reason || "Verification in progress.",
          `Legacy program ran in ${verification.legacy_image}; the ${verification.target} code ran in ${verification.target_image}; both with no network and a read-only file system.`,
          verification.normalization ?? "",
          "A passing test suite shows identical behaviour on these inputs; it does not prove equivalence for every possible input.",
        ].filter(Boolean),
      });

    const doc = {
      title: run?.legacyName ?? "",
      generatedBy: "Analyze & document (Nemotron)",
      sourceRevision: run?.legacySha256.slice(0, 7) ?? "",
      overview: system?.overview || component?.analysis?.summary || "The Analyzer has not written an overview yet.",
      rules: liveRules.map((r) => ({ key: r.key, id: r.id, title: r.name, description: r.description })),
      reviewNotes: "Generated by the agents from the original source. Review inferred rules against the source before release.",
      sections,
      markdown: run?.documentation ?? "",
    };

    const mismatches = tests.filter((t) => t.result === "Failed").length;
    return {
      ready: runsReady,
      runs,
      run,
      status,
      finished,
      verification,
      stages,
      rules: liveRules,
      tests,
      timeline,
      debugs: [...debugs].sort((a, b) => a.attempt - b.attempt),
      changes: [...codes].sort((a, b) => a.attempt - b.attempt),
      latestCode,
      latestAttempt,
      doc,
      metrics: {
        matching: `${passed} / ${tests.length}`,
        mismatches,
        untested: liveRules.filter((r) => r.tests === 0).length,
        debugAttempts: debugs.length,
      },
    };
  }, [runsReady, runs, run, rules, cases, results, codes, events, debugs, analysis]);
}

export type LiveRun = ReturnType<typeof useLiveRun>;

/** Badge text for the run as a whole. */
export function runBadge(status: string): string {
  if (status === "ready_for_cutover") return "Complete";
  if (status === "failed") return "Failed";
  if (status === "analyzed") return "Waiting";
  if (!status) return "Waiting";
  return "Running";
}

/** Human label for a run status. */
export function statusLabel(status: string): string {
  return (
    {
      analyzing: "Analyzing",
      analyzed: "Analyzed · awaiting translation",
      translating: "Translating",
      verifying: "Verifying",
      debugging: "Debugging",
      shadow: "Shadow run",
      // Identical on the tested inputs only; not a proof of equivalence.
      ready_for_cutover: "All tested cases match",
      failed: "Failed",
    } as Record<string, string>
  )[status] ?? status;
}
