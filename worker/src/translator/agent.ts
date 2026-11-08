// The Translator agent: Nemotron with tools to read the legacy project, build
// the target file section by section, and compile/lint it in the target
// sandbox. Its answer is only accepted once the static check passes on the
// file as submitted (or after several failed checks, recorded as
// check_status "failed" for the Debugger).
//
// Why sections: one Nemotron reply must finish inside SpacetimeDB's 180 s
// procedure limit, and a whole program in one reply does not. Writing the
// file as named sections (imports, one function per rule, main) keeps every
// reply small, and matches the one-function-per-rule design.
//
//   translateShared   copybooks/includes -> one shared records module
//   translateProgram  one legacy program -> one target file

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runToolLoop, type ToolDef, type ToolLoopResult } from '../llm.ts';
import { canonical, runBatch } from '../modernize/sandbox.ts';
import { lineDiff } from '../modernize/agents.ts';
import type { Stdb } from '../stdb.ts';
import type { ProjectView, LlmStats } from '../analyzer/agent.ts';
import { checkFiles, RUN_CONTRACT, type CheckResult, type TargetProfile } from './targets.ts';

export interface RuleRef {
  id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  start: number;
  end: number;
  /** Analyzer's verdict: keep (normal), review (unclear / bug-like), drop_candidate (dead or test-only). */
  disposition?: string;
  dispositionReason?: string;
}

/** Everything the Analyzer found about one program, as the Translator's brief. */
export interface ProgramToTranslate {
  path: string;
  name: string;
  lines: number;
  includes: { name: string; file?: string }[];
  fileIO: { name: string; assign: string; organization?: string }[];
  takesParameters: boolean;
  rules: RuleRef[];
  summary: string;
  inputs: { name: string; description: string }[];
  outputs: { name: string; description: string }[];
  risks: string[];
  /** Record layouts the Analyzer identified (name, where defined, meaning). */
  dataLayouts?: { name: string; defined_in: string; description: string }[];
  /** The Analyzer's advice for modernizing this program. */
  modernizationNotes?: string;
  /** System-level decision: why this target language, and how the system fits together. */
  system?: { targetReasons: string[]; architecture: string };
}

/** The Analyzer's findings for one program, formatted for the Translator. Exported for tests. */
export function analyzerBrief(p: ProgramToTranslate): string {
  const parts = [
    '## What the Analyzer found (use it as your map; the legacy source below is the ground truth)',
    `Summary: ${p.summary}`,
    p.inputs.length ? `Inputs:\n${p.inputs.map(i => `- ${i.name}: ${i.description}`).join('\n')}` : '',
    p.outputs.length ? `Outputs:\n${p.outputs.map(o => `- ${o.name}: ${o.description}`).join('\n')}` : '',
    p.dataLayouts?.length ? `Data layouts:\n${p.dataLayouts.map(d => `- ${d.name} (${d.defined_in}): ${d.description}`).join('\n')}` : '',
    p.fileIO.length ? `Files (COBOL SELECT ... ASSIGN): ${p.fileIO.map(f => `${f.name} -> ${f.assign}${f.organization ? ` (${f.organization.toLowerCase()})` : ''}`).join(', ')}` : '',
    `Entered with parameters (CALL ... USING): ${p.takesParameters ? 'yes' : 'no'}`,
    p.risks.length ? `Known risks:\n${p.risks.map(r => `- ${r}`).join('\n')}` : '',
    p.modernizationNotes ? `Modernization notes: ${p.modernizationNotes}` : '',
    p.system?.targetReasons.length ? `Why this target language was chosen:\n${p.system.targetReasons.map(r => `- ${r}`).join('\n')}` : '',
    p.system?.architecture ? `How the system fits together: ${p.system.architecture}` : '',
    `Business rules to implement (${p.rules.length}), one function each:`,
    ...p.rules.map(r => {
      const flag = r.disposition && r.disposition !== 'keep' ? ` [Analyzer marked ${r.disposition.toUpperCase().replace('_', ' ')}${r.dispositionReason ? `: ${r.dispositionReason}` : ''}]` : '';
      return `- ${r.id} "${r.title}" [legacy lines ${r.start}-${r.end}]: given ${r.given}; when ${r.when}; then ${r.then}${flag}`;
    }),
    p.rules.some(r => r.disposition && r.disposition !== 'keep')
      ? 'Rules marked REVIEW or DROP CANDIDATE still get implemented exactly as the legacy code behaves (outputs must match); say in "notes" what looked wrong or unused, for a human to decide.'
      : '',
  ];
  return parts.filter(Boolean).join('\n');
}

