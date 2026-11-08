// Target-language profiles: everything the Translator, the Verifier and the
// Debugger need to know about the language the code is translated into.
//   - file naming (one file per program + one shared records module)
//   - the image that checks, builds and runs the code (no network, read-only)
//   - the static check the Translator must pass before handing code over
//   - how the Verifier builds and runs a program (stdin in, stdout + exit code out)
//   - language conventions for the generated code
// The Analyzer picks the target language; pickTarget maps it to a profile and
// falls back to Python when there is no profile, so the code can always run.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTBOX_ROOT } from '../dockerize.ts';
import { docker, runLocked } from '../docker.ts';

export interface TargetProfile {
  id: 'python' | 'java' | 'c' | 'typescript' | 'javascript' | 'go';
  /** Shown to the model and the dashboard. */
  label: string;
  /** Image when the Analyzer didn't name a usable one. */
  defaultImage: string;
  /** Extra Dockerfile lines on top of the runtime image (tools for checks). */
  install: string[];
  fileName(programName: string): string;
  sharedFileName: string;
  /** Shell command run with the code mounted read-only at /work. Exit 0 = pass. '' = no static check. */
  check: string;
  /** Verifier: build command for one program file ('' = nothing to build). /tmp is the only writable place. */
  build(file: string): string;
  /** Verifier: run command for one program file (stdin in, stdout + exit code out). */
  run(file: string): string;
  /** Language-specific rules for the generated code. */
  conventions: string;
  /**
   * Fixed "base" section of the shared module (clock, COBOL number helpers).
   * When set, it is used as-is instead of asking Nemotron to write one: faster,
   * identical every run, and smaller prompts for every later agent turn.
   */
  baseTemplate?: string;
}

/** Python base section of records.py: the helpers every translated program may use. */
const PYTHON_BASE = `"""Shared helpers for translated COBOL programs (records.py, base section).

Generated from a fixed template. Copybook layouts follow in their own sections.
"""
import os
import sys
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, getcontext

getcontext().prec = 34


def cob_now() -> datetime:
    """Current date/time. Honours COB_CURRENT_DATE ("YYYY/MM/DD hh:mm:ss" or
    "YYYYMMDDhhmmss"), the same variable GnuCOBOL uses, so tests can pin it."""
    raw = os.environ.get("COB_CURRENT_DATE", "").strip()
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y%m%d%H%M%S", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            pass
    return datetime.now()


def accept_date() -> str:
    """ACCEPT ... FROM DATE (YYMMDD)."""
    return cob_now().strftime("%y%m%d")


def accept_date_yyyymmdd() -> str:
    """ACCEPT ... FROM DATE YYYYMMDD."""
    return cob_now().strftime("%Y%m%d")


def accept_time() -> str:
    """ACCEPT ... FROM TIME (HHMMSSss)."""
    now = cob_now()
    return now.strftime("%H%M%S") + f"{now.microsecond // 10000:02d}"


def cob_truncate(value: Decimal, places: int) -> Decimal:
    """MOVE / COMPUTE without ROUNDED: drop extra decimals (toward zero)."""
    return Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_DOWN)


def cob_round(value: Decimal, places: int) -> Decimal:
    """COMPUTE ... ROUNDED: half away from zero."""
    return Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def fit_digits(value: Decimal, int_digits: int, places: int) -> Decimal:
    """Store into PIC 9(int_digits)V9(places): truncate decimals and drop
    high-order digits that don't fit (COBOL size truncation, no ON SIZE ERROR)."""
    v = cob_truncate(value, places)
    limit = Decimal(10) ** int_digits
    sign = -1 if v < 0 else 1
    return sign * (abs(v) % limit)


def display_unsigned(value: Decimal, int_digits: int, places: int = 0) -> str:
    """DISPLAY of PIC 9(int_digits)V9(places): zero-padded digits, no point."""
    v = fit_digits(abs(Decimal(value)), int_digits, places)
    return f"{int(v * (Decimal(10) ** places)):0{int_digits + places}d}"


def edit_z(value: Decimal, z_digits: int, places: int = 0) -> str:
    """Edited picture Z(z_digits)9[.9(places)], e.g. Z(4)9 or Z(6)9.99:
    fixed width, leading zeros become spaces, the last integer digit always
    prints. Unsigned (the sign is dropped, as COBOL does for these pictures)."""
    v = fit_digits(abs(Decimal(value)), z_digits + 1, places)
    text = f"{v:.{places}f}" if places else f"{int(v)}"
    width = z_digits + 1 + (places + 1 if places else 0)
    return text.rjust(width)


def to_decimal(text: str, places: int = 0) -> Decimal:
    """Unsigned DISPLAY digits with an implied decimal point (PIC 9(n)V9(places))."""
    return Decimal(int(text)) / (Decimal(10) ** places)


def is_numeric(text: str) -> bool:
    """COBOL IS NUMERIC for an unsigned DISPLAY field: digits only, not empty."""
    return text != "" and text.isdigit()


def pic_x(text: str, width: int) -> str:
    """PIC X(width): pad with spaces or cut to width."""
    return text[:width].ljust(width)


__all__ = [
    "Decimal", "ROUND_DOWN", "ROUND_HALF_UP", "dataclass", "sys",
    "cob_now", "accept_date", "accept_date_yyyymmdd", "accept_time",
    "cob_truncate", "cob_round", "fit_digits", "display_unsigned", "edit_z",
    "to_decimal", "is_numeric", "pic_x",
]`;

