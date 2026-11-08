// Target-language profiles for generated code: which image runs it, the file
// name the Translator must use, and how to build and run it inside a
// locked-down container. /work holds the generated file (read-only) and /tmp
// is the only writable place, so builds write there.

export interface TargetProfile {
  id: string;
  /** Shown to the model and the dashboard. */
  label: string;
  image: string;
  /** File name the Translator writes. */
  file: string;
  /** Shell command that builds into /tmp ('' when nothing to build). */
  build: string;
  /** Shell command that runs the program (reads stdin, writes stdout). */
  run: string;
  /** Extra guidance for the model about this language. */
  notes: string;
}

const TARGETS: TargetProfile[] = [
  {
    id: 'python',
    label: 'Python 3.12',
    image: 'python:3.12-slim',
    file: 'main.py',
    // /work is read-only, so check syntax without writing __pycache__.
    build: `python3 -c "import ast; ast.parse(open('/work/main.py').read(), 'main.py')"`,
    run: 'PYTHONDONTWRITEBYTECODE=1 python3 /work/main.py',
    notes: 'Standard library only. Use decimal.Decimal (not float) for money, with ROUND_HALF_UP where COBOL uses ROUNDED. Read stdin with sys.stdin; write with sys.stdout.write or print. Exit codes with sys.exit(n).',
  },
  {
    id: 'java',
    label: 'Java 21',
    image: 'eclipse-temurin:21-jdk',
    file: 'Main.java',
    build: 'mkdir -p /tmp/classes && javac -d /tmp/classes /work/Main.java',
    run: 'java -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xshare:off -cp /tmp/classes Main',
    notes: 'One public class named Main. java.base only. Use BigDecimal with RoundingMode.HALF_UP for money. Read stdin with BufferedReader. Exit codes with System.exit(n).',
  },
  {
    id: 'typescript',
    label: 'TypeScript (Node 22)',
    image: 'node:22-slim',
    file: 'main.ts',
    build: '',
    run: 'node --experimental-strip-types --no-warnings /work/main.ts',
    notes: 'Type annotations only (no enums, namespaces or decorators): it runs with --experimental-strip-types. Node built-ins only (node:fs, node:readline). Read all of stdin with fs.readFileSync(0, "utf8"). Do money math in integer cents (BigInt or Number) to avoid float errors. Exit with process.exitCode = n.',
  },
  {
    id: 'javascript',
    label: 'JavaScript (Node 22)',
    image: 'node:22-slim',
    file: 'main.js',
    build: 'node --check /work/main.js',
    run: 'node /work/main.js',
    notes: 'CommonJS or ESM-free script; Node built-ins only. Read all of stdin with require("fs").readFileSync(0, "utf8"). Money math in integer cents. Exit with process.exitCode = n.',
  },
  {
    id: 'c',
    label: 'C (C17, gcc 13)',
    image: 'gcc:13',
    file: 'main.c',
    build: 'gcc -std=c17 -O1 -Wall -o /tmp/modern_prog /work/main.c -lm',
    run: '/tmp/modern_prog',
    notes: 'Standard C17 and libc only. Use integer cents (long long) for money. Read stdin with fgets/getline. Return the exit code from main.',
  },
  {
    id: 'go',
    label: 'Go 1.22',
    image: 'golang:1.22',
    file: 'main.go',
    build: 'export HOME=/tmp GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOFLAGS=-mod=mod && cd /tmp && cp /work/main.go . && go build -o /tmp/modern_prog main.go',
    run: '/tmp/modern_prog',
    notes: 'package main, standard library only. Integer cents for money. bufio.Scanner on os.Stdin. os.Exit(n) for exit codes.',
  },
];

/** Picks the profile for the Analyzer's target_language; falls back to Python. */
export function pickTarget(targetLanguage: string): { profile: TargetProfile; fallback: boolean } {
  const t = targetLanguage.toLowerCase();
  const find = (id: string) => TARGETS.find(p => p.id === id)!;
  if (/typescript|\bts\b/.test(t)) return { profile: find('typescript'), fallback: false };
  if (/javascript|node/.test(t)) return { profile: find('javascript'), fallback: false };
  if (/\bjava\b/.test(t)) return { profile: find('java'), fallback: false };
  if (/python/.test(t)) return { profile: find('python'), fallback: false };
  if (/\bgo(lang)?\b/.test(t)) return { profile: find('go'), fallback: false };
  if (/^c\b|\bc\d\d\b|\bc (language|17|11|99)/.test(t) && !/c\+\+|c#/.test(t)) return { profile: find('c'), fallback: false };
  return { profile: find('python'), fallback: true };
}

export const ALL_TARGETS = TARGETS;
