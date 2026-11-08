// SpacetimeDB connection for the dashboard (wrapped around the app in main.tsx).
// Settings come from AgentBox/.env (VITE_STDB_URI, VITE_STDB_DB); see vite.config.ts.
// Bindings in ./module_bindings are generated:
//   spacetime generate --lang typescript --out-dir dashboard/src/module_bindings --module-path spacetimedb
// The live data for the pages is built in liveRun.ts.

import type { ReactNode } from 'react';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';

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
