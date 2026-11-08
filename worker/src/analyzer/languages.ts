// Language profiles: everything language-specific the backend and Analyzer
// need, in one place. To support a new language, add a profile here; the
// scanners, Dockerfile generator and agent are generic.
//
// A profile gives:
//   - how to recognise its files (extensions + a content check)
//   - a cheap static scan of one file (includes, calls, file I/O, embedded
//     environments such as DB2 or CICS)
//   - a toolchain for the generated Dockerfile and a syntax-check command,
//     which gives real evidence of which programs can run in Docker
//
// Nemotron does the real understanding, so a language without a profile is
// still analyzed, just with less help from the scanners.

export interface FileIO {
  /** Logical name in the program, e.g. POSITION-MASTER. */
  name: string;
  /** External name, e.g. a DD name (POSMSTRE) or path. */
  assign: string;
  organization?: string;
}

export interface FileFacts {
  /** Program name declared in the source (COBOL PROGRAM-ID, C file name, ...). */
  programId?: string;
  /** Included files by the name the source uses (COPY POSREC, #include "x.h"). */
  includes: string[];
  /** Other programs/functions called by name (CALL 'ERRPROC'). */
  calls: string[];
  fileIO: FileIO[];
  /** Environments the code needs beyond the language runtime: "DB2 SQL", "CICS", ... */
  embedded: string[];
  /** True when the program is entered with parameters (COBOL PROCEDURE DIVISION USING). */
  takesParameters: boolean;
}

export interface Runtime {
  /** Dockerfile lines that install the toolchain (after FROM). */
  install: string[];
  /** Human-readable toolchain name stored in run.legacy_runtime. */
  name: string;
  /**
   * Shell commands to try, in order, to syntax-check one file inside the
   * container. `{file}` and `{includes}` are substituted. The first command
   * that exits 0 wins and its flags are recorded.
   */
  syntaxCheck: string[];
  /** Flag used to add an include directory, e.g. "-I". */
  includeFlag: string;
}

export interface LanguageProfile {
  id: string;
  name: string;
  /** Main source files (programs/modules). */
  sourceExtensions: string[];
  /** Files that are pulled into sources (copybooks, headers). */
  includeExtensions: string[];
  /** 0..1: how sure we are that `text` is this language. */
  sniff(text: string): number;
  scan(text: string): FileFacts;
  /** Maps an include name used in source (POSREC) to candidate file base names. */
  includeCandidates(name: string): string[];
  runtime?: Runtime;
}

const empty = (): FileFacts => ({ includes: [], calls: [], fileIO: [], embedded: [], takesParameters: false });
const uniq = (xs: string[]) => [...new Set(xs)];

// ------------------------------------------------------------------ COBOL
/** Strips fixed-format sequence area and comment lines; keeps free-format lines as-is. */
export function cobolCodeLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => {
    if (/^\s{6}[*/]/.test(line) || /^\s*\*>/.test(line)) return ''; // comment lines
    if (/^\s{7}\*/.test(line)) return ''; // banner comment shifted one column (common defect)
    const fixed = /^[ 0-9A-Za-z]{6}[ \-D]/.test(line) && line.length > 7;
    const code = fixed ? line.slice(7, 72) : line;
    return code.replace(/\*>.*$/, '');
  });
}

