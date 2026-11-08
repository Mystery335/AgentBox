// SpacetimeDB HTTP client for the agent worker.
//
// Settings from AgentBox/.env: STDB_HOST, STDB_DB, STDB_TOKEN.
// Argument order of each method matches the reducer in spacetimedb/src/index.ts.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { AGENTBOX_ROOT } from './dockerize.ts';

export class StdbError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export function loadEnv(file = path.join(AGENTBOX_ROOT, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface TestCaseInput {
  id: string;
  test_index: number;
  split: 'debug' | 'holdout' | 'shadow';
  kind: 'boundary' | 'random' | 'regression' | 'existing';
  origin: 'existing' | 'generated';
  rule_id: string;
  input: string;
  legacy_output: string;
}

export interface TestResultInput {
  test_case_id: string;
  passed: boolean;
  modern_output: string;
}

export type Row = Record<string, unknown>;

export class Stdb {
  readonly host: string;
  readonly db: string;
  #token: string;

  constructor(opts: { host?: string; db?: string; token?: string } = {}) {
    loadEnv();
    this.host = (opts.host ?? process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
    this.db = opts.db ?? process.env.STDB_DB ?? 'legacy-data';
    this.#token = opts.token ?? process.env.STDB_TOKEN ?? '';
  }

  #headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.#token) h.Authorization = `Bearer ${this.#token}`;
    return h;
  }

  /** Calls a reducer; throws StdbError with the server's message if it is rejected. */
  async call(reducer: string, ...args: unknown[]): Promise<void> {
    const url = `${this.host}/v1/database/${encodeURIComponent(this.db)}/call/${reducer}`;
    const res = await fetch(url, { method: 'POST', headers: this.#headers(true), body: JSON.stringify(args) });
    if (!res.ok) {
      throw new StdbError(`${reducer} failed (${res.status}): ${(await res.text()).trim().slice(0, 500)}`, res.status);
    }
  }

  /**
   * Calls a procedure and returns its return value. Same endpoint as reducers;
   * a string return value may come back JSON-encoded, so it is decoded once.
   */
  async callProcedure(name: string, ...args: unknown[]): Promise<string> {
    const url = `${this.host}/v1/database/${encodeURIComponent(this.db)}/call/${name}`;
    const res = await fetch(url, { method: 'POST', headers: this.#headers(true), body: JSON.stringify(args) });
    const text = await res.text();
    if (!res.ok) throw new StdbError(`${name} failed (${res.status}): ${text.trim().slice(0, 500)}`, res.status);
    try {
      const v = JSON.parse(text);
      return typeof v === 'string' ? v : text;
    } catch {
      return text;
    }
  }

  // ---- Nemotron (runs inside the module; the API key never leaves SpacetimeDB)
  nemotronPing = () => this.callProcedure('nemotron_ping');
  /**
   * OpenAI-style chat request; returns NVIDIA's response JSON (parsed).
   * Nemotron 3.5 reasons first and those tokens count against max_tokens, so
   * use a large max_tokens (2000+) or chat_template_kwargs: { enable_thinking: false }.
   */
  nemotronChat = async (request: { messages: unknown[]; [k: string]: unknown }) =>
    JSON.parse(await this.callProcedure('nemotron_chat', JSON.stringify(request))) as {
      choices: {
        finish_reason: string;
        message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: unknown[] };
      }[];
      usage?: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };

  /** Runs SQL; returns rows keyed by column name. */
  async sql(query: string): Promise<Row[]> {
    const url = `${this.host}/v1/database/${encodeURIComponent(this.db)}/sql`;
    const res = await fetch(url, { method: 'POST', headers: this.#headers(false), body: query });
    if (!res.ok) throw new StdbError(`sql failed (${res.status}): ${(await res.text()).trim().slice(0, 500)}`, res.status);
    const results = (await res.json()) as { schema: { elements: { name: unknown }[] }; rows: unknown[][] }[];
    return results.flatMap(r => {
      const names = r.schema.elements.map((e, i) => columnName(e.name) ?? `col${i}`);
      return r.rows.map(row => Object.fromEntries(names.map((n, i) => [n, row[i]])));
    });
  }

  // ---- reducers -------------------------------------------------
  addWriter = (identityHex: string) => this.call('add_writer', identityHex);
  addProgram = (sha256: string, name: string, language: string, dialect: string, source: string) =>
    this.call('add_program', sha256, name, language, dialect, source);
  startRun = (runId: string, legacyName: string, legacyLanguage: string, targetLanguage: string,
              legacySha256: string, legacyRuntime: string, seed: string) =>
    this.call('start_run', runId, legacyName, legacyLanguage, targetLanguage, legacySha256, legacyRuntime, seed);
  setRunStatus = (runId: string, status: string) => this.call('set_run_status', runId, status);
  /** Keeps the run alive for the watchdog (15 min without activity = failed). Call during long steps. */
  heartbeat = (runId: string) => this.call('heartbeat', runId);
  /**
   * Sends a heartbeat every `everyMs` until the returned function is called,
   * so long Docker or Nemotron steps don't trip the watchdog. Failures are
   * ignored (the next beat or any other write also counts as activity).
   */
  keepAlive(runId: string, everyMs = 120_000): () => void {
    const timer = setInterval(() => void this.heartbeat(runId).catch(() => {}), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  setDocumentation = (runId: string, documentation: string) => this.call('set_documentation', runId, documentation);
  addCodeVersion = (runId: string, attempt: number, source: string, sha256: string, lint: string) =>
    this.call('add_code_version', runId, attempt, source, sha256, lint);
  addRule = (ruleId: string, runId: string, title: string, given: string, when_: string, then_: string,
             legacyStart: number, legacyEnd: number, modernStart: number, modernEnd: number, disposition: string) =>
    this.call('add_rule', ruleId, runId, title, given, when_, then_, legacyStart, legacyEnd, modernStart, modernEnd, disposition);
  updateRuleStatus = (ruleId: string, status: string) => this.call('update_rule_status', ruleId, status);
  addTestCases = (runId: string, cases: TestCaseInput[]) => this.call('add_test_cases', runId, cases);
  addTestResults = (runId: string, attempt: number, results: TestResultInput[]) =>
    this.call('add_test_results', runId, attempt, results);
  addChange = (changeId: string, runId: string, attempt: number, agent: string, ruleId: string,
               summary: string, reason: string, diff: string) =>
    this.call('add_change', changeId, runId, attempt, agent, ruleId, summary, reason, diff);
  addDebugAttempt = (id: string, runId: string, attempt: number, errorSummary: string, diagnosis: string,
                     fixSummary: string, passedCount: number, totalCount: number, outcome: string) =>
    this.call('add_debug_attempt', id, runId, attempt, errorSummary, diagnosis, fixSummary, passedCount, totalCount, outcome);
  logEvent = (eventId: string, runId: string, agent: string, message: string) =>
    this.call('log_event', eventId, runId, agent, message);
  finishRun = (runId: string, status: string) => this.call('finish_run', runId, status);
  addAnalysis = (runId: string, kind: 'system' | 'inventory' | 'component' | 'runtime' | 'verification', key: string, json: unknown) =>
    this.call('add_analysis', runId, kind, key, JSON.stringify(json));
  setRuleModernLines = (ruleId: string, start: number, end: number) => this.call('set_rule_modern_lines', ruleId, start, end);
  setTargetLanguage = (runId: string, targetLanguage: string) => this.call('set_target_language', runId, targetLanguage);
  /** Permanently deletes a run and all its rows (and its program if unused). */
  deleteRun = (runId: string) => this.call('delete_run', runId);
}

function columnName(name: unknown): string | undefined {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object' && 'some' in name) return String((name as { some: unknown }).some);
  return undefined;
}

/** POST /v1/identity: a new identity + token for the worker. */
export async function newIdentity(host?: string): Promise<{ identity: string; token: string }> {
  loadEnv();
  const h = (host ?? process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
  const res = await fetch(`${h}/v1/identity`, { method: 'POST' });
  if (!res.ok) throw new StdbError(`identity failed (${res.status}): ${await res.text()}`, res.status);
  return (await res.json()) as { identity: string; token: string };
}
