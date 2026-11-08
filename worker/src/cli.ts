// Usage (from AgentBox/worker):
//   npm run dockerize -- path/to/legacy.zip
//   npm run run-legacy -- agentproof-legacy:<sha12> [--stdin input.txt] [-- cmd args...]

import { readFile } from 'node:fs/promises';
import { dockerizeZip, DockerizeError } from './dockerize.ts';
import { runLocked } from './docker.ts';

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

  console.error('usage:\n  dockerize <legacy.zip>\n  run <image> [--stdin file] [-- cmd args...]');
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code));