export interface TranslationResult {
  source: string;
  sha256: string;
  check: CheckResult;
  ruleMap: { rule_id: string; function: string }[];
  notes: string;
  llm: LlmStats;
  /** Shared module only: code per section ("base" and one per include, by base name). */
  sections?: Record<string, string>;
  /** Program only: whether the submitted code matched every legacy example, and how often run_examples ran. */
  examples?: { matched: boolean; total: number; runs: number };
}

export interface TranslateEnv {
  db: Stdb;
  view: ProjectView;
  profile: TargetProfile;
  image: string;
  targetLanguage: string;
  /** Scratch root for check folders (one subfolder per program). */
  workRoot: string;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onReject?: (problem: string) => void;
  /** false = fallback mode without Nemotron reasoning (used on a retry). */
  thinking?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const stats = (r: ToolLoopResult): LlmStats => ({
  models: r.models,
  turns: r.turns,
  tool_calls: r.toolCalls,
  prompt_tokens: r.promptTokens,
  completion_tokens: r.completionTokens,
  reasoning_tokens: r.reasoningTokens,
  cached_turns: r.cachedTurns,
});
/** After this many failed checks the agent may submit anyway (status "failed"). */
const MAX_FAILED_CHECKS = 4;
/** Per reply: room for one section plus reasoning, well inside the 180 s procedure limit. */
const MAX_TOKENS = 12000;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Real legacy behaviour on a test input (from the Verifier's debug cases, never holdout). */
export interface Example {
  input: string;
  /** Canonical legacy output (stdout, plus "[exit N]" when the exit code isn't 0). */
  expected: string;
}

/**
 * Shows the Translator what the legacy program really prints for a few
 * inputs, recorded by running it. Seeing exact output (spaces made visible by
 * JSON quoting) prevents most formatting mismatches before the first test run.
 */
export function examplesBlock(examples: Example[]): string {
  if (!examples.length) return '';
  return [
    'Real behaviour of the legacy program (recorded by running it). Your program must produce exactly this for these inputs. Strings are JSON-quoted so spaces are visible; "[exit N]" on the last line is the exit code.',
    ...examples.map((e, i) => `Example ${i + 1}\nstdin: ${JSON.stringify(e.input)}\nstdout lines:\n${e.expected.split('\n').map(l => `  ${JSON.stringify(l)}`).join('\n')}`),
  ].join('\n');
}

/**
 * File line range of a function/method definition, for the dashboard's
 * rule -> modern code highlighting. Python: from "def" to the line before the
 * next top-level statement. Brace languages: from the signature to its
 * closing brace. undefined when the function isn't found.
 */
export function functionRange(source: string, fn: string): { start: number; end: number } | undefined {
  const name = fn.split('.').pop()!.replace(/\(.*$/, '').trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const lines = source.split('\n');
  const startIdx = lines.findIndex(l => new RegExp(String.raw`(\bdef\s+${name}\s*\(|\b${name}\s*\([^;]*\)\s*(throws\s+[\w.,\s]+)?\{?\s*$|\bfunction\s+${name}\b|\bfunc\s+${name}\b|\b${name}\s*=\s*(async\s*)?\()`).test(l));
  if (startIdx < 0) return undefined;
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[startIdx]);
  let end = startIdx;
  if (/\bdef\s/.test(lines[startIdx])) {
    // Python: until the next non-blank line at the same or lower indentation.
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      if (indent(lines[i]) <= base && !/^\s*[)\]}#]/.test(lines[i])) break;
      end = i;
    }
  } else {
    // Brace languages: count braces from the signature.
    let depth = 0;
    let opened = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i].replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'|\/\/.*$/g, '')) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') depth--;
      }
      end = i;
      if (opened && depth <= 0) break;
    }
  }
  return { start: startIdx + 1, end: end + 1 };
}

/** Rule -> modern line ranges from the rule -> function map (rules whose function isn't found are left out). */
export function ruleRanges(source: string, ruleMap: { rule_id: string; function: string }[]): { rule_id: string; start_line: number; end_line: number }[] {
  return ruleMap.flatMap(m => {
    const r = functionRange(source, m.function);
    return r ? [{ rule_id: m.rule_id, start_line: r.start, end_line: r.end }] : [];
  });
}

