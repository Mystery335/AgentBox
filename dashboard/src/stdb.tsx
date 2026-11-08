// SpacetimeDB connection and hooks for the dashboard.
// Settings come from AgentBox/.env (VITE_STDB_URI, VITE_STDB_DB); see vite.config.ts.
// Bindings in ./module_bindings are generated:
//   spacetime generate --lang typescript --out-dir dashboard/src/module_bindings --module-path spacetimedb
//
// Usage: wrap the app in <StdbProvider> (done in main.tsx), then in any component:
//   const [summaries] = useRunSummaries();       // one row per run, computed on the server
//   const workerOnline = useWorkerOnline();
//   const [events] = useRunEvents(runId);
//   const approve = useApproveRule();  await approve(ruleId);

import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';

/** True once the WebSocket is connected. */
export function useConnected(): boolean {
  return useSpacetimeDB().isActive;
}

/** All runs, newest first. */
export function useRuns() {
  const [rows, ready] = useTable(tables.run);
  const sorted = [...rows].sort((a, b) => Number(b.startedAt.microsSinceUnixEpoch - a.startedAt.microsSinceUnixEpoch));
  return [sorted, ready] as const;
}

/** Server-computed summary per run (tests, holdout, rules, debug attempts). */
export function useRunSummaries() {
  return useTable(tables.run_summary);
}

export function useRunSummary(runId: string | undefined) {
  const [rows, ready] = useRunSummaries();
  return [rows.find(r => r.runId === runId), ready] as const;
}

/** True if any worker identity is connected over WebSocket. */
export function useWorkerOnline(): boolean {
  const [rows] = useTable(tables.worker_presence);
  return rows.some(r => r.online);
}

/** Agent events for one run, oldest first. */
export function useRunEvents(runId: string) {
  const [rows, ready] = useTable(tables.agent_event.where(r => r.runId.eq(runId)));
  const sorted = [...rows].sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch));
  return [sorted, ready] as const;
}

export function useRunRules(runId: string) {
  return useTable(tables.rule.where(r => r.runId.eq(runId)));
}

/** Approve a rule (only works on verified, fixed or unresolved rules). */
export function useApproveRule() {
  const update = useReducer(reducers.updateRuleStatus);
  return (ruleId: string) => update({ ruleId, status: 'approved' });
}

export function useConnectionStatus() { return useSpacetimeDB(); }

/** Validation evidence scoped to a single run. */
export function useRunTestCases(runId: string) {
  return useTable(tables.test_case.where(row => row.runId.eq(runId)));
}
export function useRunTestResults(runId: string) {
  return useTable(tables.test_result.where(row => row.runId.eq(runId)));
}
export function useRunDebugAttempts(runId: string) {
  return useTable(tables.debug_attempt.where(row => row.runId.eq(runId)));
}
