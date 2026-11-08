// Usage (from AgentBox/worker):
//   npm run dockerize -- path/to/legacy.zip
//   npm run run-legacy -- agentproof-legacy:<sha12> [--stdin input.txt] [-- cmd args...]

import { readFile } from 'node:fs/promises';
import { dockerizeZip, DockerizeError } from './dockerize.ts';
import { runLocked } from './docker.ts';
import { analyzeZip } from './analyzer/index.ts';
import { contextFromAnalysis, contextFromDb, translateRun, type TranslateRunResult } from './translator/index.ts';

/** Prints a Translator summary; returns 1 if any program failed. */
function printTranslation(t: TranslateRunResult): number {
  console.log(`\ntranslation for run ${t.runId} -> ${t.targetLanguage}`);
  if (t.shared) console.log(`  shared module: static check ${t.shared.check.status}`);
  for (const p of t.programs) {
    console.log(`  ${p.name.padEnd(10)} ${p.fileName.padEnd(16)} ${p.error ? `FAILED: ${p.error.slice(0, 120)}` : `check ${p.result!.check.status}, ${p.result!.ruleMap.length} rules mapped`}`);
  }
  return t.programs.some(p => p.error) ? 1 : 0;
}
import { Stdb } from './stdb.ts';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === 'dockerize' && rest[0]) {
    try {
      const b = await dockerizeZip(rest[0]);
      const { buildLog, ...summary } = b;
      console.log(JSON.stringify({ ...summary, fileCount: b.files.length, files: b.files.slice(0, 50) }, null, 2));
      return 0;
    } catch (e) {
      if (e instanceof DockerizeError) {
        console.error(`dockerize failed: ${e.message}`);
        if (e.log) console.error(e.log.split('\n').slice(-30).join('\n'));
        return 1;
      }
      throw e;
    }
  }

  if (cmd === 'run' && rest[0]) {
    const image = rest[0];
    const stdinIdx = rest.indexOf('--stdin');
    const stdin = stdinIdx >= 0 ? await readFile(rest[stdinIdx + 1], 'utf8') : '';
    const dash = rest.indexOf('--');
    const command = dash >= 0 ? rest.slice(dash + 1) : [];
    const r = await runLocked(image, command, { stdin });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.timedOut) console.error('timed out');
    return r.exitCode;
  }

  if (cmd === 'analyze' && rest[0]) {
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const r = await analyzeZip(rest[0], {
      only: flag('--only')?.split(',').filter(Boolean),
      concurrency: flag('--concurrency') ? Number(flag('--concurrency')) : undefined,
      dryRun: rest.includes('--dry-run'),
    });
    const v = r.components.filter(x => x.c.verifiable).map(x => x.c.name);
    const failed = r.components.filter(x => x.error).map(x => x.c.name);
    console.log(`\nrun ${r.runId}`);
    console.log(`programs: ${r.components.length}, verifiable: ${v.join(', ') || 'none'}`);
    console.log(`rules: ${r.components.reduce((n, x) => n + x.ruleIds.length, 0)}${failed.length ? `, analysis failed for: ${failed.join(', ')}` : ''}`);
    if (r.system) console.log(`target: ${r.system.target_language} (${r.system.target_runtime}); first slice: ${r.system.first_slice.join(', ')}`);
    if (!rest.includes('--translate')) return failed.length || !r.system ? 1 : 0;

    // Chained: hand the analysis straight to the Translator.
    console.log('');
    const t = await translateRun(contextFromAnalysis(r), {
      only: flag('--only')?.split(',').filter(Boolean),
      dryRun: rest.includes('--dry-run'),
    });
    return printTranslation(t) || (failed.length ? 1 : 0);
  }

  if (cmd === 'translate') {
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const runId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
    const ctx = await contextFromDb(new Stdb(), runId, flag('--zip'));
    const t = await translateRun(ctx, {
      only: flag('--only')?.split(',').filter(Boolean),
      concurrency: flag('--concurrency') ? Number(flag('--concurrency')) : undefined,
      dryRun: rest.includes('--dry-run'),
    });
    return printTranslation(t);
  }

  if (cmd === 'delete-run' && rest[0]) {
    const db = new Stdb();
    for (const id of rest) {
      await db.deleteRun(id);
      console.log(`deleted ${id}`);
    }
    return 0;
  }

  console.error('usage:\n  dockerize <legacy.zip>\n  run <image> [--stdin file] [-- cmd args...]\n  analyze <legacy.zip> [--only NAME,NAME] [--concurrency N] [--dry-run] [--translate]\n  translate [run id] [--zip legacy.zip] [--only NAME,NAME] [--concurrency N] [--dry-run]\n  delete-run <run id> [<run id>...]   (permanent)');
  return 2;
}

// exitCode, not process.exit(): exiting while fetch sockets close trips a
// libuv assertion on Windows.
main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