/** Strips a ```lang fence if the model wrapped the code in one. */
export function unfence(code: string): string {
  const m = code.match(/^\s*```[\w+-]*\n([\s\S]*?)\n```\s*$/);
  return (m ? m[1] : code).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** A source file built from named sections, in the order they were first written. */
export class SectionFile {
  readonly sections = new Map<string, string>();
  write(name: string, code: string): string {
    const n = name.trim();
    if (!n) throw new Error('section name is required');
    const existed = this.sections.has(n);
    this.sections.set(n, unfence(code));
    return `${existed ? 'Replaced' : 'Added'} section "${n}" (${unfence(code).split('\n').length} lines). Sections: ${[...this.sections.keys()].join(', ')}`;
  }
  remove(name: string): string {
    if (!this.sections.delete(name.trim())) throw new Error(`no section "${name}"`);
    return `Removed section "${name}". Sections: ${[...this.sections.keys()].join(', ') || 'none'}`;
  }
  get source(): string {
    return [...this.sections.values()].filter(s => s.trim()).join('\n\n\n') + '\n';
  }
  view(): string {
    if (this.sections.size === 0) return 'The file is empty. Start with write_section.';
    return this.ranges().map(r => `--- section "${r.name}" (file lines ${r.start}-${r.end})\n${this.sections.get(r.name)}`).join('\n');
  }
  /** File line range of every section (sections are joined by two blank lines). */
  ranges(): { name: string; start: number; end: number }[] {
    let line = 1;
    return [...this.sections].filter(([, code]) => code.trim()).map(([name, code]) => {
      const n = code.split('\n').length;
      const r = { name, start: line, end: line + n - 1 };
      line += n + 2;
      return r;
    });
  }
  /** Adds the section name to "file:LINE:" positions in checker output. */
  annotate(output: string): string {
    const ranges = this.ranges();
    return output.replace(/^(\S+?):(\d+):(\d+:)?/gm, (m, _f, l: string) => {
      const r = ranges.find(x => Number(l) >= x.start && Number(l) <= x.end);
      return r ? `${m} [section "${r.name}", line ${Number(l) - r.start + 1}]` : m;
    });
  }
}

/** Gate: the submitted file must have passed check_code as it is now. */
class CheckGate {
  readonly results = new Map<string, CheckResult>();
  failures = 0;
  private readonly run: (source: string) => Promise<CheckResult>;
  private readonly submitTool: string;
  private readonly annotate: (output: string) => string;
  constructor(run: (source: string) => Promise<CheckResult>, submitTool: string, annotate: (output: string) => string = o => o) {
    this.run = run;
    this.submitTool = submitTool;
    this.annotate = annotate;
  }
  async check(source: string): Promise<string> {
    const r = await this.run(source);
    this.results.set(sha(source), r);
    if (r.status === 'failed') this.failures++;
    const done = `If every part is written, you are done: call ${this.submitTool} now. Do not rewrite sections that already work.`;
    if (r.status === 'ok') return `OK: the file compiles and passes the checks. ${done}`;
    if (r.status === 'unavailable') return `OK (no static check available: ${r.output}). ${done}`;
    return `ERRORS (each shows the section to fix with write_section):\n${this.annotate(r.output)}`;
  }
  /** At submit: checks the file now if it changed since the last check. undefined = accept. */
  async gate(source: string): Promise<string | undefined> {
    if (!this.results.has(sha(source))) await this.check(source);
    const r = this.results.get(sha(source))!;
    if (r.status === 'failed' && this.failures < MAX_FAILED_CHECKS) return `the static check fails on the file as submitted; fix these errors first:\n${r.output.slice(0, 1500)}`;
    return undefined;
  }
}

/** Includes (by base name) that the shared module doesn't mention at all. */
export function missingLayouts(source: string, includeFiles: string[]): string[] {
  const text = source.toLowerCase().replace(/[-_]/g, '');
  return includeFiles
    .map(f => path.posix.basename(f).replace(/\.[^.]+$/, ''))
    .filter(name => !text.includes(name.toLowerCase().replace(/[-_]/g, '')));
}

/** True if the source defines a function/method with this name (Python, Java, C). */
export function definesFunction(source: string, fn: string): boolean {
  const name = fn.split('.').pop()!.replace(/\(.*$/, '').trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  // Python "def name(", or Java/C "name(...) {" (a definition, not a call).
  return new RegExp(String.raw`(\bdef\s+${name}\s*\(|\b${name}\s*\([^;{]*\)\s*(throws\s+[\w.,\s]+)?\{)`).test(source);
}

const READ_TOOLS: ToolDef[] = [
  {
    name: 'read_legacy_file',
    description: 'Read a legacy project file with line numbers (max 400 lines per call): the program, copybooks, called programs, docs.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } },
      required: ['path'],
    },
  },
  {
    name: 'search_legacy',
    description: 'Case-insensitive regex search over the legacy project. Returns path:line: text.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path_prefix: { type: 'string' } }, required: ['pattern'] },
  },
];

function fileTools(fileName: string): ToolDef[] {
  return [
    {
      name: 'write_section',
      description: `Add or replace one named section of ${fileName} (sections are joined in the order first written). Keep each section under ~150 lines: e.g. "imports", one per business-rule function, helpers, "main".`,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Section name, e.g. "imports" or "br_03_apply_fee"' }, code: { type: 'string' } },
        required: ['name', 'code'],
      },
    },
    { name: 'view_file', description: `Show ${fileName} (the file YOU are writing) as it is now, section by section, with file line numbers. Read-only.`, parameters: { type: 'object', properties: {} } },
    { name: 'check_code', description: `Compile and lint ${fileName} as it is now, in the target sandbox. Returns "OK" or the errors, each labelled with its section.`, parameters: { type: 'object', properties: {} } },
  ];
}

