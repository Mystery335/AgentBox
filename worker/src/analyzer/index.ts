// Analyzer pipeline: zip -> image -> scan -> compile probe -> per-program
// agent -> system agent -> SpacetimeDB. Every step is logged as an
// agent_event so the dashboard shows it live.
//
//   npm run analyze -- path/to/legacy.zip [--only NAME,NAME] [--concurrency 4]

import { randomBytes } from 'node:crypto';
import { dockerizeZip, type LegacyBundle } from '../dockerize.ts';
import { Stdb } from '../stdb.ts';
import { analyzeComponent, analyzeSystem, ProjectView, type ComponentAnalysis, type LlmStats, type SystemAnalysis } from './agent.ts';

const llmNote = (l?: LlmStats) =>
  l ? `${l.models.join(', ') || 'model not reported'}, ${l.turns} turns, ${l.tool_calls} tool calls, ${(l.prompt_tokens + l.completion_tokens).toLocaleString('en-US')} tokens (${l.reasoning_tokens.toLocaleString('en-US')} reasoning)${l.cached_turns ? `, ${l.cached_turns}/${l.turns} turns from cache` : ''}` : 'no model call (empty file)';
import { decideVerifiability, scanProject, type Component, type ScanResult } from './scan.ts';
import { probeCompile } from './runtime.ts';

