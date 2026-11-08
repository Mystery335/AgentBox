// Nemotron agents for the modernize stage: Translator, test writer (part of
// the Verifier) and Debugger. Each is one tool loop whose final tool call is
// the answer; bad answers are sent back to the model to fix (runToolLoop).
//
// The legacy source, its includes and called programs, the business rules and
// the Analyzer's notes are put straight into the prompt, so no file tools are
// needed and each agent finishes in one or two turns.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runToolLoop, type ToolLoopResult } from '../llm.ts';
import type { Stdb } from '../stdb.ts';
import type { ComponentAnalysis } from '../analyzer/agent.ts';
import { RUN_CONTRACT, type TargetProfile } from '../translator/targets.ts';
import { shortRuleId } from '../translator/agent.ts';

// ------------------------------------------------------------- inputs
/** A component row as the Analyzer stored it (analysis kind "component"). */
export interface StoredComponent {
  name: string;
  path: string;
  language: string;
  lines: number;
  role?: string;
  includes: { name: string; file?: string }[];
  calls: { name: string; file?: string }[];
  file_io: { name: string; assign: string }[];
  takes_parameters: boolean;
  compile?: { status: string; command?: string; error?: string };
  verifiable: boolean;
  rule_ids: string[];
  analysis?: ComponentAnalysis;
}

export interface RuleRow {
  id: string;
  title: string;
  given: string;
  when_: string;
  then_: string;
  legacy_start_line: number;
  legacy_end_line: number;
}

export interface LegacyContext {
  component: StoredComponent;
  source: string;
  /** Copybooks/headers and called programs, by project path. */
  extras: { path: string; text: string }[];
  rules: RuleRow[];
}

const MAX_EXTRAS_CHARS = 40_000;

/** Reads the program, its includes and the programs it calls from the extracted project. */
export async function loadLegacyContext(projectDir: string, component: StoredComponent, rules: RuleRow[]): Promise<LegacyContext> {
  const read = (rel: string) => readFile(path.join(projectDir, rel), 'utf8');
  const source = await read(component.path);
  const extras: { path: string; text: string }[] = [];
  let budget = MAX_EXTRAS_CHARS;
  const files = [...component.includes, ...component.calls].map(x => x.file).filter((f): f is string => !!f && f !== component.path);
  for (const f of [...new Set(files)]) {
    try {
      const text = await read(f);
      if (text.length > budget) break;
      budget -= text.length;
      extras.push({ path: f, text });
    } catch {
      /* missing file: the Analyzer already marks those */
    }
  }
  return { component, source, extras, rules };
}

export const numbered = (text: string) =>
  text.replace(/\r\n?/g, '\n').split('\n').map((l, i) => `${String(i + 1).padStart(4, ' ')}| ${l}`).join('\n');

function legacyBlock(ctx: LegacyContext): string {
  const c = ctx.component;
  const a = c.analysis;
  const parts = [
    `## Legacy program ${c.name} (${c.language}, ${c.path})`,
    '```',
    numbered(ctx.source),
    '```',
  ];
  for (const e of ctx.extras) parts.push(`## Included/called file ${e.path}`, '```', e.text, '```');
  if (ctx.rules.length) {
    parts.push('## Business rules (from the Analyzer)');
    for (const r of ctx.rules) {
      parts.push(`- ${shortRuleId(r.id)}: ${r.title}. Given ${r.given}; when ${r.when_}; then ${r.then_}. (legacy lines ${r.legacy_start_line}-${r.legacy_end_line})`);
    }
  }
  if (a) {
    parts.push('## Analyzer notes', `Summary: ${a.summary}`);
    if (a.inputs?.length) parts.push(`Inputs: ${a.inputs.map(i => `${i.name}: ${i.description}`).join('; ')}`);
    if (a.outputs?.length) parts.push(`Outputs: ${a.outputs.map(o => `${o.name}: ${o.description}`).join('; ')}`);
    if (a.data_layouts?.length) parts.push(`Data layouts: ${a.data_layouts.map(d => `${d.name}: ${d.description}`).join('; ')}`);
    if (a.modernization_notes) parts.push(`Modernization notes: ${a.modernization_notes}`);
  }
  return parts.join('\n');
}