/** Consecutive searches allowed before the agent is told to get back to writing. */
const MAX_SEARCH_STREAK = 5;

/** Reads/searches allowed since the last write before the agent is told to write. */
const MAX_EXPLORE_SINCE_WRITE = 6;

function handler(
  env: TranslateEnv,
  file: SectionFile,
  gate: CheckGate,
  ownFiles: string[],
  readOnly: string[] = [],
  runner?: ExampleRunner,
  /** Legacy files whose full text is already in the instructions (re-reading them is refused). */
  shownInFull: string[] = []
) {
  let searchStreak = 0;
  let exploreSinceWrite = 0;
  const writeNow = (why: string) =>
    `${why} You already have what you need in your instructions. Write the file now with write_section (one section per call), then check_code${runner?.available ? ' and run_examples' : ''}, then submit.`;
  return async (name: string, a: Record<string, unknown>): Promise<string> => {
    searchStreak = name === 'search_legacy' ? searchStreak + 1 : 0;
    if (name === 'read_legacy_file' || name === 'search_legacy') {
      exploreSinceWrite++;
      if (exploreSinceWrite > MAX_EXPLORE_SINCE_WRITE) return writeNow(`Stop exploring (${exploreSinceWrite - 1} reads/searches since you last wrote code).`);
    }
    switch (name) {
      case 'read_legacy_file': {
        const p = str(a.path);
        // The model sometimes tries to read the file it is writing.
        if (ownFiles.includes(path.posix.basename(p))) {
          return `${p} is not a legacy file: it is the file you are writing (or the shared module, shown in your instructions). Here it is:\n${file.view()}`;
        }
        if (shownInFull.includes(p)) return writeNow(`${p} is already shown in full, with line numbers, in your instructions.`);
        return env.view.numbered(p, Number(a.start_line ?? 1), Number(a.end_line ?? Number.MAX_SAFE_INTEGER));
      }
      case 'search_legacy':
        if (searchStreak > MAX_SEARCH_STREAK) {
          return `Stop searching (${searchStreak - 1} searches in a row). You have what you need: use view_file to see your file, write_section to change it, check_code to check it, then submit.`;
        }
        return env.view.search(str(a.pattern), str(a.path_prefix));
      case 'write_section':
        if (readOnly.includes(str(a.name).trim())) return `Section "${str(a.name).trim()}" is read-only (written by another task). Put your code in your own sections.`;
        exploreSinceWrite = 0;
        return file.write(str(a.name), str(a.code));
      case 'view_file':
        return file.view();
      case 'check_code':
        return file.sections.size ? gate.check(file.source) : 'The file is empty.';
      case 'run_examples': {
        if (!runner?.available) return 'No examples are available for this program.';
        if (!file.sections.size) return 'The file is empty.';
        return (await runner.run(file.source)).report;
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };
}

const WORKFLOW = `How to work (each of your replies must stay short: at most one or two sections per reply):
1. Read what you need with read_legacy_file / search_legacy.
2. Build the file with write_section, one section per call: imports/constants first, then the functions, then main.
3. Call check_code. If it reports errors, rewrite only the section each error names (write_section with the same name replaces it) and check again.
4. If you have the run_examples tool, call it once check_code is OK: it runs your code on real inputs and shows where your output differs from the legacy program. Fix those sections and run it again until every example matches.
5. Then call the submit tool. (Submitting re-checks the file if you changed it.)
Keep your thinking brief: decide, then make the tool call.
The file is production code: short comments that name the rule or explain a legacy quirk. Never write your reasoning, notes to yourself or test code into the file; use run_examples to test.`;

/**
 * Production-code hygiene for a submitted program file: no process-spawning
 * test code, nothing after the Python __main__ block, and not mostly comments
 * (the model tends to leave its reasoning in comments). Exported for tests.
 */
export function hygieneProblem(source: string, profile: TargetProfile): string | undefined {
  if (/^\s*(import\s+subprocess|from\s+subprocess\s+import)|require\(\s*['"](node:)?child_process['"]\s*\)|\bos\.system\s*\(|Runtime\.getRuntime\(\)\.exec|\bexec\.Command\s*\(/m.test(source)) {
    return 'the file starts other processes (test code?). Remove it: use run_examples to test your code';
  }
  const lines = source.split('\n');
  if (profile.id === 'python') {
    const guard = lines.findIndex(l => /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(l));
    if (guard >= 0 && lines.slice(guard + 1).some(l => /^\S/.test(l) && !l.startsWith('#'))) {
      return 'there is code after the if __name__ == "__main__": block. Remove it (test code belongs in run_examples, not the file)';
    }
  }
  const nonBlank = lines.filter(l => l.trim()).length;
  const comments = lines.filter(l => /^\s*(#|\/\/|\/\*|\*)/.test(l)).length;
  if (comments > 40 && comments > 0.4 * nonBlank) {
    return `${comments} of ${nonBlank} lines are comments. Keep short comments that name the rule or explain a legacy quirk; remove reasoning and notes`;
  }
  return undefined;
}

/**
 * Runs the program being written on the real legacy examples (Verifier debug
 * cases, never holdout) in the target sandbox and reports, line by line, where
 * its output differs. Lets the Translator fix formatting slips before the
 * Verifier and Debugger ever see the code.
 */
export class ExampleRunner {
  runs = 0;
  /** Submissions bounced because examples still differed. */
  bounces = 0;
  readonly passed = new Set<string>();
  private readonly cfg: { profile: TargetProfile; image: string; workDir: string; fileName: string; shared: { fileName: string; source: string }; examples: Example[] };
  constructor(cfg: ExampleRunner['cfg']) {
    this.cfg = cfg;
  }
  get available(): boolean {
    return this.cfg.examples.length > 0;
  }
  async run(source: string): Promise<{ ok: number; total: number; report: string }> {
    const c = this.cfg;
    this.runs++;
    const codeDir = path.join(c.workDir, 'examples', 'code');
    await rm(codeDir, { recursive: true, force: true });
    await mkdir(codeDir, { recursive: true });
    await writeFile(path.join(codeDir, c.shared.fileName), c.shared.source);
    await writeFile(path.join(codeDir, c.fileName), source);
    const res = await runBatch({
      image: c.image,
      build: c.profile.build(c.fileName),
      run: c.profile.run(c.fileName),
      workDir: path.join(c.workDir, 'examples'),
      mounts: [{ host: codeDir, container: '/work' }],
      cases: c.examples.map((e, i) => ({ id: String(i + 1).padStart(2, '0'), stdin: e.input })),
    });
    if (!res.built) return { ok: 0, total: c.examples.length, report: `The code does not build:\n${res.buildLog.slice(0, 2000)}` };
    let ok = 0;
    const parts: string[] = [];
    c.examples.forEach((e, i) => {
      const r = res.cases.get(String(i + 1).padStart(2, '0'));
      const actual = r ? canonical(r.stdout, r.exitCode) : '[no result]';
      if (actual === e.expected) {
        ok++;
        parts.push(`Example ${i + 1}: matches`);
      } else {
        parts.push(`Example ${i + 1}: DIFFERS (stdin ${JSON.stringify(e.input.slice(0, 200))})\n${lineDiff(e.expected, actual)}${r?.stderr.trim() ? `\nstderr: ${r.stderr.trim().slice(0, 600)}` : ''}`);
      }
    });
    if (ok === c.examples.length) this.passed.add(sha(source));
    return { ok, total: c.examples.length, report: `${ok}/${c.examples.length} examples match the legacy output.\n${parts.join('\n')}` };
  }
}

const RUN_EXAMPLES_TOOL: ToolDef = {
  name: 'run_examples',
  description: 'Run your file as it is now on the real legacy examples, in the sandbox. Shows which examples match and, for the others, the first differing lines (JSON-quoted so spaces are visible).',
  parameters: { type: 'object', properties: {} },
};

/** After this many bounced submissions the code is accepted anyway; the Verifier and Debugger take over. */
const MAX_EXAMPLE_BOUNCES = 3;

// ------------------------------------------------------ shared module
// Built in pieces so every agent task stays small, whatever the number of
// copybooks: (1) a base section with imports, the clock helper and numeric
// helpers; (2) one small task per copybook, a few in parallel, each writing
// only its own section and checking it together with the base; (3) the pieces
// are assembled into one module and checked once more.

/** Runs `fn` over items with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const sumStats = (all: LlmStats[]): LlmStats => ({
  models: [...new Set(all.flatMap(l => l.models))],
  turns: all.reduce((n, l) => n + l.turns, 0),
  tool_calls: all.reduce((n, l) => n + l.tool_calls, 0),
  prompt_tokens: all.reduce((n, l) => n + l.prompt_tokens, 0),
  completion_tokens: all.reduce((n, l) => n + l.completion_tokens, 0),
  reasoning_tokens: all.reduce((n, l) => n + l.reasoning_tokens, 0),
  cached_turns: all.reduce((n, l) => n + l.cached_turns, 0),
});

export interface SharedPart {
  name: string;
  code: string;
  symbols: string[];
  notes: string;
  llm: LlmStats;
}

/** One small agent task that writes exactly one section of the shared module. */
async function writeSharedPart(
  env: TranslateEnv,
  part: { section: string; system: string; user: string; base: string; validate: (code: string) => string | undefined }
): Promise<SharedPart> {
  const fileName = env.profile.sharedFileName;
  const file = new SectionFile();
  if (part.base) file.write('base', part.base);
  // This task's code: every section except the read-only base, in order.
  // (Only a given base is read-only; the base task itself owns every section.)
  const ownCode = () => [...file.sections].filter(([n]) => !part.base || n !== 'base').map(([, c]) => c).filter(c => c.trim()).join('\n\n\n');
  const workDir = path.join(env.workRoot, '_shared', part.section.replace(/[^\w.-]+/g, '_'));
  const gate = new CheckGate(src => checkFiles(env.profile, env.image, workDir, { [fileName]: src }), 'submit_section', o => file.annotate(o));
  const SUBMIT: ToolDef = {
    name: 'submit_section',
    description: 'Submit your section. Call once, after check_code returned OK.',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'Names of the types/functions your section defines' },
        notes: { type: 'string' },
      },
      required: ['symbols'],
    },
  };
  const r = await runToolLoop({
    db: env.db,
    system: part.system,
    user: part.user,
    tools: [...READ_TOOLS, ...fileTools(fileName), SUBMIT],
    handle: handler(env, file, gate, [fileName], part.base ? ['base'] : []),
    finalTool: SUBMIT.name,
    validate: () => {
      const code = ownCode();
      if (code.trim().length < 20) return `you have not written any code yet: use write_section`;
      return part.validate(code) ?? gate.gate(file.source);
    },
    maxTurns: 22,
    maxTokens: MAX_TOKENS,
    onToolCall: env.onToolCall,
    onReject: env.onReject,
    thinking: env.thinking,
  });
  return {
    name: part.section,
    code: ownCode(),
    symbols: Array.isArray(r.answer.symbols) ? (r.answer.symbols as unknown[]).map(String) : [],
    notes: str(r.answer.notes),
    llm: stats(r),
  };
}

export async function translateShared(
  env: TranslateEnv,
  includeFiles: string[],
  opts: { concurrency?: number; onPart?: (name: string, part: SharedPart) => void } = {}
): Promise<TranslationResult> {
  const fileName = env.profile.sharedFileName;
  const intro = `You are the Translator agent of AgentProof, building ${fileName}: the ONE shared module for ${env.targetLanguage} that every translated program imports. It replaces the legacy copybooks/includes and is the single source of truth for record layouts.

Conventions:
${env.profile.conventions}

${WORKFLOW}
The "base" section (if shown) is read-only. Write your code in one or more sections of your own (e.g. imports, the record type, parse/format, constants).`;

  // 1. Base: imports, clock helper, numeric helpers.
  const baseSpec = () => ({
    section: 'base',
    base: '',
    system: `${intro}

Your section: "base". Write:
- the imports the module needs;
- a clock helper that returns the current date/time but uses the COB_CURRENT_DATE environment variable when set (formats "YYYY/MM/DD hh:mm:ss" and "YYYYMMDDhhmmss"), so tests can pin the date;
- helpers for COBOL semantics: truncation (toward zero) vs ROUNDED (half away from zero), parsing/formatting DISPLAY numerics with implied decimals and signs, edited PICTURE formatting (Z, comma, $, +/-), fixed-width text padding.
Keep it under ~200 lines. Record layouts are NOT your job; other tasks add them after your section.`,
    user: `Layouts that will be added after your section: ${includeFiles.map(f => path.posix.basename(f)).join(', ') || 'none'}.`,
    validate: (code: string) => (/COB_CURRENT_DATE/.test(code) ? undefined : 'the base section must include the clock helper that honours COB_CURRENT_DATE'),
  });
  // Everything depends on the base: retry once without reasoning before giving up.
  const base = await writeSharedPart(env, baseSpec()).catch(() => writeSharedPart({ ...env, thinking: false }, baseSpec()));
  opts.onPart?.('base', base);

  // 2. One task per include.
  const parts = await pool(includeFiles, opts.concurrency ?? 3, async f => {
    const name = path.posix.basename(f).replace(/\.[^.]+$/, '');
    const copybook = await env.view.numbered(f, 1, 400);
    const partSpec = () => ({
      section: name,
      base: base.code,
      system: `${intro}

Your section: "${name}", the translation of ONE copybook (${f}). The base section above is already written: use its helpers, do not redefine them. Write:
- a type (class/struct) named after the copybook layout, with one field per elementary item, named after the legacy name, legacy PICTURE in a comment;
- parse(line) that reads the fixed-width record exactly as the legacy program would (DISPLAY/zoned numerics with implied decimals, signs, spaces) and format() that writes it back byte for byte (same total length);
- 88-level condition names as constants or helper methods;
- if the copybook only holds constants/working-storage (no record), translate those as constants.
Put "${name}" in the docstring/comment of what you write.`,
      user: `Base section (already in the module, read-only):\n${base.code}\n\nCopybook to translate:\n${copybook}`,
      validate: (code: string) => (missingLayouts(code, [f]).length ? `mention "${name}" in your section (docstring or comment) so the layout can be traced to the copybook` : undefined),
    });
    // A failed copybook must not stop the others: retry once without
    // reasoning, then report it and leave it out.
    const part: SharedPart = await writeSharedPart(env, partSpec()).catch(() =>
      // Second try without reasoning: shorter replies, no cut-offs.
      writeSharedPart({ ...env, thinking: false }, partSpec())
    ).catch((e: unknown): SharedPart => ({
      name,
      code: '',
      symbols: [],
      notes: `FAILED to translate ${f}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      llm: sumStats([]),
    }));
    opts.onPart?.(name, part);
    return part;
  });

  // 3. Assemble and check the whole module once.
  const file = new SectionFile();
  file.write('base', base.code);
  for (const p of parts) if (p.code) file.write(p.name, p.code);
  const source = file.source;
  const check = await checkFiles(env.profile, env.image, path.join(env.workRoot, '_shared', '_all'), { [fileName]: source });
  if (check.status === 'failed') check.output = file.annotate(check.output);
  const failed = parts.filter(p => !p.code).map(p => p.name);
  if (failed.length) {
    // Programs using a missing layout will fail their own checks; make it explicit.
    check.status = 'failed';
    check.output = `layouts not translated: ${failed.join(', ')}\n${check.output}`.trim();
  }
  return {
    source,
    sha256: sha(source),
    check,
    ruleMap: parts.filter(p => p.code).map(p => ({ rule_id: p.name, function: p.symbols.join(', ') })),
    sections: Object.fromEntries([...file.sections]),
    notes: [base, ...parts].map(p => p.notes).filter(Boolean).join('\n'),
    llm: sumStats([base.llm, ...parts.map(p => p.llm)]),
  };
}

// ------------------------------------------------------------ program
/**
 * The shared module as shown to one program: the base helpers plus only the
 * layouts of the includes it uses. Sending the whole module on every turn
 * costs ~1M tokens per program on a system with many copybooks. The static
 * check still runs against the full module.
 */
export function relevantShared(shared: { source: string; sections?: Record<string, string> }, p: { includes: { name: string; file?: string }[] }): string {
  if (!shared.sections) return shared.source;
  const wanted = new Set(p.includes.map(i => path.posix.basename(i.file ?? i.name).replace(/\.[^.]+$/, '').toUpperCase()));
  const keep = Object.entries(shared.sections).filter(([name]) => name === 'base' || wanted.has(name.toUpperCase()));
  const others = Object.keys(shared.sections).filter(n => n !== 'base' && !wanted.has(n.toUpperCase()));
  const shown = keep.map(([name, code]) => `# --- section ${name}\n${code}`).join('\n\n');
  return others.length ? `${shown}\n\n# (also in the module, not used by this program: ${others.join(', ')})` : shown;
}

export async function translateProgram(
  env: TranslateEnv,
  p: ProgramToTranslate,
  shared: { fileName: string; source: string; sections?: Record<string, string> },
  examples: Example[] = []
): Promise<TranslationResult> {
  const fileName = env.profile.fileName(p.name);
  const workDir = path.join(env.workRoot, p.name);
  const file = new SectionFile();
  const gate = new CheckGate(src => checkFiles(env.profile, env.image, workDir, { [shared.fileName]: shared.source, [fileName]: src }), 'submit_translation', o => file.annotate(o));
  const SUBMIT: ToolDef = {
    name: 'submit_translation',
    description: `Submit ${fileName} as it is now. Call once, after check_code returned OK.`,
    parameters: {
      type: 'object',
      properties: {
        rule_map: {
          type: 'array',
          description: 'Every business rule id -> the function that implements it',
          items: { type: 'object', properties: { rule_id: { type: 'string' }, function: { type: 'string' } }, required: ['rule_id', 'function'] },
        },
        notes: { type: 'string', description: 'Legacy quirks you preserved on purpose, assumptions, anything the Verifier should know' },
      },
      required: ['rule_map'],
    },
  };
  const system = `You are the Translator agent of AgentProof. You rewrite ONE legacy program in ${env.targetLanguage} so that it behaves IDENTICALLY to the original, as clean idiomatic code.

${RUN_CONTRACT}

Structure:
- One function per business rule listed below, named after the rule (e.g. br_03_apply_monthly_fee), with the rule id in its docstring/comment. Return the mapping in rule_map.
- Use the record types and the clock helper from the shared module ${shared.fileName}; do not redefine layouts.
- Preserve the observable results of the legacy control flow, not its shape: no GO TO emulation, no paragraph-per-function port unless a paragraph IS a rule.

Conventions:
${env.profile.conventions}

${WORKFLOW}`;
  const user = [
    `Program: ${p.name} (${p.path}, ${p.lines} lines). Target file: ${fileName}. Run as: ${env.profile.run(fileName)}`,
    analyzerBrief(p),
    examplesBlock(examples),
    `Shared module ${shared.fileName} (the parts this program uses):\n${relevantShared(shared, p)}`,
    `Legacy source:\n${await env.view.numbered(p.path, 1, 400)}`,
  ].join('\n\n');
  const ruleIds = new Set(p.rules.map(r => r.id));
  const runner = new ExampleRunner({ profile: env.profile, image: env.image, workDir, fileName, shared, examples });
  const r = await runToolLoop({
    db: env.db,
    system,
    user,
    tools: [...READ_TOOLS, ...fileTools(fileName), ...(runner.available ? [RUN_EXAMPLES_TOOL] : []), SUBMIT],
    // The instructions show the first 400 lines of the program: for shorter
    // programs that is all of it, so re-reading it is refused.
    handle: handler(env, file, gate, [fileName, shared.fileName], [], runner, p.lines <= 400 ? [p.path] : []),
    finalTool: SUBMIT.name,
    validate: async a => {
      if (file.source.trim().length < 50) return 'the file is empty: write it with write_section first';
      const map = Array.isArray(a.rule_map) ? (a.rule_map as Record<string, unknown>[]) : [];
      const mapped = new Set(map.map(m => String(m?.rule_id ?? '')));
      const missing = [...ruleIds].filter(id => !mapped.has(id) && !mapped.has(id.split(':').pop()!));
      if (ruleIds.size > 0 && missing.length > ruleIds.size / 2) return `rule_map is missing most rules: ${missing.slice(0, 8).join(', ')}`;
      const undefinedFns = map.map(m => String(m?.function ?? '')).filter(fn => fn && !definesFunction(file.source, fn));
      if (undefinedFns.length) return `rule_map names functions that are not in the file: ${undefinedFns.slice(0, 8).join(', ')}. Write them (write_section) or fix rule_map`;
      const dirty = hygieneProblem(file.source, env.profile);
      if (dirty) return dirty;
      const compile = await gate.gate(file.source);
      if (compile) return compile;
      // Behaviour on the real examples: bounce a few times with the diff, then
      // hand over to the Verifier/Debugger anyway.
      if (runner.available && !runner.passed.has(sha(file.source)) && runner.bounces < MAX_EXAMPLE_BOUNCES) {
        const res = await runner.run(file.source);
        if (res.ok < res.total) {
          runner.bounces++;
          return `the code compiles, but its output differs from the legacy program on real inputs. ${res.report.slice(0, 3000)}`;
        }
      }
      return undefined;
    },
    maxTurns: 26 + 2 * p.rules.length,
    maxTokens: MAX_TOKENS,
    onToolCall: env.onToolCall,
    onReject: env.onReject,
    thinking: env.thinking,
  });
  const source = file.source;
  const check = gate.results.get(sha(source)) ?? (await checkFiles(env.profile, env.image, workDir, { [shared.fileName]: shared.source, [fileName]: source }));
  const ruleMap = (Array.isArray(r.answer.rule_map) ? (r.answer.rule_map as Record<string, unknown>[]) : [])
    .filter(m => m && typeof m === 'object')
    .map(m => {
      const id = String(m.rule_id);
      // Accept short ids ("BR-03") and expand them to the full rule id.
      const full = ruleIds.has(id) ? id : [...ruleIds].find(x => x.endsWith(`:${id}`)) ?? id;
      return { rule_id: full, function: String(m.function) };
    });
  const examplesResult = runner.available ? { matched: runner.passed.has(sha(source)), total: examples.length, runs: runner.runs } : undefined;
  return { source, sha256: sha(source), check, ruleMap, notes: str(r.answer.notes), llm: stats(r), examples: examplesResult };
}
