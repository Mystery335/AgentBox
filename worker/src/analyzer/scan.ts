// Deterministic scanners: file inventory, dependency graph and the
// verifiable/deferred decision. No LLM here; this is the evidence the
// Analyzer agent starts from.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { classify, profile, type FileFacts, type FileKind } from './languages.ts';

export interface InventoryFile {
  path: string;
  kind: FileKind;
  language?: string;
  lines: number;
  bytes: number;
}

export interface CompileResult {
  status: 'ok' | 'failed' | 'unavailable';
  /** The command that succeeded (status ok), so the Verifier compiles the same way. */
  command?: string;
  /** First error line (status failed / unavailable). */
  error?: string;
}

export interface Component {
  path: string;
  language: string;
  /** PROGRAM-ID or file base name, upper case for COBOL. */
  name: string;
  /** Folder under the source root, e.g. "batch", "online". */
  area: string;
  lines: number;
  /** Non-blank lines; 0 means the file has no code. */
  codeLines: number;
  /** "program", or "template" for skeleton/example files that aren't part of the system. */
  role: 'program' | 'template';
  facts: FileFacts;
  includes: { name: string; file?: string }[];
  calls: { name: string; file?: string }[];
  /** Job-control files that run this program. */
  jobs: string[];
  compile?: CompileResult;
  verifiable: boolean;
  deferredReasons: string[];
}

export interface ScanResult {
  root: string;
  inventory: InventoryFile[];
  components: Component[];
  /** Languages by number of source lines, most first. */
  languages: { id: string; files: number; lines: number }[];
  /** Files that look like existing tests or test data. */
  tests: string[];
  /** Database objects declared in DDL files. */
  tables: { name: string; file: string }[];
}

const MAX_TEXT_BYTES = 1_000_000;
/** Known runtime-library routines (not part of the project, provided by the platform). */
const PLATFORM_CALLS: Record<string, string> = {
  ILBOABN0: 'IBM Language Environment abend routine',
  CEE3ABD: 'IBM Language Environment abend routine',
  CEEDAYS: 'IBM Language Environment date service',
  CBLTDLI: 'IMS DL/I interface',
  DSNHLI: 'DB2 interface',
};

async function readText(abs: string): Promise<string | null> {
  const s = await stat(abs);
  if (s.size > MAX_TEXT_BYTES) return null;
  const buf = await readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString('utf8');
}

/** Folders that hold skeletons/examples rather than programs of the system. */
const TEMPLATE_PATH = /(^|\/)(templates?|skeletons?|examples?|samples?)(\/|$)/i;

const lineCount = (t: string) => (t === '' ? 0 : t.split(/\r?\n/).length - (t.endsWith('\n') ? 1 : 0));
const baseNoExt = (p: string) => path.posix.basename(p).replace(/\.[^.]+$/, '');

/** Common folder prefix of all files, e.g. "COBOL-Legacy-Benchmark-Suite-main/". */
function commonRoot(files: string[]): string {
  if (files.length === 0) return '';
  const parts = files[0].split('/').slice(0, -1);
  let n = parts.length;
  for (const f of files) {
    const p = f.split('/');
    let i = 0;
    while (i < n && p[i] === parts[i]) i++;
    n = i;
  }
  return n ? parts.slice(0, n).join('/') + '/' : '';
}

/** Area = first meaningful folder below the root, skipping generic ones like src/programs. */
function areaOf(rel: string): string {
  const dirs = rel.split('/').slice(0, -1).filter(d => !/^(src|source|programs?|cobol|cbl|code|lib)$/i.test(d));
  return dirs[0] ?? '';
}

