// Target-language profiles for the Translator: file naming, the image that
// compiles/lints the code, the static-check command, and the conventions the
// generated code must follow so the Verifier can run old and new code the
// same way. The Analyzer picks the target language; this maps it to a profile.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT } from '../dockerize.ts';
import { docker, runLocked } from '../docker.ts';

export interface TargetProfile {
  id: 'python' | 'java' | 'c' | 'generic';
  /** Image for checks when the Analyzer didn't name a usable one. */
  defaultImage: string;
  /** Extra Dockerfile lines on top of the runtime image (tools for checks). */
  install: string[];
  fileName(programName: string): string;
  sharedFileName: string;
  /** Shell command run in the check container with the code mounted at /work. Exit 0 = pass. */
  check: string;
  /** How the Verifier runs a translated program (documented for it and the prompt). */
  runCommand(programName: string): string;
  /** Language-specific rules for the generated code. */
  conventions: string;
}

const lower = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const pascal = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');

const PYTHON: TargetProfile = {
  id: 'python',
  defaultImage: 'python:3.12-slim',
  install: ['RUN pip install --no-cache-dir ruff==0.6.9'],
  fileName: n => `${lower(n)}.py`,
  sharedFileName: 'records.py',
  // Compile without writing .pyc (the mount is read-only), then pyflakes-level
  // errors only: syntax, undefined names, bad comparisons. Style is not checked
  // (repeated imports across sections are fine).
  check:
    'cd /work && python -c "import sys; [compile(open(f, encoding=\'utf-8\').read(), f, \'exec\') for f in sys.argv[1:]]" *.py ' +
    '&& ruff check --no-cache --quiet --output-format concise --select E9,F63,F7,F82 .',
  runCommand: n => `python ${lower(n)}.py [args...]`,
  conventions: `- Python 3.12, standard library only (no pip packages; the sandbox has no network).
- Money and every COBOL numeric with decimals: decimal.Decimal, never float. Set precision high enough (decimal.getcontext().prec = 34).
- COBOL truncates on MOVE/COMPUTE unless ROUNDED; ROUNDED is half away from zero (Decimal ROUND_HALF_UP). Reproduce exactly.
- Records: dataclasses with parse(line) / format() for fixed-width layouts, imported from records.py.
- Entry point: def main() -> int, and at the bottom: if __name__ == "__main__": sys.exit(main())
- Type hints and short docstrings; no global mutable state beyond what the COBOL WORKING-STORAGE needs.`,
};

const JAVA: TargetProfile = {
  id: 'java',
  defaultImage: 'eclipse-temurin:21-jdk',
  install: [],
  fileName: n => `${pascal(n)}.java`,
  sharedFileName: 'Records.java',
  check: 'mkdir -p /tmp/out && javac -Xlint:none -d /tmp/out /work/*.java',
  runCommand: n => `java -cp <compiled classes> ${pascal(n)} [args...]`,
  conventions: `- Java 21, JDK only (no Maven dependencies; the sandbox has no network). No package declaration.
- Money: java.math.BigDecimal, never double. COBOL truncation = RoundingMode.DOWN; ROUNDED = RoundingMode.HALF_UP.
- Records: records/classes with static parse(String line) and format() in Records.java (one top-level public class Records with nested static classes).
- Entry point: public static void main(String[] args), exit with System.exit(code).`,
};

const C: TargetProfile = {
  id: 'c',
  defaultImage: 'gcc:14',
  install: [],
  fileName: n => `${lower(n)}.c`,
  sharedFileName: 'records.h',
  check: 'cd /work && gcc -fsyntax-only -std=c17 -Wall -Werror=implicit-function-declaration *.c',
  runCommand: n => `./${lower(n)} [args...] (built from ${lower(n)}.c)`,
  conventions: `- C17, libc only. Money in integer minor units (int64_t cents or scaled integers), never double.
- Records: structs plus parse/format functions as static inline functions in records.h.
- Entry point: int main(int argc, char **argv) returning the exit code.`,
};