export interface AnalyzeOptions {
  /** Only run the LLM on these program names (others still get scanned). */
  only?: string[];
  /** Run everything (Docker, scan, Nemotron) but skip all database writes. */
  dryRun?: boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

export interface AnalyzeResult {
  runId: string;
  bundle: LegacyBundle;
  scan: ScanResult;
  components: { c: Component; a?: ComponentAnalysis; llm?: LlmStats; error?: string; ruleIds: string[] }[];
  system?: SystemAnalysis;
  systemLlm?: LlmStats;
}

/** Runs `fn` over items with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export async function analyzeZip(zipPath: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const say = opts.log ?? ((m: string) => console.log(m));
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) throw new Error('STDB_TOKEN is empty in AgentBox/.env (see scripts/README.md)');
  // Dry run: reducer calls become no-ops; Nemotron (a procedure) still runs.
  if (opts.dryRun) db.call = async () => {};

  const runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  let seq = 0;
  // Events are best-effort: a logging failure must not stop the analysis.
  const event = async (agent: string, message: string) => {
    say(`[${agent}] ${message}`);
    try {
      await db.logEvent(`${runId}:evt-${String(++seq).padStart(4, '0')}`, runId, agent, message);
    } catch (e) {
      say(`  (event not stored: ${e instanceof Error ? e.message.slice(0, 120) : e})`);
    }
  };

  // 1. Backend: zip -> image (Dockerfile generated when missing).
  say('dockerizing...');
  const bundle = await dockerizeZip(zipPath);
  const scan = await scanProject(bundle.extractDir, bundle.files);
  const primary = scan.languages[0]?.id ?? 'unknown';
  const name = scan.root.replace(/\/$/, '') || bundle.zipPath.split(/[\\/]/).pop()!.replace(/\.zip$/i, '');

  // 2. Register the program and the run.
  const manifest = JSON.stringify({ zip: bundle.zipPath.split(/[\\/]/).pop(), root: scan.root, files: scan.inventory.map(f => f.path) });
  await db.addProgram(bundle.zipSha256, name, primary, '', manifest);
  await db.startRun(runId, name, primary, '', bundle.zipSha256, bundle.legacyRuntime, '');
  await event('backend', `Run ${runId} started for ${name}`);
  await event('backend', bundle.dockerfileGenerated
    ? `No Dockerfile in the zip; generated one for ${bundle.legacyRuntime} and built ${bundle.imageTag}`
    : `Built ${bundle.imageTag} from the zip's ${bundle.dockerfile}`);

  // 3. Static scan + compile probe -> verifiable / deferred.
  await event('analyzer', `Scanned ${scan.inventory.length} files: ${scan.components.length} programs in ${scan.languages.map(l => `${l.id} (${l.files} files, ${l.lines} lines)`).join(', ') || 'no known language'}`);
  const compile = await probeCompile(bundle.imageTag, bundle.extractDir, scan.components, scan.inventory, scan.root);
  for (const c of scan.components) c.compile = compile.get(c.path);
  decideVerifiability(scan.components);
  const ok = scan.components.filter(c => c.compile?.status === 'ok').length;
  const verifiable = scan.components.filter(c => c.verifiable);
  await event('analyzer', `Compile check in the sandbox: ${ok}/${scan.components.length} compile; ${verifiable.length} verifiable now (${verifiable.map(c => c.name).join(', ') || 'none'}), ${scan.components.length - verifiable.length} deferred`);

  await db.addAnalysis(runId, 'runtime', '', {
    image: bundle.imageTag,
    dockerfile_generated: bundle.dockerfileGenerated,
    dockerfile: bundle.dockerfileText,
    runtime: bundle.legacyRuntime,
    compile_ok: ok,
    components: scan.components.length,
  });
  await db.addAnalysis(runId, 'inventory', '', {
    root: scan.root,
    languages: scan.languages,
    files: scan.inventory,
    tests: scan.tests,
    tables: scan.tables,
  });

  // 4. Per-program agent (LLM). Scanned-only programs still get a row.
  const only = opts.only?.map(s => s.toUpperCase());
  const targets = scan.components.filter(c => !only || only.includes(c.name));
  const view = new ProjectView(bundle.extractDir, scan);
  const results = await pool(scan.components, opts.concurrency ?? 4, async c => {
    const row: AnalyzeResult['components'][number] = { c, ruleIds: [] };
    if (targets.includes(c)) {
      await event('analyzer', `Analyzing ${c.name} (${c.path}, ${c.lines} lines)`);
      try {
        const reads: string[] = [];
        const r = await analyzeComponent(
          db,
          view,
          c,
          (tool, args) => {
            if (tool === 'read_file' && args.path) reads.push(String(args.path));
          },
          problem => void event('analyzer', `${c.name}: answer rejected by validation (${problem.slice(0, 160)}); retrying`)
        );
        row.a = r.analysis;
        row.llm = r.llm;
        let n = 0;
        for (const rule of r.analysis.business_rules) {
          const id = `${runId}:${c.name}:BR-${String(++n).padStart(2, '0')}`;
          await db.addRule(id, runId, rule.title, rule.given, rule.when, rule.then, rule.start_line, rule.end_line, 0, 0, rule.disposition);
          row.ruleIds.push(id);
        }
        await event('analyzer', `${c.name}: ${r.analysis.business_rules.length} rules${reads.length ? `; read ${[...new Set(reads)].join(', ')}` : ''}. Nemotron: ${llmNote(r.llm)}`);
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
        await event('analyzer', `${c.name}: analysis failed: ${row.error.slice(0, 200)}`);
      }
    }
    await db.addAnalysis(runId, 'component', c.path, {
      name: c.name,
      path: c.path,
      language: c.language,
      area: c.area,
      role: c.role,
      lines: c.lines,
      includes: c.includes,
      calls: c.calls,
      file_io: c.facts.fileIO,
      needs: c.facts.embedded,
      takes_parameters: c.facts.takesParameters,
      jobs: c.jobs,
      compile: c.compile,
      verifiable: c.verifiable,
      deferred_reasons: c.deferredReasons,
      rule_ids: row.ruleIds,
      ...(row.llm ? { llm: row.llm } : {}),
      ...(row.a ? { analysis: row.a } : {}),
      ...(row.error ? { analysis_error: row.error } : {}),
    });
    return row;
  });

  // 5. System agent: target language, first slice, migration order.
  const result: AnalyzeResult = { runId, bundle, scan, components: results };
  await event('analyzer', 'Deciding target language and first slice');
  try {
    const { system: sys, llm: sysLlm } = await analyzeSystem(db, view, results.filter(r => targets.includes(r.c)), undefined, problem =>
      void event('analyzer', `System decision rejected by validation (${problem.slice(0, 160)}); retrying`)
    );
    result.system = sys;
    result.systemLlm = sysLlm;
    await db.setTargetLanguage(runId, sys.target_language);
    await db.addAnalysis(runId, 'system', '', { ...sys, llm: sysLlm, llm_totals: totals(results, sysLlm) });
    await db.setDocumentation(runId, documentation(name, bundle, scan, results, sys));
    await event('analyzer', `Target: ${sys.target_language} (${sys.target_runtime}). First slice: ${sys.first_slice.join(', ') || 'none'}. Nemotron: ${llmNote(sysLlm)}`);
    const t = totals(results, sysLlm);
    await event('analyzer', `Nemotron totals for this run: ${t.models.join(', ')}; ${t.calls} model calls, ${t.tool_calls} tool calls, ${(t.prompt_tokens + t.completion_tokens).toLocaleString('en-US')} tokens (${t.reasoning_tokens.toLocaleString('en-US')} reasoning)`);
  } catch (e) {
    await event('analyzer', `System analysis failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    await db.setDocumentation(runId, documentation(name, bundle, scan, results));
  }
  await event('analyzer', 'Analysis complete');
  return result;
}

/** Sums model usage over the whole run. */
function totals(rows: AnalyzeResult['components'], sys?: LlmStats) {
  const all = [...rows.map(r => r.llm).filter((l): l is LlmStats => !!l), ...(sys ? [sys] : [])];
  return {
    models: [...new Set(all.flatMap(l => l.models))],
    calls: all.reduce((n, l) => n + l.turns, 0),
    tool_calls: all.reduce((n, l) => n + l.tool_calls, 0),
    prompt_tokens: all.reduce((n, l) => n + l.prompt_tokens, 0),
    completion_tokens: all.reduce((n, l) => n + l.completion_tokens, 0),
    reasoning_tokens: all.reduce((n, l) => n + l.reasoning_tokens, 0),
    cached_turns: all.reduce((n, l) => n + l.cached_turns, 0),
  };
}

/** Markdown for run.documentation (the dashboard's "before" view). */
export function documentation(
  name: string,
  bundle: LegacyBundle,
  scan: ScanResult,
  rows: AnalyzeResult['components'],
  sys?: SystemAnalysis
): string {
  const v = rows.filter(r => r.c.verifiable);
  const d = rows.filter(r => !r.c.verifiable);
  const lines: string[] = [`# ${name}`, ''];
  if (sys) {
    lines.push('## Overview', sys.overview, '', '## Architecture', sys.architecture, '');
    lines.push(`## Target: ${sys.target_language}`, `Runtime image: \`${sys.target_runtime}\``, '', ...sys.target_reasons.map(r => `- ${r}`), '');
    if (sys.alternatives.length) lines.push('Considered and rejected:', ...sys.alternatives.map(a => `- **${a.language}**: ${a.why_not}`), '');
    lines.push('## First slice', sys.first_slice_reason, '', ...sys.first_slice.map(p => `- \`${p}\``), '');
  }
  lines.push(
    '## Legacy runtime',
    `${bundle.dockerfileGenerated ? 'Generated Dockerfile' : 'Dockerfile from the zip'}: ${bundle.legacyRuntime}. Image \`${bundle.imageTag}\`.`,
    '',
    `## Verifiable now (${v.length})`,
    ...(v.length ? v.map(r => `- **${r.c.name}** (\`${r.c.path}\`): ${r.a?.summary ?? ''}`) : ['- none']),
    '',
    `## Deferred (${d.length})`,
    ...d.map(r => `- **${r.c.name}** (\`${r.c.path}\`): ${r.c.deferredReasons.join('; ')}`),
    ''
  );
  if (sys) {
    lines.push('## Migration order', ...sys.migration_order.map(s => `${s.step}. ${s.components.join(', ')}: ${s.note}`), '');
    lines.push('## Existing tests', sys.existing_tests, '');
    if (sys.risks.length) lines.push('## Risks', ...sys.risks.map(r => `- ${r}`), '');
  }
  lines.push(
    '## Inventory',
    `${scan.inventory.length} files; languages: ${scan.languages.map(l => `${l.id} ${l.files} files / ${l.lines} lines`).join(', ')}. Tables: ${scan.tables.map(t => t.name).join(', ') || 'none'}.`
  );
  return lines.join('\n');
}