export async function scanProject(extractDir: string, files: string[]): Promise<ScanResult> {
  const root = commonRoot(files);
  const inventory: InventoryFile[] = [];
  const texts = new Map<string, string>();

  for (const f of files) {
    const text = await readText(path.join(extractDir, f));
    const { kind, language } = classify(f, text);
    const rel = f.slice(root.length);
    inventory.push({ path: rel, kind, ...(language ? { language } : {}), lines: text ? lineCount(text) : 0, bytes: (await stat(path.join(extractDir, f))).size });
    if (text !== null) texts.set(rel, text);
  }

  // Includes resolve by base name within the same language.
  const includeIndex = new Map<string, string>();
  for (const f of inventory) {
    if (f.kind === 'include' || f.kind === 'source') {
      const key = `${f.language}:${baseNoExt(f.path).toUpperCase()}`;
      if (f.kind === 'include' || !includeIndex.has(key)) includeIndex.set(key, f.path);
    }
  }

  const components: Component[] = [];
  for (const f of inventory) {
    if (f.kind !== 'source' || !f.language) continue;
    const p = profile(f.language)!;
    const text = texts.get(f.path) ?? '';
    const facts = p.scan(text);
    components.push({
      path: f.path,
      language: f.language,
      name: (facts.programId ?? baseNoExt(f.path)).toUpperCase(),
      area: areaOf(f.path),
      lines: f.lines,
      codeLines: text.split(/\r?\n/).filter(l => l.trim() !== '').length,
      role: TEMPLATE_PATH.test(f.path) ? 'template' : 'program',
      facts,
      includes: facts.includes.map(name => {
        const file = p.includeCandidates(name).map(c => includeIndex.get(`${f.language}:${baseNoExt(c).toUpperCase()}`)).find(Boolean);
        return file ? { name, file } : { name };
      }),
      calls: [],
      jobs: [],
      verifiable: false,
      deferredReasons: [],
    });
  }

  // Calls resolve to components by program name or file base name.
  const byName = new Map<string, Component>();
  for (const c of components) {
    byName.set(c.name, c);
    byName.set(baseNoExt(c.path).toUpperCase(), c);
  }
  for (const c of components) {
    c.calls = c.facts.calls.map(name => {
      const target = byName.get(name.toUpperCase());
      return target ? { name, file: target.path } : { name };
    });
  }

  // Job control: which jobs run which program (JCL EXEC PGM=...).
  const tables: { name: string; file: string }[] = [];
  for (const f of inventory) {
    const text = texts.get(f.path);
    if (!text) continue;
    if (f.kind === 'job-control') {
      for (const m of text.matchAll(/\bEXEC\s+PGM=([A-Z0-9#@$]+)/gi)) {
        const target = byName.get(m[1].toUpperCase());
        if (target && !target.jobs.includes(f.path)) target.jobs.push(f.path);
      }
    }
    if (f.kind === 'database') {
      for (const m of text.matchAll(/\bCREATE\s+TABLE\s+([A-Z0-9_.]+)/gi)) tables.push({ name: m[1].toUpperCase(), file: f.path });
    }
  }

  const tests = inventory
    .filter(f => f.kind === 'test-data' || /(^|\/)tests?(\/|$)|(^|\/)TST|test/i.test(f.path))
    .filter(f => f.kind !== 'binary')
    .map(f => f.path);

  const langTotals = new Map<string, { files: number; lines: number }>();
  for (const f of inventory) {
    if (f.kind !== 'source' || !f.language) continue;
    const t = langTotals.get(f.language) ?? { files: 0, lines: 0 };
    t.files += 1;
    t.lines += f.lines;
    langTotals.set(f.language, t);
  }
  const languages = [...langTotals].map(([id, t]) => ({ id, ...t })).sort((a, b) => b.lines - a.lines);

  return { root, inventory, components, languages, tests, tables };
}

/**
 * Decides verifiable vs deferred for every component, from the static facts
 * and the compile results. Deferred components keep every reason, so the
 * dashboard can show exactly what blocks them.
 */
export function decideVerifiability(components: Component[]): void {
  for (const c of components) {
    const r: string[] = [];
    if (c.codeLines === 0) r.push('source file is empty');
    if (c.role === 'template') r.push('template/example file, not a program of the system');
    for (const e of c.facts.embedded) r.push(`needs ${e}, which does not run in the Docker sandbox`);
    for (const i of c.includes) if (!i.file) r.push(`include ${i.name} is not in the project`);
    for (const call of c.calls) {
      if (call.file) continue;
      const platform = PLATFORM_CALLS[call.name.toUpperCase()];
      r.push(platform ? `calls ${call.name} (${platform}), which is not available in the sandbox` : `calls ${call.name}, which is not in the project`);
    }
    if (c.compile?.status === 'failed') r.push(`does not compile: ${c.compile.error ?? 'unknown error'}`);
    if (c.compile?.status === 'unavailable') r.push(`could not be compile-checked: ${c.compile.error ?? 'no toolchain'}`);
    c.deferredReasons = r;
    c.verifiable = r.length === 0;
  }
  // A program that calls a deferred program is deferred too (repeat until
  // stable). The reason is recorded even when the caller is already deferred
  // for something else, because it shapes the migration order.
  const byPath = new Map(components.map(c => [c.path, c]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of components) {
      for (const call of c.calls) {
        if (!call.file || call.file === c.path || byPath.get(call.file)!.verifiable) continue;
        const reason = `calls ${call.name}, which is deferred`;
        if (c.deferredReasons.includes(reason)) continue;
        c.deferredReasons.push(reason);
        c.verifiable = false;
        changed = true;
      }
    }
  }
}
