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
  choices: { finish_reason: string; message: { content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
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

/** One chat completion with cache and retries (429 / 5xx / timeouts). */
export async function chat(db: Stdb, request: ChatRequest): Promise<ChatResponse> {
  const body = JSON.stringify(request);
  const key = createHash('sha256').update(body).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.json`);
  const useCache = process.env.NEMOTRON_CACHE !== '0';
  if (useCache && existsSync(file)) return JSON.parse(await readFile(file, 'utf8')) as ChatResponse;

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = (await db.nemotronChat(request as { messages: unknown[] })) as ChatResponse;
      if (useCache) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, JSON.stringify(res));
      }
      return res;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /\b(429|500|502|503|504)\b|timed? ?out|ECONNRESET|fetch failed/i.test(msg);
      if (!retryable || (e instanceof StdbError && /not a writer|not set/.test(msg))) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export interface ToolLoopOptions {
  db: Stdb;
  system: string;
  user: string;
  tools: ToolDef[];
  /** Runs a non-final tool; the returned string goes back to the model. */
  handle: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The tool whose arguments are the agent's answer; calling it ends the loop. */
  finalTool: string;
  /** Validates the final answer; return an error message to make the model fix it. */
  validate?: (args: Record<string, unknown>) => string | undefined;
  maxTurns?: number;
  maxTokens?: number;
  /** Called for every tool call (for live agent_event logging). */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called when a final answer is rejected by `validate` (the model then retries). */
  onReject?: (problem: string) => void;
}

export interface ToolLoopResult {
  answer: Record<string, unknown>;
  turns: number;
  toolCalls: number;
  reasoningTokens: number;
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

  for (let turn = 1; turn <= maxTurns; turn++) {
    const forceFinal = turn >= maxTurns - 1;
    const res = await chat(o.db, {
      messages,
      tools,
      tool_choice: forceFinal ? { type: 'function', function: { name: o.finalTool } } : 'auto',
      max_tokens: o.maxTokens ?? 12000,
      temperature: 0,
    });
    reasoningTokens += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Nemotron returned no choices');
    const calls = msg.tool_calls ?? [];
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });

    if (calls.length === 0) {
      messages.push({ role: 'user', content: `Continue. When you are done, call ${o.finalTool} with your complete answer.` });
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
      o.onToolCall?.(call.function.name, args);

      if (call.function.name === o.finalTool) {
        const problem = o.validate?.(args);
        if (!problem) return { answer: args, turns: turn, toolCalls, reasoningTokens };
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
