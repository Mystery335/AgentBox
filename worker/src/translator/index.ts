// Translator pipeline: analyzed run -> shared records module -> every
// verifiable program -> SpacetimeDB `translation` rows. Streams agent_event
// rows like the Analyzer, keeps the run alive for the watchdog, and leaves the
// run in status "translated" for the Verifier.
//
//   npm run translate -- [run id] [--zip path] [--only NAME,NAME] [--concurrency 3] [--dry-run]
//   npm run analyze -- legacy.zip --translate      (Analyzer, then Translator)

import { existsSync } from 'node:fs';
import path from 'node:path';
import { AGENTBOX_ROOT, dockerizeZip, listFiles } from '../dockerize.ts';
import { Stdb } from '../stdb.ts';
import { ProjectView, type LlmStats } from '../analyzer/agent.ts';
import { scanProject, type ScanResult } from '../analyzer/scan.ts';
import type { AnalyzeResult } from '../analyzer/index.ts';
import { ensureTargetImage, targetProfile } from './targets.ts';
import { translateProgram, translateShared, type Example, type ProgramToTranslate, type RuleRef, type TranslationResult } from './agent.ts';

export const SHARED_COMPONENT = '(shared)/records';

export interface TranslateContext {
  runId: string;
  extractDir: string;
  scan: ScanResult;
  targetLanguage: string;
  targetRuntime: string;
  programs: ProgramToTranslate[];
}

export interface TranslateOptions {
  only?: string[];
  concurrency?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** Real legacy outputs per program path (Verifier debug cases), shown to the Translator. */
  examples?: Map<string, Example[]>;
  /** Leave the run in "translating" instead of "translated" (the Verifier continues right away). */
  keepStatus?: boolean;
}

export interface TranslateRunResult {
  runId: string;
  targetLanguage: string;
  shared?: TranslationResult;
  programs: { name: string; path: string; fileName: string; result?: TranslationResult; error?: string }[];
}

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

const llmNote = (l: LlmStats) =>
  `${l.models.join(', ') || 'model not reported'}, ${l.turns} turns, ${l.tool_calls} tool calls, ${(l.prompt_tokens + l.completion_tokens).toLocaleString('en-US')} tokens${l.cached_turns ? `, ${l.cached_turns}/${l.turns} from cache` : ''}`;

// --------------------------------------------------------- context
/** Context straight from an Analyzer run in this process (chained mode). */
export function contextFromAnalysis(a: AnalyzeResult): TranslateContext {
  if (!a.system) throw new Error('the Analyzer did not decide a target language; nothing to translate');
  return {
    runId: a.runId,
    extractDir: a.bundle.extractDir,
    scan: a.scan,
    targetLanguage: a.system.target_language,
    targetRuntime: a.system.target_runtime,
    programs: a.components
      .filter(x => x.c.verifiable && x.a)
      .map(x => ({
        path: x.c.path,
        name: x.c.name,
        lines: x.c.lines,
        includes: x.c.includes,
        fileIO: x.c.facts.fileIO,
        takesParameters: x.c.facts.takesParameters,
        rules: x.a!.business_rules
          .map((r, i) => ({
            id: x.ruleIds[i], title: r.title, given: r.given, when: r.when, then: r.then, start: r.start_line, end: r.end_line,
            disposition: r.disposition, dispositionReason: r.disposition_reason,
          }))
          .filter(r => r.id),
        summary: x.a!.summary,
        inputs: x.a!.inputs,
        outputs: x.a!.outputs,
        risks: x.a!.risks,
        dataLayouts: x.a!.data_layouts,
        modernizationNotes: x.a!.modernization_notes,
        system: { targetReasons: a.system!.target_reasons ?? [], architecture: a.system!.architecture ?? '' },
      })),
  };
}

const micros = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : 0);
const parse = <T>(s: unknown): T => JSON.parse(String(s)) as T;