const lower = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const pascal = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const stem = (file: string) => file.replace(/\.[^.]+$/, '');
const GO_ENV = 'export HOME=/tmp GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOFLAGS=-mod=mod';
const GO_BUILD = `${GO_ENV} && rm -rf /tmp/src && mkdir -p /tmp/src && cp /work/*.go /tmp/src/ && cd /tmp/src && (test -f go.mod || go mod init modern >/dev/null 2>&1) && go build -o /tmp/modern_prog .`;

const PYTHON: TargetProfile = {
  id: 'python',
  label: 'Python 3.12',
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
  build: () => '',
  run: f => `PYTHONDONTWRITEBYTECODE=1 python3 /work/${f}`,
  conventions: `- Python 3.12, standard library only (no pip packages; the sandbox has no network).
- Money and every COBOL numeric with decimals: decimal.Decimal, never float. Set precision high enough (decimal.getcontext().prec = 34).
- COBOL truncates on MOVE/COMPUTE unless ROUNDED (truncate toward zero: ROUND_DOWN); ROUNDED is half away from zero (ROUND_HALF_UP).
- Records: dataclasses with parse(line) / format() for fixed-width layouts, imported from records.py (from records import ...).
- Read stdin with sys.stdin; write with sys.stdout.write or print. Exit codes with sys.exit(n).
- Entry point: def main() -> int, and at the bottom: if __name__ == "__main__": sys.exit(main())
- records.py already has: cob_now, accept_date, accept_time, cob_truncate, cob_round, fit_digits, display_unsigned, edit_z (Z(n)9.99 pictures), to_decimal, is_numeric, pic_x. Use them instead of rewriting them.`,
  baseTemplate: PYTHON_BASE,
};

const JAVA: TargetProfile = {
  id: 'java',
  label: 'Java 21',
  defaultImage: 'eclipse-temurin:21-jdk',
  install: [],
  fileName: n => `${pascal(n)}.java`,
  sharedFileName: 'Records.java',
  check: 'mkdir -p /tmp/out && javac -Xlint:none -d /tmp/out /work/*.java',
  build: () => 'mkdir -p /tmp/classes && javac -d /tmp/classes /work/*.java',
  run: f => `java -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xshare:off -cp /tmp/classes ${stem(f)}`,
  conventions: `- Java 21, java.base only (no Maven dependencies; the sandbox has no network). No package declaration.
- The program file declares one public class named after the file, with public static void main(String[] args) throws Exception.
- Money: java.math.BigDecimal, never double. COBOL truncation = RoundingMode.DOWN; ROUNDED = RoundingMode.HALF_UP.
- Records: one public class Records with nested static classes, each with static parse(String line) and format().
- Read stdin with BufferedReader. Exit codes with System.exit(n).`,
};

