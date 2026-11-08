// npm run demo  (from AgentBox/)
//
// Starts the dashboard (Vite dev server) and the worker (npm run serve)
// together, with their output prefixed, and stops both on Ctrl+C or when
// either one exits. No extra packages needed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parts = [
  { name: 'dashboard', dir: path.join(root, 'dashboard'), script: 'dev', color: 36 },
  { name: 'worker   ', dir: path.join(root, 'worker'), script: 'serve', color: 35 },
];

for (const p of parts) {
  if (!existsSync(path.join(p.dir, 'node_modules'))) {
    console.error(`${p.dir} has no node_modules: run "npm install" there first.`);
    process.exit(1);
  }
}
if (!existsSync(path.join(root, '.env'))) {
  console.error('AgentBox/.env is missing: copy .env.example to .env and set STDB_TOKEN (see scripts/README.md).');
  process.exit(1);
}

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // npm runs the script in a child shell: kill the whole process tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}

for (const p of parts) {
  const child = spawn('npm', ['run', p.script], { cwd: p.dir, shell: true, env: { ...process.env, TARGET_LANGUAGE: process.env.TARGET_LANGUAGE ?? 'Python 3.12' } });
  children.push(child);
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', d => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', code => {
    if (stopping) return;
    console.error(`${prefix}exited with code ${code}; stopping the demo.`);
    stopAll(code ?? 1);
  });
}

console.log('AgentBox demo: dashboard + worker starting. Open the dashboard URL below; press Ctrl+C to stop both.');
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
