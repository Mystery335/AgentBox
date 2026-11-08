// Nemotron access for the agents: retries, an on-disk response cache, and a
// generic tool-calling loop. All calls go through the SpacetimeDB
// nemotron_chat procedure, so the API key never reaches this process.
//
// Cache: .cache/nemotron/<sha256 of the request>.json. Same request -> same
// answer, so re-runs are free and a demo can be replayed exactly. Set
// NEMOTRON_CACHE=0 to bypass it.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT } from './dockerize.ts';
import { StdbError, type Stdb } from './stdb.ts';

const CACHE_DIR = path.join(AGENTBOX_ROOT, '.cache', 'nemotron');

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatResponse {
  /** Model that actually answered, as reported by NVIDIA. */
  model?: string;
  id?: string;
  choices: { finish_reason: string; message: { content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
  /** Set locally when the answer came from .cache/nemotron (not sent by NVIDIA). */
  fromCache?: boolean;
}

export interface ChatRequest {
  messages: Message[];
  tools?: { type: 'function'; function: ToolDef }[];
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  chat_template_kwargs?: { enable_thinking: boolean };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Process-wide throttle: NVIDIA's hosted API limits requests per minute, and
 * the agents run several tasks in parallel. Every real (uncached) call waits
 * for its slot. NEMOTRON_RPM in .env overrides the default.
 */
let nextSlot = 0;
async function throttle(): Promise<void> {
  const rpm = Math.max(1, Number(process.env.NEMOTRON_RPM) || 30);
  const gap = 60_000 / rpm;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}

/** Delay before retry `attempt` (0-based). Rate limits get long waits; other errors short ones. */
export function retryDelay(msg: string, attempt: number): number {
  if (/\b429\b|too many requests/i.test(msg)) return 20_000 * 2 ** Math.min(attempt, 3); // 20 s, 40 s, 80 s, 160 s...
  return 2000 * 2 ** attempt;
}

/** One chat completion with cache, throttling and retries (429 / 5xx / timeouts). */
export async function chat(db: Stdb, request: ChatRequest): Promise<ChatResponse> {
  const body = JSON.stringify(request);
  const key = createHash('sha256').update(body).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.json`);
  const useCache = process.env.NEMOTRON_CACHE !== '0';
  if (useCache && existsSync(file)) return { ...(JSON.parse(await readFile(file, 'utf8')) as ChatResponse), fromCache: true };

  let lastError: unknown;
  let send: ChatRequest = request;
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    try {
      const res = (await db.nemotronChat(send as { messages: unknown[] })) as ChatResponse;
      if (useCache) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, JSON.stringify(res));
      }
      return res;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = /timed? ?out/i.test(msg);
      const rateLimited = /\b429\b|too many requests/i.test(msg);
      const retryable = timeout || rateLimited || /\b(500|502|503|504)\b|ECONNRESET|fetch failed/i.test(msg);
      if (!retryable || (e instanceof StdbError && /not a writer|not set/.test(msg))) throw e;
      // The same request will most likely time out again (long thinking on a
      // slow API): retry once with thinking off, which answers much faster.
      if (timeout) {
        if (send.chat_template_kwargs?.enable_thinking === false) throw e;
        send = { ...request, chat_template_kwargs: { enable_thinking: false } };
        continue;
      }
      // Other server errors: 4 tries. Rate limits: keep waiting (up to ~5 min in total).
      if (!rateLimited && attempt >= 3) throw e;
      await sleep(retryDelay(msg, attempt));
    }
  }
  throw lastError;
}

/**
 * Nemotron often sends array/object arguments as JSON text inside a string
 * ("risks": "[\"a\", \"b\"]"). Decode those (top level and one level into
 * arrays of objects) so a correct answer isn't rejected for its wrapping.
 */
export function decodeNestedJson(args: Record<string, unknown>): Record<string, unknown> {
  const decode = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (!(t.startsWith('[') || t.startsWith('{'))) return v;
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const d = decode(v);
    out[k] = Array.isArray(d) ? d.map(x => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, decode(vv)])) : decode(x))) : d;
  }
  return out;
}

export interface ToolLoopOptions {
  /** Repairs an answer before validation (fill defaults, fix obvious slips). */
  normalize?: (args: Record<string, unknown>) => Record<string, unknown>;
  db: Stdb;
  system: string;
  user: string;
  tools: ToolDef[];
  /** Runs a non-final tool; the returned string goes back to the model. */
  handle: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The tool whose arguments are the agent's answer; calling it ends the loop. */
  finalTool: string;
  /** Validates the final answer; return an error message to make the model fix it. May be async. */
  validate?: (args: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
  maxTurns?: number;
  maxTokens?: number;
  /** Called for every tool call (for live agent_event logging). */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called when a final answer is rejected by `validate` (the model then retries). */
  onReject?: (problem: string) => void;
  /** false = Nemotron answers without its reasoning phase (faster, shorter replies). Default: on. */
  thinking?: boolean;
}

export interface ToolLoopResult {
  answer: Record<string, unknown>;
  turns: number;
  toolCalls: number;
  /** Proof of which model did the work: model names NVIDIA reported, and token usage. */
  models: string[];
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** How many of the turns were answered from the local cache. */
  cachedTurns: number;
}

/**
 * Runs the model with tools until it calls `finalTool` with valid arguments.
 * Bad JSON or failed validation is sent back as a tool error so the model can
 * correct itself. Near the turn limit the final tool is forced.
 */
export async function runToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxTurns = o.maxTurns ?? 12;
  const messages: Message[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: o.user },
  ];
  const tools = o.tools.map(t => ({ type: 'function' as const, function: t }));
  let toolCalls = 0;
  let reasoningTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTurns = 0;
  const models = new Set<string>();
  const result = (answer: Record<string, unknown>, turns: number): ToolLoopResult => ({
    answer, turns, toolCalls, models: [...models], promptTokens, completionTokens, reasoningTokens, cachedTurns,
  });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const forceFinal = turn >= maxTurns - 1;
    const res = await chat(o.db, {
      messages,
      tools,
      tool_choice: forceFinal ? { type: 'function', function: { name: o.finalTool } } : 'auto',
      max_tokens: o.maxTokens ?? 12000,
      temperature: 0,
      ...(o.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    });
    reasoningTokens += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    promptTokens += res.usage?.prompt_tokens ?? 0;
    completionTokens += res.usage?.completion_tokens ?? 0;
    if (res.model) models.add(res.model);
    if (res.fromCache) cachedTurns++;
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Nemotron returned no choices');
    const calls = msg.tool_calls ?? [];
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });

    if (calls.length === 0) {
      const cutOff = res.choices[0]?.finish_reason === 'length';
      messages.push({
        role: 'user',
        content: cutOff
          ? `Your reply was cut off before you made a tool call. Keep your thinking short and make the next tool call now. When you are done, call ${o.finalTool}.`
          : `Continue. When you are done, call ${o.finalTool} with your complete answer.`,
      });
      continue;
    }

    for (const call of calls) {
      toolCalls++;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'ERROR: arguments were not valid JSON. Call the tool again with valid JSON.' });
        continue;
      }
      args = decodeNestedJson(args);
      o.onToolCall?.(call.function.name, args);

      if (call.function.name === o.finalTool) {
        if (o.normalize) args = o.normalize(args);
        const problem = await o.validate?.(args);
        if (!problem) return result(args, turn);
        o.onReject?.(problem);
        messages.push({ role: 'tool', tool_call_id: call.id, content: `REJECTED: ${problem}. Fix it and call ${o.finalTool} again.` });
        continue;
      }
      let out: string;
      try {
        out = await o.handle(call.function.name, args);
      } catch (e) {
        out = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  throw new Error(`agent did not call ${o.finalTool} within ${maxTurns} turns`);
}