const C: TargetProfile = {
  id: 'c',
  label: 'C (C17)',
  defaultImage: 'gcc:14',
  install: [],
  fileName: n => `${lower(n)}.c`,
  sharedFileName: 'records.h',
  check: 'cd /work && gcc -fsyntax-only -std=c17 -Wall -Werror=implicit-function-declaration -I /work *.c',
  build: f => `gcc -std=c17 -O1 -I /work -o /tmp/modern_prog /work/${f} -lm`,
  run: () => '/tmp/modern_prog',
  conventions: `- C17, libc only. Money in integer minor units (int64_t / long long cents), never double.
- Records: structs plus parse/format functions as static inline functions in records.h (#include "records.h").
- Read stdin with fgets/getline. Entry point: int main(int argc, char **argv) returning the exit code.`,
};

const TYPESCRIPT: TargetProfile = {
  id: 'typescript',
  label: 'TypeScript (Node 22)',
  defaultImage: 'node:22-slim',
  install: [],
  fileName: n => `${lower(n)}.ts`,
  sharedFileName: 'records.ts',
  // Node runs TypeScript by stripping types; there is no type checker in the image.
  check: '',
  build: () => '',
  run: f => `node --experimental-strip-types --no-warnings /work/${f}`,
  conventions: `- Type annotations only (no enums, namespaces, parameter properties or decorators): it runs with --experimental-strip-types.
- Node built-ins only. Import the shared module with: import { ... } from './records.ts';
- Read all of stdin with fs.readFileSync(0, 'utf8'). Money in integer cents (BigInt) to avoid float errors. Exit with process.exitCode = n.`,
};

const JAVASCRIPT: TargetProfile = {
  id: 'javascript',
  label: 'JavaScript (Node 22)',
  defaultImage: 'node:22-slim',
  install: [],
  fileName: n => `${lower(n)}.js`,
  sharedFileName: 'records.js',
  check: 'for f in /work/*.js; do node --check "$f" || exit 1; done',
  build: () => '',
  run: f => `node /work/${f}`,
  conventions: `- CommonJS, Node built-ins only. The shared module exports with module.exports; import it with require('./records.js').
- Read all of stdin with require('fs').readFileSync(0, 'utf8'). Money in integer cents (BigInt). Exit with process.exitCode = n.`,
};

const GO: TargetProfile = {
  id: 'go',
  label: 'Go 1.22',
  defaultImage: 'golang:1.22',
  install: [],
  fileName: n => `${lower(n)}.go`,
  sharedFileName: 'records.go',
  check: GO_BUILD,
  build: () => GO_BUILD,
  run: () => '/tmp/modern_prog',
  conventions: `- package main in every file, standard library only. The shared records.go has no main(); the program file has func main().
- Money in integer cents (int64). bufio.Scanner on os.Stdin. os.Exit(n) for exit codes.`,
};

export const ALL_TARGETS: TargetProfile[] = [PYTHON, JAVA, C, TYPESCRIPT, JAVASCRIPT, GO];

