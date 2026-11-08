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

import type { ReactNode } from 'react';
import { SpacetimeDBProvider, useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, reducers, tables } from './module_bindings';

const URI = import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com';
const DB = import.meta.env.VITE_STDB_DB ?? 'legacy-data';
const TOKEN_KEY = `stdb-token:${DB}`;

function savedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Each browser gets its own identity (not a writer). It can read public
// tables and approve rules; every other write is rejected by the module.
const connectionBuilder = DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .withToken(savedToken())
  .onConnect((_conn, _identity, token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private window: a new identity next time is fine */
    }
  })
  .onConnectError((_ctx, err) => console.error('SpacetimeDB connection failed:', err));

export function StdbProvider({ children }: { children: ReactNode }) {
  return <SpacetimeDBProvider connectionBuilder={connectionBuilder}>{children}</SpacetimeDBProvider>;
}

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
