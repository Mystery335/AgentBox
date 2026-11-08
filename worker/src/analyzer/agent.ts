// The Analyzer agent: Nemotron with project tools. It decides which files to
// read (includes, called programs, job control, DDL) and ends by submitting a
// structured analysis that the code validates before accepting.
//
// Two steps:
//   analyzeComponent  one program -> summary, I/O, business rules with line
//                     ranges, data layouts, risks
//   analyzeSystem     all programs -> overview, target language + reasons,
//                     first slice (verifiable programs only), migration order

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runToolLoop, type ToolDef, type ToolLoopResult } from '../llm.ts';

/** What the model did for one step: proof that Nemotron produced the answer. */
export interface LlmStats {
  models: string[];
  turns: number;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_turns: number;
}
const stats = (r: ToolLoopResult): LlmStats => ({
  models: r.models,
  turns: r.turns,
  tool_calls: r.toolCalls,
  prompt_tokens: r.promptTokens,
  completion_tokens: r.completionTokens,
  reasoning_tokens: r.reasoningTokens,
  cached_turns: r.cachedTurns,
});
import type { Stdb } from '../stdb.ts';
import type { Component, InventoryFile, ScanResult } from './scan.ts';

// ------------------------------------------------------------- types
export interface BusinessRule {
  title: string;
  given: string;
  when: string;
  then: string;
  start_line: number;
  end_line: number;
  disposition: 'keep' | 'review' | 'drop_candidate';
  disposition_reason: string;
}

export interface ComponentAnalysis {
  summary: string;
  inputs: { name: string; description: string }[];
  outputs: { name: string; description: string }[];
  business_rules: BusinessRule[];
  data_layouts: { name: string; defined_in: string; description: string }[];
  risks: string[];
  modernization_notes: string;
}

export interface SystemAnalysis {
  overview: string;
  architecture: string;
  target_language: string;
  target_runtime: string;
  target_reasons: string[];
  alternatives: { language: string; why_not: string }[];
  first_slice: string[];
  first_slice_reason: string;
  migration_order: { step: number; components: string[]; note: string }[];
  existing_tests: string;
  risks: string[];
}

// ------------------------------------------------------------- tools
export class ProjectView {
  readonly #byPath: Map<string, InventoryFile>;
  constructor(readonly extractDir: string, readonly scan: ScanResult) {
    this.#byPath = new Map(scan.inventory.map(f => [f.path, f]));
  }

  /** Reads a project file by its inventory path (never outside the project). */
  async text(rel: string): Promise<string> {
    const f = this.#byPath.get(rel);
    if (!f) throw new Error(`no such file in the project: ${rel}. Use list_files to see paths.`);
    if (f.kind === 'binary') throw new Error(`${rel} is a binary file`);
    return readFile(path.join(this.extractDir, this.scan.root, rel), 'utf8');
  }

  async numbered(rel: string, start = 1, end = Number.MAX_SAFE_INTEGER): Promise<string> {
    const lines = (await this.text(rel)).split(/\r?\n/);
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(lines.length, Math.floor(end), s + 399);
    const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n');
    const more = e < lines.length ? `\n... (${lines.length - e} more lines; read with start_line=${e + 1})` : '';
    return `${rel} lines ${s}-${e} of ${lines.length}\n${body}${more}`;
  }