/** Maps the Analyzer's target language to a profile; unknown languages fall back to Python. */
export function pickTarget(targetLanguage: string): { profile: TargetProfile; fallback: boolean } {
  const t = targetLanguage.toLowerCase();
  const find = (id: TargetProfile['id']) => ALL_TARGETS.find(p => p.id === id)!;
  if (/typescript|\bts\b/.test(t)) return { profile: find('typescript'), fallback: false };
  if (/javascript|node/.test(t)) return { profile: find('javascript'), fallback: false };
  if (/\bjava\b/.test(t)) return { profile: find('java'), fallback: false };
  if (/python/.test(t)) return { profile: find('python'), fallback: false };
  if (/\bgo(lang)?\b/.test(t)) return { profile: find('go'), fallback: false };
  if (/^c\b|\bc\s*\(|\bc\d\d\b|\bc (language|17|11|99)/.test(t) && !/c\+\+|c#/.test(t)) return { profile: find('c'), fallback: false };
  return { profile: PYTHON, fallback: true };
}

/** Shorthand used by the Translator. */
export const targetProfile = (language: string): TargetProfile => pickTarget(language).profile;

/** How the Verifier compares outputs (applied to both sides). */
export const NORMALIZATION_POLICY =
  'Outputs must match exactly after: CRLF -> LF, trailing spaces on each line removed, trailing blank lines removed. Exit codes must match.';

/** The interface every translated program must keep, whatever the language. */
export const RUN_CONTRACT = `The Verifier runs the legacy program and your program with the SAME inputs and compares what they produce. For a test to pass these must be identical:
- stdout (COBOL DISPLAY), including spacing, column alignment, leading zeros, signs and number formats. ${NORMALIZATION_POLICY}
- the exit code (COBOL RETURN-CODE / STOP RUN).
COBOL output rules that are easy to get wrong:
- Edited pictures have a FIXED width: Z(4)9 is 5 characters, Z(6)9.99 is 10, Z(8)9.99 is 12. Z positions turn leading zeros into spaces, but 9 positions always print a digit, so zero prints as "    0" in Z(4)9 and "      0.00" in Z(6)9.99.
- DISPLAY of a PIC X(n) field prints all n characters (trailing spaces included). Alphanumeric literals print exactly as written.
Inputs must be read exactly like the COBOL does:
- ACCEPT ... FROM STANDARD-INPUT / plain ACCEPT: stdin, line by line, with the same handling of short lines and terminator lines (e.g. END);
- ACCEPT ... FROM COMMAND-LINE = all command-line arguments joined with single spaces; ACCEPT ... FROM ENVIRONMENT = environment variables;
- files in the current working directory, by their ASSIGN TO names, same record lengths and padding (LINE SEQUENTIAL writes drop trailing spaces);
- ACCEPT ... FROM DATE / TIME: use the shared module's clock helper, which honours COB_CURRENT_DATE so both programs see the same date.
Do not add, remove or reword any output. Keep the legacy behaviour even where it looks like a bug; note such cases in "notes".`;

/** Builds (once) the image that checks, builds and runs code for a target. */
export async function ensureTargetImage(p: TargetProfile, runtimeImage: string): Promise<string> {
  // Use the Analyzer's image only when it is for this profile's language
  // (after a Python fallback, a "gcc" image would be wrong).
  const family = runtimeImage.toLowerCase();
  const sameFamily = !!runtimeImage && family.includes(p.defaultImage.split(':')[0].replace(/^eclipse-/, ''));
  const base = sameFamily && /^[a-z0-9][\w./:-]*$/i.test(runtimeImage) ? runtimeImage : p.defaultImage;
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
 * a locked-down container (no network, read-only mount, no env vars; /tmp is
 * writable and executable for compilers).
 */
export async function checkFiles(p: TargetProfile, image: string, workDir: string, files: Record<string, string>): Promise<CheckResult> {
  if (!p.check) return { status: 'unavailable', output: `no static check for ${p.label}` };
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(workDir, name), text);
  const r = await runLocked(image, ['sh', '-c', p.check], { mounts: [{ host: workDir, container: '/work' }], timeoutMs: 120_000, execTmp: true });
  if (r.timedOut) return { status: 'failed', output: 'static check timed out' };
  const output = (r.stdout + r.stderr).replace(/\/work\//g, '').replace(/\/tmp\/src\//g, '').trim();
  return { status: r.exitCode === 0 ? 'ok' : 'failed', output: output.slice(0, 4000) };
}