const cobol: LanguageProfile = {
  id: 'cobol',
  name: 'COBOL',
  sourceExtensions: ['.cbl', '.cob', '.cobol', '.pco', '.sqb'],
  includeExtensions: ['.cpy', '.copy', '.cpb'],
  sniff: text =>
    /\b(IDENTIFICATION|ID)\s+DIVISION\b/i.test(text) ? 1 : /\bPIC(TURE)?\s+[SX9]/i.test(text) ? 0.6 : 0,
  scan(text) {
    const f = empty();
    const code = cobolCodeLines(text).join('\n');
    f.programId = code.match(/\bPROGRAM-ID\.\s*([A-Z0-9-]+)/i)?.[1]?.toUpperCase();
    f.includes = uniq([...code.matchAll(/\bCOPY\s+["']?([A-Z0-9-]+)/gi)].map(m => m[1].toUpperCase()));
    f.calls = uniq([...code.matchAll(/\bCALL\s+['"]([A-Z0-9-]+)['"]/gi)].map(m => m[1].toUpperCase()));
    for (const m of code.matchAll(/\bSELECT\s+(?:OPTIONAL\s+)?([A-Z0-9-]+)\s+ASSIGN\s+(?:TO\s+)?["']?([A-Z0-9.$#@/-]+)["']?([\s\S]*?)\./gi)) {
      const org = m[3].match(/\bORGANIZATION\s+(?:IS\s+)?(\w+)/i)?.[1]?.toUpperCase();
      f.fileIO.push({ name: m[1].toUpperCase(), assign: m[2].toUpperCase(), ...(org ? { organization: org } : {}) });
    }
    if (/\bEXEC\s+SQL\b/i.test(code)) f.embedded.push('DB2 SQL');
    if (/\bEXEC\s+CICS\b/i.test(code)) f.embedded.push('CICS');
    if (/\bEXEC\s+DLI\b|\bCBLTDLI\b/i.test(code)) f.embedded.push('IMS');
    if (/\bMQ(OPEN|PUT|GET)\b/i.test(code)) f.embedded.push('MQ');
    f.takesParameters = /\bPROCEDURE\s+DIVISION\s+USING\b/i.test(code);
    return f;
  },
  includeCandidates: name => [name, name.toUpperCase(), name.toLowerCase()],
  runtime: {
    name: 'GnuCOBOL 3.1.2 (Debian bookworm gnucobol3)',
    install: ['RUN apt-get update && apt-get install -y --no-install-recommends gnucobol3 && rm -rf /var/lib/apt/lists/*'],
    includeFlag: '-I',
    // Fixed format (default dialect, then IBM relaxed), then free format
    // (default dialect, then IBM relaxed). The first that passes is recorded.
    syntaxCheck: [
      'cobc -fsyntax-only {includes} {file}',
      'cobc -fsyntax-only -std=ibm -frelax-syntax-checks {includes} {file}',
      'cobc -fsyntax-only -free {includes} {file}',
      'cobc -fsyntax-only -free -std=ibm -frelax-syntax-checks {includes} {file}',
    ],
  },
};

// ---------------------------------------------------------------------- C
const cLike: LanguageProfile = {
  id: 'c',
  name: 'C',
  sourceExtensions: ['.c'],
  includeExtensions: ['.h'],
  sniff: text => (/#include\s*[<"]/.test(text) ? 0.8 : /\bint\s+main\s*\(/.test(text) ? 0.6 : 0),
  scan(text) {
    const f = empty();
    f.includes = uniq([...text.matchAll(/#include\s*"([^"]+)"/g)].map(m => m[1]));
    for (const m of text.matchAll(/\bfopen\s*\(\s*"([^"]+)"/g)) f.fileIO.push({ name: m[1], assign: m[1] });
    if (/\bEXEC\s+SQL\b/i.test(text)) f.embedded.push('Embedded SQL');
    return f;
  },
  includeCandidates: name => [name.split('/').pop()!],
  runtime: {
    name: 'GCC (Debian bookworm build-essential)',
    install: ['RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*'],
    includeFlag: '-I',
    syntaxCheck: ['gcc -fsyntax-only {includes} {file}', 'gcc -std=gnu89 -fsyntax-only -w {includes} {file}'],
  },
};

// --------------------------------------------------------------- Assembly
const asm: LanguageProfile = {
  id: 'asm',
  name: 'Assembly (x86, NASM/GAS)',
  sourceExtensions: ['.asm', '.nasm', '.s', '.S'],
  includeExtensions: ['.inc', '.mac'],
  sniff: text => (/^\s*(section|segment)\s+\.?(text|data)/im.test(text) || /^\s*(mov|push|pop|call|ret)\b/im.test(text) ? 0.8 : 0),
  scan(text) {
    const f = empty();
    f.includes = uniq([...text.matchAll(/^\s*[%.]include\s+["<]?([^">\s]+)/gim)].map(m => m[1]));
    f.calls = uniq([...text.matchAll(/^\s*call\s+([A-Za-z_][\w.@]*)/gim)].map(m => m[1]));
    if (/\bint\s+0?x?80h?\b|\bsyscall\b/i.test(text)) f.embedded.push('Linux system calls');
    if (/\bint\s+21h\b/i.test(text)) f.embedded.push('DOS interrupts');
    return f;
  },
  includeCandidates: name => [name.split('/').pop()!],
  runtime: {
    name: 'NASM + GNU binutils (Debian bookworm)',
    install: ['RUN apt-get update && apt-get install -y --no-install-recommends nasm binutils gcc libc6-dev && rm -rf /var/lib/apt/lists/*'],
    includeFlag: '-I',
    syntaxCheck: ['nasm -f elf64 {includes} -o /dev/null {file}', 'as -o /dev/null {file}'],
  },
};

// ---------------------------------------------------------------- Fortran
const fortran: LanguageProfile = {
  id: 'fortran',
  name: 'Fortran',
  sourceExtensions: ['.f', '.for', '.f77', '.f90', '.f95'],
  includeExtensions: ['.inc', '.fi'],
  sniff: text => (/^\s*(program|subroutine|end\s+program)\b/im.test(text) ? 0.8 : 0),
  scan(text) {
    const f = empty();
    f.includes = uniq([...text.matchAll(/^\s*include\s+['"]([^'"]+)/gim)].map(m => m[1]));
    f.calls = uniq([...text.matchAll(/\bcall\s+([a-z_]\w*)/gi)].map(m => m[1].toUpperCase()));
    for (const m of text.matchAll(/\bopen\s*\(.*?file\s*=\s*['"]([^'"]+)/gi)) f.fileIO.push({ name: m[1], assign: m[1] });
    return f;
  },
  includeCandidates: name => [name.split('/').pop()!],
  runtime: {
    name: 'GNU Fortran (Debian bookworm gfortran)',
    install: ['RUN apt-get update && apt-get install -y --no-install-recommends gfortran && rm -rf /var/lib/apt/lists/*'],
    includeFlag: '-I',
    syntaxCheck: ['gfortran -fsyntax-only {includes} {file}', 'gfortran -fsyntax-only -std=legacy {includes} {file}'],
  },
};

export const PROFILES: LanguageProfile[] = [cobol, cLike, asm, fortran];

// --------------------------------------------- non-program file kinds
export type FileKind =
  | 'source'
  | 'include'
  | 'job-control'
  | 'database'
  | 'screen-map'
  | 'transaction-config'
  | 'build'
  | 'test-data'
  | 'documentation'
  | 'modern-code'
  | 'binary'
  | 'other';

const KIND_BY_EXT: Record<string, FileKind> = {
  '.jcl': 'job-control', '.proc': 'job-control', '.prc': 'job-control',
  '.sql': 'database', '.ddl': 'database', '.dcl': 'database',
  '.bms': 'screen-map', '.mfs': 'screen-map',
  '.csd': 'transaction-config',
  '.dat': 'test-data', '.csv': 'test-data', '.txt': 'documentation', '.in': 'test-data', '.out': 'test-data',
  '.md': 'documentation', '.rst': 'documentation', '.pdf': 'documentation', '.doc': 'documentation', '.docx': 'documentation',
  '.png': 'binary', '.jpg': 'binary', '.gif': 'binary', '.zip': 'binary', '.exe': 'binary', '.o': 'binary', '.so': 'binary',
};
const BUILD_NAMES = new Set(['makefile', 'dockerfile', 'containerfile', 'build.sh', 'cmakelists.txt', 'build.xml', 'pom.xml']);
/**
 * Modern code, scripts and config that can sit next to the legacy code (a web
 * app, CI, tooling). Never sniffed as a legacy language: a Python file that
 * generates COBOL contains "PIC X(10)" but is not a COBOL program.
 */
const MODERN_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.cs', '.go', '.rs', '.rb', '.php',
  '.sh', '.bash', '.ps1', '.bat', '.cmd', '.css', '.scss', '.html', '.htm', '.json', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.xml', '.lock', '.svg', '.webm', '.mp4', '.ipynb',
]);

export function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** Classifies a file by name, then by content for ambiguous extensions. */
export function classify(path: string, text: string | null): { kind: FileKind; language?: string } {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  const ext = extOf(path);
  if (BUILD_NAMES.has(base)) return { kind: 'build' };
  for (const p of PROFILES) {
    // .s is shared by assemblers; .inc by several languages: confirm by content.
    if (p.sourceExtensions.map(e => e.toLowerCase()).includes(ext)) return { kind: 'source', language: p.id };
    if (p.includeExtensions.includes(ext) && (ext !== '.inc' || (text && p.sniff(text) > 0.5))) {
      return { kind: 'include', language: p.id };
    }
  }
  if (MODERN_EXT.has(ext)) return { kind: 'modern-code' };
  if (KIND_BY_EXT[ext]) {
    const kind = KIND_BY_EXT[ext];
    // Text files under a test folder are test data, not docs.
    if (kind === 'documentation' && ext === '.txt' && /(^|\/)tests?(\/|$)/i.test(path)) return { kind: 'test-data' };
    return { kind };
  }
  // Unknown extension: sniff the content.
  if (text) {
    let best: LanguageProfile | undefined;
    let score = 0.5;
    for (const p of PROFILES) {
      const s = p.sniff(text);
      if (s > score) [best, score] = [p, s];
    }
    if (best) return { kind: 'source', language: best.id };
  }
  return { kind: text === null ? 'binary' : 'other' };
}

export function profile(id: string | undefined): LanguageProfile | undefined {
  return PROFILES.find(p => p.id === id);
}