  async search(pattern: string, pathPrefix = ''): Promise<string> {
    if (pattern.length > 200) throw new Error('pattern too long');
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      throw new Error('invalid regular expression');
    }
    const hits: string[] = [];
    for (const f of this.scan.inventory) {
      if (f.kind === 'binary' || !f.path.startsWith(pathPrefix)) continue;
      const lines = (await this.text(f.path)).split(/\r?\n/);
      lines.forEach((l, i) => {
        if (hits.length < 60 && re.test(l)) hits.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 160)}`);
      });
      if (hits.length >= 60) break;
    }
    return hits.length ? hits.join('\n') + (hits.length >= 60 ? '\n... (more matches truncated)' : '') : 'no matches';
  }

  list(prefix = ''): string {
    const rows = this.scan.inventory.filter(f => f.path.startsWith(prefix)).map(f => `${f.path}  [${f.kind}${f.language ? `, ${f.language}` : ''}, ${f.lines} lines]`);
    return rows.length ? rows.slice(0, 200).join('\n') : 'no files under that prefix';
  }
}

const PROJECT_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a project file with line numbers (max 400 lines per call). Use it for includes/copybooks, called programs, job control and DDL.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path, as shown by list_files' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_project',
    description: 'Case-insensitive regex search over all text files. Returns path:line: text (max 60 hits).',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path_prefix: { type: 'string', description: 'Only search under this folder' } },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'List project files with their kind, language and line count.',
    parameters: { type: 'object', properties: { prefix: { type: 'string', description: 'Folder prefix, e.g. "src/copybook/"' } } },
  },
];

async function handleProjectTool(view: ProjectView, name: string, a: Record<string, unknown>): Promise<string> {
  if (name === 'read_file') return view.numbered(String(a.path ?? ''), Number(a.start_line ?? 1), Number(a.end_line ?? Number.MAX_SAFE_INTEGER));
  if (name === 'search_project') return view.search(String(a.pattern ?? ''), String(a.path_prefix ?? ''));
  if (name === 'list_files') return view.list(String(a.prefix ?? ''));
  throw new Error(`unknown tool ${name}`);
}

// ------------------------------------------------- component analysis
const str = { type: 'string' };
const SUBMIT_COMPONENT: ToolDef = {
  name: 'submit_component_analysis',
  description: 'Submit the finished analysis of this program. Call exactly once, when done.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentences: what the program does, for a business reader' },
      inputs: { type: 'array', items: { type: 'object', properties: { name: str, description: str }, required: ['name', 'description'] } },
      outputs: { type: 'array', items: { type: 'object', properties: { name: str, description: str }, required: ['name', 'description'] } },
      business_rules: {
        type: 'array',
        description: '3-12 concrete, testable behaviours: validations, calculations, rounding, branching, error/return codes, output formats',
        items: {
          type: 'object',
          properties: {
            title: str,
            given: { type: 'string', description: 'Precondition / input situation' },
            when: { type: 'string', description: 'Trigger / condition' },
            then: { type: 'string', description: 'Exact observable result' },
            start_line: { type: 'integer', description: 'First line in THIS program file' },
            end_line: { type: 'integer' },
            disposition: { type: 'string', enum: ['keep', 'review', 'drop_candidate'] },
            disposition_reason: str,
          },
          required: ['title', 'given', 'when', 'then', 'start_line', 'end_line', 'disposition', 'disposition_reason'],
        },
      },
      data_layouts: {
        type: 'array',
        items: { type: 'object', properties: { name: str, defined_in: { type: 'string', description: 'File path where the layout is defined' }, description: str }, required: ['name', 'defined_in', 'description'] },
      },
      risks: { type: 'array', items: str, description: 'Things that make translation or verification hard (packed decimal, REDEFINES, GOTO, platform calls, defects)' },
      modernization_notes: str,
    },
    required: ['summary', 'inputs', 'outputs', 'business_rules', 'data_layouts', 'risks', 'modernization_notes'],
  },
};

const COMPONENT_SYSTEM = `You are the Analyzer agent of AgentProof, a legacy-modernization pipeline.
Your job: understand ONE legacy program precisely enough that another agent can rewrite it in a modern language with identical observable behaviour (same outputs for the same inputs, including rounding, padding, error codes and edge cases).

How to work:
- The program source is given with line numbers. Static scanner facts and the compile result are given too.
- Use the tools to read what the program depends on (included copybooks/headers, called programs, the job control that runs it, DDL). Do not guess a record layout you can read.
- Keep it efficient: read only what you need (usually 1-5 files).
- Cite line ranges from THIS program's file for every business rule.
- Rule disposition: "keep" = normal behaviour; "review" = unclear, contradictory or bug-like (say why); "drop_candidate" = dead or test-only code (paragraph never performed, unreachable branch, hard-coded special case).
- If the code is defective (e.g. missing definitions, wrong columns), say so in risks; analyze the intended behaviour anyway.
- Finish by calling submit_component_analysis exactly once.`;

function componentBrief(c: Component): string {
  return JSON.stringify(
    {
      path: c.path,
      language: c.language,
      program_name: c.name,
      area: c.area,
      lines: c.lines,
      includes: c.includes,
      calls: c.calls,
      file_io: c.facts.fileIO,
      needs: c.facts.embedded,
      entered_with_parameters: c.facts.takesParameters,
      run_by_jobs: c.jobs,
      compile: c.compile,
      verifiable_in_docker: c.verifiable,
      deferred_reasons: c.deferredReasons,
    },
    null,
    1
  );
}

/**
 * Accepts reasonable slips instead of spending a turn on them: missing lists
 * become empty, a single string becomes a one-item list, a reversed line range
 * is swapped, and a missing disposition reason gets a neutral default.
 */
export function normalizeComponent(a: Record<string, unknown>): Record<string, unknown> {
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  const out: Record<string, unknown> = { ...a };
  for (const k of ['inputs', 'outputs', 'data_layouts', 'risks', 'business_rules']) out[k] = list(a[k]);
  out.risks = (out.risks as unknown[]).map(r => (typeof r === 'string' ? r : JSON.stringify(r)));
  out.modernization_notes = typeof a.modernization_notes === 'string' ? a.modernization_notes : '';
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  out.business_rules = (out.business_rules as Record<string, unknown>[]).map(r => {
    if (!r || typeof r !== 'object') return r;
    let s = Number(r.start_line);
    let e = Number(r.end_line);
    if (Number.isInteger(s) && Number.isInteger(e) && e < s) [s, e] = [e, s];
    // Missing disposition = normal behaviour; the model only omits it for ordinary rules.
    const disposition = text(r.disposition) ? text(r.disposition).toLowerCase().replace(/[\s-]+/g, '_') : 'keep';
    const when = text(r.when) || text(r.when_);
    const then = text(r.then) || text(r.then_);
    return {
      ...r,
      title: text(r.title) || text(r.name) || (when ? when.slice(0, 80) : ''),
      when,
      then,
      start_line: s,
      end_line: e,
      disposition,
      disposition_reason:
        text(r.disposition_reason) ||
        (disposition === 'keep' ? 'Normal program behaviour.' : disposition === 'review' ? 'Flagged for human review by the Analyzer.' : 'Looks unused or test-only.'),
    };
  });
  // A rule without its condition or result can't be tested. Drop it rather
  // than rejecting the whole answer, as long as complete rules remain.
  const rules = out.business_rules as Record<string, unknown>[];
  const complete = rules.filter(r => r && typeof r === 'object' && text(r.when) && text(r.then) && text(r.title));
  if (complete.length > 0 && complete.length < rules.length) {
    out.business_rules = complete.map(r => ({ ...r, given: text(r.given) || 'Any input' }));
    (out.risks as string[]).push(`${rules.length - complete.length} incomplete rule(s) were dropped by validation`);
  }
  return out;
}

/** Same idea for the system answer: lists sent as plain text become lists. */
export function normalizeSystem(a: Record<string, unknown>): Record<string, unknown> {
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  const out: Record<string, unknown> = { ...a };
  for (const k of ['target_reasons', 'alternatives', 'first_slice', 'migration_order', 'risks']) out[k] = list(a[k]);
  for (const k of ['overview', 'architecture', 'first_slice_reason', 'existing_tests']) out[k] = typeof a[k] === 'string' ? a[k] : '';
  out.target_reasons = (out.target_reasons as unknown[]).map(String);
  out.risks = (out.risks as unknown[]).map(r => (typeof r === 'string' ? r : JSON.stringify(r)));
  out.alternatives = (out.alternatives as unknown[]).filter(x => x && typeof x === 'object');
  out.migration_order = (out.migration_order as Record<string, unknown>[])
    .filter(x => x && typeof x === 'object')
    .map((m, i) => ({ step: Number(m.step) || i + 1, components: list(m.components).map(String), note: typeof m.note === 'string' ? m.note : '' }));
  return out;
}

export function validateComponent(a: Record<string, unknown>, lines: number, requireRules = false): string | undefined {
  if (typeof a.summary !== 'string' || a.summary.trim().length < 20) return 'summary must be 2-4 sentences';
  const rules = a.business_rules;
  if (!Array.isArray(rules)) return 'business_rules must be an array';
  if (requireRules && rules.length === 0) {
    return 'business_rules is empty, but this program has code: list the concrete behaviours it implements (calculations, validations, branches, outputs)';
  }
  for (const [i, r] of (rules as Record<string, unknown>[]).entries()) {
    for (const k of ['title', 'given', 'when', 'then', 'disposition_reason']) {
      if (typeof r[k] !== 'string' || !(r[k] as string).trim()) return `business_rules[${i}].${k} is missing`;
    }
    const s = Number(r.start_line);
    const e = Number(r.end_line);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s || e > lines) {
      return `business_rules[${i}] line range ${r.start_line}-${r.end_line} is invalid; the file has ${lines} lines`;
    }
    if (!['keep', 'review', 'drop_candidate'].includes(String(r.disposition))) return `business_rules[${i}].disposition must be keep, review or drop_candidate`;
  }
  for (const k of ['inputs', 'outputs', 'data_layouts', 'risks']) if (!Array.isArray(a[k])) return `${k} must be an array`;
  return undefined;
}

export async function analyzeComponent(
  db: Stdb,
  view: ProjectView,
  c: Component,
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onReject?: (problem: string) => void
): Promise<{ analysis: ComponentAnalysis; llm?: LlmStats }> {
  if (c.codeLines === 0) {
    return {
      analysis: { summary: 'The source file is empty; there is no behaviour to analyze or migrate.', inputs: [], outputs: [], business_rules: [], data_layouts: [], risks: ['empty source file'], modernization_notes: 'Nothing to translate.' },
    };
  }
  const source = await view.numbered(c.path, 1, 400);
  const r = await runToolLoop({
    db,
    system: COMPONENT_SYSTEM,
    user: `Scanner facts:\n${componentBrief(c)}\n\nSource:\n${source}`,
    tools: [...PROJECT_TOOLS, SUBMIT_COMPONENT],
    handle: (name, args) => handleProjectTool(view, name, args),
    finalTool: SUBMIT_COMPONENT.name,
    normalize: normalizeComponent,
    validate: a => validateComponent(a, c.lines, c.codeLines > 0),
    maxTurns: 16,
    onToolCall,
    onReject,
  });
  return { analysis: r.answer as unknown as ComponentAnalysis, llm: stats(r) };
}

// ---------------------------------------------------- system analysis
const SUBMIT_SYSTEM: ToolDef = {
  name: 'submit_system_analysis',
  description: 'Submit the system-level analysis and the modernization decision. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      overview: { type: 'string', description: 'What the whole system does, for a business reader (1 paragraph)' },
      architecture: { type: 'string', description: 'How the parts fit: batch vs online, jobs, shared modules, data stores' },
      target_language: { type: 'string', description: 'The ONE modern language to translate into, e.g. "Java 21", "Python 3.12", "C (C17)"' },
      target_runtime: { type: 'string', description: 'Docker base image that runs the translated code, e.g. "eclipse-temurin:21-jdk", "python:3.12-slim", "gcc:14"' },
      target_reasons: { type: 'array', items: str, description: 'Why this language fits THIS system (data types, decimal arithmetic, I/O style, readability)' },
      alternatives: { type: 'array', items: { type: 'object', properties: { language: str, why_not: str }, required: ['language', 'why_not'] } },
      first_slice: { type: 'array', items: str, description: 'Paths of the programs to translate and verify first. ONLY programs marked verifiable.' },
      first_slice_reason: str,
      migration_order: {
        type: 'array',
        items: { type: 'object', properties: { step: { type: 'integer' }, components: { type: 'array', items: str }, note: str }, required: ['step', 'components', 'note'] },
        description: 'Order for the rest, including deferred programs and what must happen before each (e.g. DB2 replacement, missing copybook recovered)',
      },
      existing_tests: { type: 'string', description: 'What existing tests/test data/test programs exist and whether the Verifier can reuse them' },
      risks: { type: 'array', items: str },
    },
    required: ['overview', 'architecture', 'target_language', 'target_runtime', 'target_reasons', 'alternatives', 'first_slice', 'first_slice_reason', 'migration_order', 'existing_tests', 'risks'],
  },
};

const SYSTEM_SYSTEM = `You are the Analyzer agent of AgentProof. You already analyzed each program of a legacy system; now decide how to modernize the whole system.

Decide:
1. The single best modern TARGET LANGUAGE for this system, and a Docker image that runs it. Choose for fit, not fashion: exact decimal arithmetic for money, fixed-width record I/O, how the code is structured, who will maintain it. Example: low-level assembly is best read as C; COBOL financial batch needs exact decimals (BigDecimal / Decimal).
2. The FIRST SLICE: programs to translate and verify first. Only programs marked verifiable (they compile and run in the Docker sandbox) can be verified now. Prefer ones with real business logic and few dependencies.
3. A migration order for everything else, saying what blocks each deferred program.

You can read files with the tools if you need detail (e.g. documentation, job control). Finish by calling submit_system_analysis exactly once.`;

export async function analyzeSystem(
  db: Stdb,
  view: ProjectView,
  components: { c: Component; a?: ComponentAnalysis }[],
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
  onReject?: (problem: string) => void
): Promise<{ system: SystemAnalysis; llm: LlmStats }> {
  const verifiable = new Set(components.filter(x => x.c.verifiable).map(x => x.c.path));
  const scan = view.scan;
  const brief = {
    languages: scan.languages,
    file_kinds: scan.inventory.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {}),
    database_tables: scan.tables,
    existing_test_files: scan.tests,
    documentation_files: scan.inventory.filter(f => f.kind === 'documentation').map(f => f.path),
    programs: components.map(({ c, a }) => ({
      path: c.path,
      name: c.name,
      area: c.area,
      lines: c.lines,
      verifiable: c.verifiable,
      deferred_reasons: c.deferredReasons,
      calls: c.calls.map(x => x.name),
      summary: a?.summary ?? '(analysis failed)',
      rules: a?.business_rules.length ?? 0,
    })),
  };
  const r = await runToolLoop({
    db,
    system: SYSTEM_SYSTEM,
    user: `System facts and per-program results:\n${JSON.stringify(brief, null, 1)}`,
    tools: [...PROJECT_TOOLS, SUBMIT_SYSTEM],
    handle: (name, args) => handleProjectTool(view, name, args),
    finalTool: SUBMIT_SYSTEM.name,
    normalize: normalizeSystem,
    maxTurns: 8,
    validate: a => {
      if (typeof a.target_language !== 'string' || !a.target_language.trim()) return 'target_language is required';
      if (typeof a.target_runtime !== 'string' || !a.target_runtime.trim()) return 'target_runtime is required';
      if (!Array.isArray(a.first_slice)) return 'first_slice must be an array of paths';
      const bad = (a.first_slice as string[]).filter(p => !verifiable.has(p));
      if (bad.length) return `first_slice may only contain verifiable programs; not verifiable: ${bad.join(', ')}. Verifiable: ${[...verifiable].join(', ') || 'none'}`;
      if (verifiable.size > 0 && (a.first_slice as string[]).length === 0) return 'choose at least one verifiable program for first_slice';
      return undefined;
    },
    maxTokens: 16000,
    onToolCall,
    onReject,
  });
  return { system: r.answer as unknown as SystemAnalysis, llm: stats(r) };
}