const stripFences = (code: string) => {
  const m = code.match(/^\s*```[\w+-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : code;
};

/** Removes the "   12| " prefixes if the model echoed the numbered listing back (only when every line has one). */
export const stripLineNumbers = (code: string) => {
  const lines = code.split('\n');
  const re = /^ {0,3}\d+\| ?/;
  return lines.filter(l => l.trim()).every(l => re.test(l)) ? lines.map(l => l.replace(re, '')).join('\n') : code;
};

export interface AgentStats {
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTurns: number;
  models: string[];
}
const stats = (r: ToolLoopResult): AgentStats => ({
  turns: r.turns,
  toolCalls: r.toolCalls,
  promptTokens: r.promptTokens,
  completionTokens: r.completionTokens,
  reasoningTokens: r.reasoningTokens,
  cachedTurns: r.cachedTurns,
  models: r.models,
});

/**
 * What the Debugger is told about the code it fixes: the program file it may
 * change, how it is run, and the shared records module it imports (read-only;
 * fixes go in the program file).
 */
export interface ModernTarget {
  profile: TargetProfile;
  /** The program file, e.g. paycalc.py. */
  file: string;
  /** Shared records module, as shown to the model (relevant sections). */
  shared: { fileName: string; text: string };
}

function contract(t: ModernTarget): string {
  return [
    `Fix ONE ${t.profile.label} file named ${t.file}. It is run as: ${t.profile.run(t.file)}`,
    `It imports the shared module ${t.shared.fileName}, which is read-only for you: do not redefine its types, and do not paste it into ${t.file}.`,
    RUN_CONTRACT,
    'The sandbox has no network and a read-only file system: do not open sockets or import third-party packages.',
    'The file must compile: declare every helper you call, import what you use, and handle or declare checked exceptions.',
    `Language conventions:\n${t.profile.conventions}`,
  ].join('\n');
}

/** Line-by-line comparison with visible spaces, for the Debugger. Exported for tests. */
export function lineDiff(expected: string, actual: string, max = 8): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length) && out.length < max; i++) {
    if (e[i] === a[i]) continue;
    const col = e[i] !== undefined && a[i] !== undefined ? [...e[i]].findIndex((ch, j) => ch !== a[i][j]) : -1;
    out.push(
      `line ${i + 1}${col >= 0 ? ` (first difference at column ${col + 1})` : ''}:\n  expected ${e[i] === undefined ? '(no line)' : JSON.stringify(e[i])}\n  actual   ${a[i] === undefined ? '(no line)' : JSON.stringify(a[i])}`
    );
  }
  return out.join('\n') || '(outputs look the same line by line; check trailing output or the exit code)';
}

/** Basic shape checks per language. Exported for tests. */
export function validCode(code: unknown, t: ModernTarget): string | undefined {
  if (typeof code !== 'string' || code.trim().length < 20) return 'code is missing or too short';
  const cls = t.file.replace(/\.[^.]+$/, '');
  if (t.profile.id === 'java' && !new RegExp(String.raw`\bclass\s+${cls}\b`).test(code)) return `Java code must declare class ${cls}`;
  if (t.profile.id === 'go' && !/^\s*package\s+main\b/m.test(code)) return 'Go code must be package main';
  return undefined;
}

// --------------------------------------------------------- test writer
export const KINDS = ['boundary', 'random', 'regression'] as const;
export interface GeneratedCase {
  name: string;
  input: string;
  rule_id: string;
  kind: (typeof KINDS)[number];
}

export async function writeTests(db: Stdb, ctx: LegacyContext, onReject?: (p: string) => void): Promise<{ cases: GeneratedCase[]; stats: AgentStats }> {
  const ruleIds = new Set(ctx.rules.map(r => r.id));
  const r = await runToolLoop({
    db,
    system:
      'You are the test designer inside the Verifier agent of AgentProof. You write test INPUTS only: the legacy program itself is run on them to record the expected outputs, so you never predict outputs. ' +
      'Good tests exercise every business rule, its boundaries (just below, at, just above each limit), invalid input and error paths, and a few realistic mixed cases. Answer by calling submit_tests.',
    user: [
      legacyBlock(ctx),
      '## Your task',
      'Write 10 to 16 test cases. Each `input` is the COMPLETE text fed to the program on standard input (use \\n between lines, end with a newline, and include any terminator line the program expects, such as END, so it never waits for more input).',
      'Respect the exact input format the program reads (fixed columns, widths, zero padding).',
      `rule_id: the rule the case targets (one of: ${[...ruleIds].map(shortRuleId).join(', ') || 'none'}), or "" for a general case. kind: boundary, random or regression.`,
    ].join('\n\n'),
    tools: [
      {
        name: 'submit_tests',
        description: 'Submit the test inputs.',
        parameters: {
          type: 'object',
          properties: {
            cases: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  input: { type: 'string' },
                  rule_id: { type: 'string' },
                  kind: { type: 'string', enum: [...KINDS] },
                },
                required: ['name', 'input', 'rule_id', 'kind'],
              },
            },
          },
          required: ['cases'],
        },
      },
    ],
    finalTool: 'submit_tests',
    handle: async () => 'ERROR: only submit_tests is available',
    normalize: a => ({
      cases: (Array.isArray(a.cases) ? a.cases : []).map((c: Record<string, unknown>) => ({
        name: String(c.name ?? '').slice(0, 120),
        input: typeof c.input === 'string' ? c.input : '',
        // The prompt shows short ids; map answers back to the full rule id.
        rule_id: ruleIds.has(String(c.rule_id)) ? String(c.rule_id) : [...ruleIds].find(id => shortRuleId(id) === String(c.rule_id)) ?? '',
        kind: (KINDS as readonly string[]).includes(String(c.kind)) ? String(c.kind) : 'random',
      })),
    }),
    validate: a => {
      const cases = a.cases as GeneratedCase[];
      if (cases.length < 6) return `only ${cases.length} cases; write 10 to 16`;
      if (cases.length > 24) return `${cases.length} cases is too many; write 10 to 16`;
      const seen = new Set<string>();
      for (const c of cases) {
        if (seen.has(c.input)) return `two cases have the same input ("${c.name}"); make every input different`;
        seen.add(c.input);
        if (c.input.length > 20_000) return `case "${c.name}" input is too long`;
      }
      return undefined;
    },
    onReject,
    maxTurns: 5,
    maxTokens: 16000,
  });
  return { cases: r.answer.cases as GeneratedCase[], stats: stats(r) };
}

// ------------------------------------------------------------ debugger
export interface Failure {
  name: string;
  input: string;
  expected: string;
  actual: string;
  stderr: string;
}

export interface Fix {
  code: string;
  diagnosis: string;
  fix_summary: string;
  stats: AgentStats;
}

export async function debugFix(
  db: Stdb,
  ctx: LegacyContext,
  target: ModernTarget,
  o: { code: string; attempt: number; buildLog?: string; failures: Failure[]; history: string[] },
  onReject?: (p: string) => void
): Promise<Fix> {
  const failText = o.buildLog
    ? `The code does NOT build:\n\`\`\`\n${o.buildLog.slice(0, 3000)}\n\`\`\``
    : o.failures
        .slice(0, 5)
        .map(
          (f, i) =>
            `### Failing case ${i + 1}: ${f.name}\nstdin: ${JSON.stringify(f.input.slice(0, 1500))}\nDifferences (JSON-quoted so spaces are visible):\n${lineDiff(f.expected, f.actual)}` +
            (f.stderr.trim() ? `\nstderr:\n\`\`\`\n${f.stderr.slice(0, 800)}\n\`\`\`` : '')
        )
        .join('\n\n');
  const r = await runToolLoop({
    db,
    system:
      'You are the Debugger agent of AgentProof. The modern translation of a legacy program does not yet behave identically. ' +
      'Find the root cause by comparing expected and actual output against the legacy source, then fix the code. Fix the cause in general, not just the shown inputs: other hidden tests check the same rules. ' +
      'Change only what is needed. Answer by calling submit_fix with the COMPLETE corrected file.',
    user: [
      legacyBlock(ctx),
      '## Contract',
      contract(target),
      `## Shared module ${target.shared.fileName} (read-only; the parts this program uses)`,
      '```',
      target.shared.text,
      '```',
      `## Current modern code (${target.file}, debug attempt ${o.attempt})`,
      '```',
      numbered(o.code),
      '```',
      '## What is wrong',
      failText,
      o.history.length ? `## Earlier attempts (did not fully work)\n${o.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
    ].join('\n\n'),
    tools: [
      {
        name: 'submit_fix',
        description: 'Submit the corrected complete source file.',
        parameters: {
          type: 'object',
          properties: {
            diagnosis: { type: 'string', description: 'Root cause, in one or two sentences.' },
            fix_summary: { type: 'string', description: 'What you changed.' },
            code: { type: 'string', description: `Complete corrected ${target.file} (without line numbers)` },
          },
          required: ['diagnosis', 'fix_summary', 'code'],
        },
      },
    ],
    finalTool: 'submit_fix',
    handle: async () => 'ERROR: only submit_fix is available',
    normalize: a => ({ ...a, code: typeof a.code === 'string' ? stripLineNumbers(stripFences(a.code)) : a.code }),
    validate: a => {
      const bad = validCode(a.code, target);
      if (bad) return bad;
      if (String(a.code).trim() === o.code.trim()) return 'the code is unchanged; change it to fix the failures';
      return undefined;
    },
    onReject,
    maxTurns: 5,
    maxTokens: 12000,
    thinking: false,
  });
  return { code: String(r.answer.code), diagnosis: String(r.answer.diagnosis ?? ''), fix_summary: String(r.answer.fix_summary ?? ''), stats: stats(r) };
}
