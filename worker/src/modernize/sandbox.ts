// Runs one program on many test inputs inside ONE locked-down container:
// build once into /tmp, then feed each case on stdin with a time limit and
// record stdout, stderr and the exit code. Used for both the legacy program
// (its own image, project mounted at /legacy) and the generated code
// (target image, code mounted at /work).
//
// Output framing: every case is wrapped in marker lines that carry a random
// nonce, so a program can't fake or break the framing by printing markers.

import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runLocked } from '../docker.ts';

export interface CaseInput {
  /** File-safe id, e.g. "07". */
  id: string;
  stdin: string;
}

export interface CaseRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface BatchResult {
  built: boolean;
  /** Build output (compiler errors) when the build failed, trimmed. */
  buildLog: string;
  cases: Map<string, CaseRun>;
  /** True when the whole container hit its time limit. */
  timedOut: boolean;
}

export interface BatchSpec {
  image: string;
  /** Shell command run once before the cases; '' to skip. */
  build: string;
  /** Shell command for one case; stdin is the case input. */
  run: string;
  /** Folder for the case files on the host (mounted read-only at /cases). */
  workDir: string;
  mounts?: { host: string; container: string }[];
  cases: CaseInput[];
  perCaseSeconds?: number;
  /** Working directory inside the container for build and run. */
  cwd?: string;
}

/** Exit code `timeout` uses when it kills a case. */
export const TIMEOUT_EXIT = 124;

export async function runBatch(spec: BatchSpec): Promise<BatchResult> {
  const casesDir = path.join(spec.workDir, 'cases');
  await rm(casesDir, { recursive: true, force: true });
  await mkdir(casesDir, { recursive: true });
  for (const c of spec.cases) await writeFile(path.join(casesDir, `${c.id}.in`), c.stdin);

  const n = `AP${randomBytes(6).toString('hex')}`;
  const per = spec.perCaseSeconds ?? 10;
  const cd = spec.cwd ? `cd '${spec.cwd.replace(/'/g, `'\\''`)}' || exit 3` : 'cd /tmp';
  const script = [
    'set -u',
    cd,
    spec.build
      ? `if ! ( ${spec.build} ) > /tmp/ap_build.log 2>&1; then printf '%s BUILD_FAIL\\n' '${n}'; head -c 4000 /tmp/ap_build.log; exit 0; fi`
      : ':',
    `printf '%s BUILD_OK\\n' '${n}'`,
    'for f in /cases/*.in; do',
    '  [ -e "$f" ] || continue',
    '  id=$(basename "$f" .in)',
    `  printf '%s CASE %s\\n' '${n}' "$id"`,
    `  timeout ${per} sh -c '${spec.run.replace(/'/g, `'\\''`)}' < "$f" 2> /tmp/ap_err.txt`,
    '  rc=$?',
    `  printf '\\n%s EXIT %s %s\\n' '${n}' "$id" "$rc"`,
    '  head -c 2000 /tmp/ap_err.txt',
    `  printf '\\n%s ENDERR %s\\n' '${n}' "$id"`,
    'done',
    `printf '%s DONE\\n' '${n}'`,
  ].join('\n');

  const total = 60 + spec.cases.length * (per + 2);
  const r = await runLocked(spec.image, ['sh', '-s'], {
    stdin: script + '\n',
    timeoutMs: total * 1000,
    mounts: [{ host: casesDir, container: '/cases' }, ...(spec.mounts ?? [])],
    execTmp: true,
  });
  return { ...parseBatch(r.stdout, n, per), timedOut: r.timedOut };
}

/** Parses the framed output of the batch script. Exported for tests. */
export function parseBatch(out: string, n: string, perCaseSeconds = 10): Omit<BatchResult, 'timedOut'> {
  const cases = new Map<string, CaseRun>();
  const failIdx = out.indexOf(`${n} BUILD_FAIL\n`);
  if (failIdx >= 0) {
    return { built: false, buildLog: out.slice(failIdx + `${n} BUILD_FAIL\n`.length).trim().slice(0, 4000), cases };
  }
  const built = out.includes(`${n} BUILD_OK\n`);
  const caseRe = new RegExp(`${n} CASE (\\S+)\\n`, 'g');
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(out))) {
    const id = m[1];
    const start = m.index + m[0].length;
    const exitMarker = `\n${n} EXIT ${id} `;
    const exitAt = out.indexOf(exitMarker, start);
    if (exitAt < 0) break; // container died mid-case
    const stdout = out.slice(start, exitAt);
    const lineEnd = out.indexOf('\n', exitAt + exitMarker.length);
    const exitCode = Number(out.slice(exitAt + exitMarker.length, lineEnd < 0 ? undefined : lineEnd));
    const errEnd = out.indexOf(`\n${n} ENDERR ${id}\n`, lineEnd);
    const stderr = errEnd > lineEnd ? out.slice(lineEnd + 1, errEnd) : '';
    cases.set(id, { stdout, stderr, exitCode, timedOut: exitCode === TIMEOUT_EXIT });
    caseRe.lastIndex = errEnd > 0 ? errEnd : exitAt;
  }
  void perCaseSeconds;
  return { built, buildLog: '', cases };
}

/**
 * What "same behaviour" means, applied to both sides before comparing:
 * line endings to LF, trailing spaces on each line removed, trailing blank
 * lines removed, and the exit code appended when it isn't 0. Everything else
 * (spacing inside lines, zero padding, number formats) must match exactly.
 */
export function canonical(stdout: string, exitCode: number): string {
  const text = stdout
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return exitCode === 0 ? text : `${text}\n[exit ${exitCode}]`;
}

export const NORMALIZATION_POLICY =
  'Outputs must match exactly after: CRLF -> LF, trailing spaces on each line removed, trailing blank lines removed. Exit codes must match.';