/** Context from the database: the given run, or the newest "analyzed" one. */
export async function contextFromDb(db: Stdb, runId?: string, zip?: string): Promise<TranslateContext> {
  const runs = runId
    ? await db.sql(`SELECT * FROM run WHERE id = '${runId.replace(/'/g, "''")}'`)
    : (await db.sql(`SELECT * FROM run WHERE status = 'analyzed'`)).sort((a, b) => micros(b.started_at) - micros(a.started_at));
  const run = runs[0];
  if (!run) throw new Error(runId ? `run ${runId} not found` : 'no run with status "analyzed"; run the Analyzer first');
  const id = String(run.id);
  if (!['analyzed', 'translating', 'translated'].includes(String(run.status))) {
    throw new Error(`run ${id} is "${run.status}"; the Translator needs an analyzed run`);
  }

  // The legacy source: the extract folder the Analyzer used, or re-extract the zip.
  const sha = String(run.legacy_sha256);
  let extractDir = path.join(AGENTBOX_ROOT, '.cache', 'legacy', sha.slice(0, 12));
  if (!existsSync(extractDir)) {
    if (!zip) throw new Error(`legacy source for ${id} is not in .cache/legacy; pass --zip <the same zip>`);
    const b = await dockerizeZip(zip);
    if (b.zipSha256 !== sha) throw new Error(`that zip is not the one run ${id} analyzed (sha256 differs)`);
    extractDir = b.extractDir;
  }
  const scan = await scanProject(extractDir, await listFiles(extractDir));

  const rows = await db.sql(`SELECT * FROM analysis WHERE run_id = '${id}'`);
  const system = rows.find(r => r.kind === 'system');
  if (!system) throw new Error(`run ${id} has no target-language decision (system analysis missing)`);
  const sys = parse<{ target_language: string; target_runtime: string; target_reasons?: string[]; architecture?: string }>(system.json);
  const rules = new Map((await db.sql(`SELECT * FROM rule WHERE run_id = '${id}'`)).map(r => [String(r.id), r]));

  type Comp = {
    name: string; path: string; lines: number; verifiable: boolean; includes: { name: string; file?: string }[];
    file_io: { name: string; assign: string; organization?: string }[]; takes_parameters: boolean; rule_ids: string[];
    analysis?: {
      summary: string; inputs: { name: string; description: string }[]; outputs: { name: string; description: string }[]; risks: string[];
      data_layouts?: { name: string; defined_in: string; description: string }[]; modernization_notes?: string;
      business_rules?: { disposition_reason?: string }[];
    };
  };
  const programs = rows
    .filter(r => r.kind === 'component')
    .map(r => parse<Comp>(r.json))
    .filter(c => c.verifiable && c.analysis)
    .map(c => ({
      path: c.path,
      name: c.name,
      lines: c.lines,
      includes: c.includes,
      fileIO: c.file_io,
      takesParameters: c.takes_parameters,
      // rule_ids[i] was created from analysis.business_rules[i], so the reason lines up by index.
      rules: c.rule_ids
        .map((rid, i) => ({ row: rules.get(rid), reason: c.analysis!.business_rules?.[i]?.disposition_reason }))
        .filter(x => x.row !== undefined)
        .map(({ row: r, reason }): RuleRef => ({
          id: String(r!.id), title: String(r!.title), given: String(r!.given), when: String(r!.when_), then: String(r!.then_),
          start: Number(r!.legacy_start_line), end: Number(r!.legacy_end_line), disposition: String(r!.disposition ?? 'keep'), dispositionReason: reason,
        })),
      summary: c.analysis!.summary,
      inputs: c.analysis!.inputs,
      outputs: c.analysis!.outputs,
      risks: c.analysis!.risks,
      dataLayouts: c.analysis!.data_layouts ?? [],
      modernizationNotes: c.analysis!.modernization_notes ?? '',
      system: { targetReasons: sys.target_reasons ?? [], architecture: sys.architecture ?? '' },
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { runId: id, extractDir, scan, targetLanguage: sys.target_language, targetRuntime: sys.target_runtime, programs };
}

// --------------------------------------------------------- pipeline
export async function translateRun(ctx: TranslateContext, opts: TranslateOptions = {}): Promise<TranslateRunResult> {
  const say = opts.log ?? ((m: string) => console.log(m));
  const db = new Stdb();
  if (opts.dryRun) db.call = async () => {};
  const runId = ctx.runId;
  let seq = 0;
  const stamp = Date.now().toString(36);
  const event = async (message: string) => {
    say(`[translator] ${message}`);
    try {
      await db.logEvent(`${runId}:tr-${stamp}-${String(++seq).padStart(4, '0')}`, runId, 'translator', message);
    } catch (e) {
      say(`  (event not stored: ${e instanceof Error ? e.message.slice(0, 120) : e})`);
    }
  };

  const only = opts.only?.map(s => s.toUpperCase());
  const programs = ctx.programs.filter(p => !only || only.includes(p.name));
  const profile = targetProfile(ctx.targetLanguage);
  const result: TranslateRunResult = { runId, targetLanguage: ctx.targetLanguage, programs: [] };

  await db.setRunStatus(runId, 'translating');
  const stopBeat = db.keepAlive(runId);
  try {
    await event(`Translating ${programs.length} verifiable program(s) to ${ctx.targetLanguage}${profile.check ? '' : ' (no static checker for this language)'}`);
    const image = await ensureTargetImage(profile, ctx.targetRuntime);
    await event(`Target sandbox ready: ${image} (from ${ctx.targetRuntime || profile.defaultImage})`);

    const view = new ProjectView(ctx.extractDir, ctx.scan);
    const env = {
      db,
      view,
      profile,
      image,
      targetLanguage: ctx.targetLanguage,
      workRoot: path.join(AGENTBOX_ROOT, '.cache', 'translate', runId),
    };

    // 1. Shared records module from every include the programs use.
    const includeFiles = [...new Set(programs.flatMap(p => p.includes.map(i => i.file).filter((f): f is string => !!f)))].sort();
    await event(`Translating ${includeFiles.length} shared record layout(s) into ${profile.sharedFileName}: ${includeFiles.map(f => path.posix.basename(f)).join(', ') || 'none (clock helper only)'}`);
    const shared = await translateShared(
      { ...env, onReject: p => void event(`${profile.sharedFileName}: a section was rejected (${p.split('\n')[0].slice(0, 160)}); fixing`) },
      includeFiles,
      {
        concurrency: opts.concurrency ?? 3,
        onPart: (name, part) =>
          void event(
            part.code
              ? `${profile.sharedFileName} section "${name}": ${part.code.split('\n').length} lines (${part.symbols.slice(0, 4).join(', ') || 'no symbols listed'}). Nemotron: ${llmNote(part.llm)}`
              : `${profile.sharedFileName} section "${name}": ${part.notes.slice(0, 200)}`
          ),
      }
    );
    result.shared = shared;
    await db.addTranslation({
      runId, component: SHARED_COMPONENT, name: 'RECORDS', attempt: 0, language: ctx.targetLanguage, fileName: profile.sharedFileName,
      source: shared.source, sha256: shared.sha256, checkStatus: shared.check.status, checkOutput: shared.check.output, ruleMap: shared.ruleMap, notes: shared.notes,
    });
    await event(`${profile.sharedFileName}: ${shared.source.split('\n').length} lines, ${shared.ruleMap.length} layouts, static check ${shared.check.status}. Nemotron: ${llmNote(shared.llm)}`);

    // 2. Programs, a few at a time.
    result.programs = await pool(programs, opts.concurrency ?? 3, async p => {
      const fileName = profile.fileName(p.name);
      const row: TranslateRunResult['programs'][number] = { name: p.name, path: p.path, fileName };
      await event(`Translating ${p.name} (${p.path}, ${p.lines} lines, ${p.rules.length} rules) -> ${fileName}`);
      let checks = 0;
      try {
        const attempt = (thinking: boolean) =>
          translateProgram(
            {
              ...env,
              thinking,
              onToolCall: name => {
                if (name === 'check_code') checks++;
              },
              onReject: problem => void event(`${p.name}: answer rejected (${problem.split('\n')[0].slice(0, 160)}); fixing`),
            },
            p,
            { fileName: profile.sharedFileName, source: shared.source, sections: shared.sections },
            opts.examples?.get(p.path) ?? []
          );
        // If the normal attempt fails, retry once without Nemotron's reasoning
        // phase (shorter replies, no cut-offs) before giving up on the program.
        const r = await attempt(true).catch(async e => {
          await event(`${p.name}: first attempt failed (${e instanceof Error ? e.message.slice(0, 120) : e}); retrying without reasoning`);
          return attempt(false);
        });
        row.result = r;
        await db.addTranslation({
          runId, component: p.path, name: p.name, attempt: 0, language: ctx.targetLanguage, fileName,
          source: r.source, sha256: r.sha256, checkStatus: r.check.status, checkOutput: r.check.output, ruleMap: r.ruleMap, notes: r.notes,
        });
        const mapped = new Set(r.ruleMap.map(m => m.rule_id));
        const unmapped = p.rules.filter(x => !mapped.has(x.id)).length;
        await event(
          `${p.name}: ${r.source.split('\n').length} lines, ${r.ruleMap.length}/${p.rules.length} rules mapped${unmapped ? ` (${unmapped} unmapped)` : ''}, ` +
            (r.examples ? `legacy examples ${r.examples.matched ? `${r.examples.total}/${r.examples.total} match` : 'still differ (handed to the Verifier)'} after ${r.examples.runs} run(s), ` : '') +
            `static check ${r.check.status} after ${checks} check(s). Nemotron: ${llmNote(r.llm)}`
        );
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
        await event(`${p.name}: translation failed: ${row.error.slice(0, 200)}`);
      }
      return row;
    });

    const ok = result.programs.filter(x => x.result?.check.status === 'ok').length;
    const all = [shared.llm, ...result.programs.map(x => x.result?.llm).filter((l): l is LlmStats => !!l)];
    const tokens = all.reduce((n, l) => n + l.prompt_tokens + l.completion_tokens, 0);
    await event(
      `Translation complete: ${ok}/${programs.length} programs pass the static check, ` +
        `${result.programs.filter(x => x.error).length} failed. Nemotron totals: ${[...new Set(all.flatMap(l => l.models))].join(', ')}; ` +
        `${all.reduce((n, l) => n + l.turns, 0)} model calls, ${tokens.toLocaleString('en-US')} tokens`
    );
    // Waiting status for the Verifier (the watchdog leaves it alone).
    if (!opts.keepStatus) await db.setRunStatus(runId, 'translated');
    return result;
  } finally {
    stopBeat();
  }
}
