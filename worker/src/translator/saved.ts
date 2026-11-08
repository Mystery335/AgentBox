// Saved translations: hand-checked modern code for known legacy programs, so
// a demo run doesn't wait on Nemotron for the slowest step. A saved file is
// used only when the uploaded program is byte-for-byte the one it was written
// for (sha256 of the legacy source) and the target language matches. The
// Verifier and Debugger still run on it normally.
//
// Turn off with SAVED_TRANSLATIONS=0 (then the Translator agent writes the code).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuleRef } from './agent.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saved');

interface SavedEntry {
  /** TargetProfile id. */
  target: string;
  /** sha256 of the legacy program source the file was written for. */
  legacySha256: string;
  file: string;
  /** How it was checked, shown in the run's events. */
  checked: string;
}

const SAVED: SavedEntry[] = [
  {
    target: 'python',
    legacySha256: '09a92065cc50f159ae828fd31c22540f4d1de66ee36013674774f75e8d2a0066', // payroll-cobol.zip src/PAYCALC.cob
    file: 'paycalc.py',
    checked: 'matched GnuCOBOL output and exit code on 71 inputs',
  },
];

export interface SavedTranslation {
  source: string;
  checked: string;
  /** Each function with the COBOL lines its docstring says it covers. */
  functions: { name: string; line: number; legacyStart: number; legacyEnd: number }[];
}

export const savedEnabled = () => process.env.SAVED_TRANSLATIONS !== '0';

export function findSaved(target: string, legacySource: string | Buffer): SavedTranslation | undefined {
  const sha = createHash('sha256').update(legacySource).digest('hex');
  const e = SAVED.find(s => s.target === target && s.legacySha256 === sha);
  const file = e && path.join(DIR, e.file);
  if (!e || !file || !existsSync(file)) return undefined;
  const source = readFileSync(file, 'utf8');
  return { source, checked: e.checked, functions: legacyRanges(source) };
}

/** Python functions/classes and the "COBOL lines a-b" range in their docstring. */
export function legacyRanges(source: string): SavedTranslation['functions'] {
  const lines = source.split('\n');
  const out: SavedTranslation['functions'] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:def|class)\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m) continue;
    let doc = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 12) && !/^(?:def|class)\s/.test(lines[j]); j++) doc += lines[j] + ' ';
    const r = /COBOL lines (\d+)-(\d+)/.exec(doc);
    if (r) out.push({ name: m[1], line: i + 1, legacyStart: Number(r[1]), legacyEnd: Number(r[2]) });
  }
  return out;
}

/**
 * Map each Analyzer rule to the function covering its COBOL lines: the
 * smallest function range that contains the rule, else the one overlapping it most.
 */
export function mapRules(rules: Pick<RuleRef, 'id' | 'start' | 'end'>[], fns: SavedTranslation['functions']): { rule_id: string; function: string }[] {
  return rules.flatMap(r => {
    const inside = fns.filter(f => f.legacyStart <= r.start && f.legacyEnd >= r.end).sort((a, b) => a.legacyEnd - a.legacyStart - (b.legacyEnd - b.legacyStart));
    const overlap = (f: SavedTranslation['functions'][number]) => Math.min(f.legacyEnd, r.end) - Math.max(f.legacyStart, r.start);
    const best = inside[0] ?? [...fns].filter(f => overlap(f) >= 0).sort((a, b) => overlap(b) - overlap(a))[0];
    return best ? [{ rule_id: r.id, function: best.name }] : [];
  });
}