const GENERIC: TargetProfile = {
  id: 'generic',
  defaultImage: 'debian:bookworm-slim',
  install: [],
  fileName: n => `${lower(n)}.txt`,
  sharedFileName: 'records.txt',
  check: 'true',
  runCommand: n => `(no runner for this language) ${lower(n)}`,
  conventions: '- Use the target language idiomatically, standard library only.',
};

/** Maps the Analyzer's target language ("Python 3.12", "Java 21", "C (C17)") to a profile. */
export function targetProfile(language: string): TargetProfile {
  const l = language.toLowerCase();
  if (/python/.test(l)) return PYTHON;
  if (/\bjava\b/.test(l)) return JAVA;
  if (/^c\b|\bc\s*\(|\bc1[17]\b|\bc99\b/.test(l)) return C;
  return GENERIC;
}

/** The interface every translated program must keep, whatever the language. */
export const RUN_CONTRACT = `The Verifier runs the legacy program and your program with the SAME inputs and compares EVERYTHING they produce. For a test to pass, all of these must be byte-for-byte identical:
- stdout (COBOL DISPLAY), including spacing, leading zeros, signs and edited PICTURE formats (e.g. Z,ZZ9.99, $$$,$$9.99, +ZZ9).
- every file written or rewritten in the working directory (same file names as the COBOL ASSIGN TO names, same record lengths and padding). GnuCOBOL LINE SEQUENTIAL writes drop trailing spaces and end each record with "\\n".
- the exit code (COBOL RETURN-CODE / STOP RUN).
Inputs your program must read exactly like the COBOL does:
- files in the current working directory, by their ASSIGN TO names;
- ACCEPT ... FROM COMMAND-LINE = all command-line arguments joined with single spaces;
- ACCEPT ... FROM ENVIRONMENT / environment variables;
- ACCEPT ... FROM STANDARD-INPUT / stdin, line by line;
- ACCEPT ... FROM DATE / TIME / DATE YYYYMMDD: use the shared module's clock helper, which honours the COB_CURRENT_DATE environment variable (the Verifier sets it so both programs see the same date).
Do not add, remove or reword any output. Keep the legacy behaviour even where it looks like a bug; note such cases in "notes".`;

/** Builds (once) the image that runs the static checks for a target. */
export async function ensureTargetImage(p: TargetProfile, runtimeImage: string): Promise<string> {
  const base = runtimeImage && /^[a-z0-9][\w./:-]*$/i.test(runtimeImage) ? runtimeImage : p.defaultImage;
  const dockerfile = [`FROM ${base}`, ...p.install, 'WORKDIR /work', ''].join('\n');
  const hash = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);
  const tag = `agentproof-target:${hash}`;
  const exists = await docker(['image', 'inspect', tag], { timeoutMs: 30_000 });
  if (exists.exitCode === 0) return tag;
  const dir = path.join(AGENTBOX_ROOT, '.cache', 'targets', hash);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'Dockerfile'), dockerfile);
  const built = await docker(['build', '-q', '-t', tag, dir], { timeoutMs: 15 * 60_000 });
  if (built.exitCode !== 0) throw new Error(`could not build target image from ${base}: ${(built.stderr || built.stdout).slice(-400)}`);
  return tag;
}

export interface CheckResult {
  status: 'ok' | 'failed' | 'unavailable';
  output: string;
}

/**
 * Writes the files to a scratch folder and runs the profile's static check in
 * a locked-down container (no network, read-only mount, no env vars).
 */
export async function checkFiles(p: TargetProfile, image: string, workDir: string, files: Record<string, string>): Promise<CheckResult> {
  if (p.id === 'generic') return { status: 'unavailable', output: 'no static check for this target language' };
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(workDir, name), text);
  const r = await runLocked(image, ['sh', '-c', p.check], { mounts: [{ host: workDir, container: '/work' }], timeoutMs: 90_000 });
  if (r.timedOut) return { status: 'failed', output: 'static check timed out' };
  const output = (r.stdout + r.stderr).replace(/\/work\//g, '').trim();
  return { status: r.exitCode === 0 ? 'ok' : 'failed', output: output.slice(0, 4000) };
}
