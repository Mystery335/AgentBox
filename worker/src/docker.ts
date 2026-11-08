// Docker helpers. Every run of legacy or generated code uses the locked-down
// flags and passes NO environment variables, so NVIDIA_API_KEY and the
// SpacetimeDB token never reach a container.

import { spawn } from 'node:child_process';

export const LOCKDOWN_FLAGS = [
  '--rm',
  '-i',
  '--network', 'none',
  '--read-only',
  '--tmpfs', '/tmp',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--memory', '512m',
  '--cpus', '1',
  '--pids-limit', '64',
];

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Runs `docker <args>` without a shell; kills it after timeoutMs. */
export function docker(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      clearTimeout(timer);
      reject(e.message.includes('ENOENT') ? new Error('docker not found on PATH') : e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? -1,
        timedOut,
      });
    });
    child.stdin.end(opts.stdin ?? '');
  });
}

/** CRLF -> LF so outputs compare byte for byte across Windows and Linux. */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Runs a command inside an image with the locked-down flags. */
export async function runLocked(
  image: string,
  command: string[] = [],
  opts: { stdin?: string; timeoutMs?: number; mounts?: { host: string; container: string }[] } = {}
): Promise<ExecResult> {
  const mountArgs = (opts.mounts ?? []).flatMap(m => ['-v', `${m.host}:${m.container}:ro`]);
  const r = await docker(['run', ...LOCKDOWN_FLAGS, ...mountArgs, image, ...command], opts);
  return { ...r, stdout: normalize(r.stdout) };
}
