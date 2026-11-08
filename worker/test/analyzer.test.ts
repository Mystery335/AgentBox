import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { classify, cobolCodeLines, profile } from '../src/analyzer/languages.ts';
import { decideVerifiability, scanProject } from '../src/analyzer/scan.ts';
import { detectLanguages, generateDockerfile, shq } from '../src/analyzer/runtime.ts';
import { validateComponent } from '../src/analyzer/agent.ts';

const COBOL = [
  '       IDENTIFICATION DIVISION.',
  '       PROGRAM-ID. PAYCALC.',
  '      * a comment with COPY FAKE and CALL \'NOPE\'',
  '       ENVIRONMENT DIVISION.',
  '       FILE-CONTROL.',
  '           SELECT PAY-FILE ASSIGN TO PAYIN',
  '               ORGANIZATION IS SEQUENTIAL.',
  '       DATA DIVISION.',
  '       WORKING-STORAGE SECTION.',
  '           COPY PAYREC.',
  '       PROCEDURE DIVISION.',
  "           CALL 'HELPER' USING WS-X",
  "           CALL 'ILBOABN0'",
  '           EXEC SQL SELECT 1 INTO :X FROM T END-EXEC',
  '           STOP RUN.',
].join('\n');

describe('languages', () => {
  it('classifies by extension and content', () => {
    assert.deepEqual(classify('src/a.cbl', COBOL), { kind: 'source', language: 'cobol' });
    assert.deepEqual(classify('cpy/PAYREC.cpy', '01 X PIC 9.'), { kind: 'include', language: 'cobol' });
    assert.deepEqual(classify('jcl/run.jcl', '//JOB'), { kind: 'job-control' });
    assert.deepEqual(classify('x/main.c', '#include <stdio.h>'), { kind: 'source', language: 'c' });
    assert.deepEqual(classify('boot.asm', 'section .text\nmov eax, 1'), { kind: 'source', language: 'asm' });
    assert.deepEqual(classify('PAYCALC', COBOL), { kind: 'source', language: 'cobol' }); // no extension: sniffed
    assert.deepEqual(classify('logo.png', null), { kind: 'binary' });
    assert.deepEqual(classify('src/tests/case1.txt', 'x'), { kind: 'test-data' });
  });

  it('ignores COBOL comment lines, incl. banners shifted one column', () => {
    const code = cobolCodeLines('      * COPY A\n       * COPY B\n           COPY C.').join('\n');
    assert.ok(!code.includes('COPY A') && !code.includes('COPY B') && code.includes('COPY C'));
  });

  it('scans COBOL facts', () => {
    const f = profile('cobol')!.scan(COBOL);
    assert.equal(f.programId, 'PAYCALC');
    assert.deepEqual(f.includes, ['PAYREC']);
    assert.deepEqual(f.calls, ['HELPER', 'ILBOABN0']);
    assert.deepEqual(f.fileIO, [{ name: 'PAY-FILE', assign: 'PAYIN', organization: 'SEQUENTIAL' }]);
    assert.deepEqual(f.embedded, ['DB2 SQL']);
  });

  it('scans C and assembly includes/calls', () => {
    assert.deepEqual(profile('c')!.scan('#include "pay.h"\n#include <stdio.h>').includes, ['pay.h']);
    const a = profile('asm')!.scan('%include "io.inc"\n  call print_int\n  syscall');
    assert.deepEqual(a.includes, ['io.inc']);
    assert.deepEqual(a.calls, ['print_int']);
    assert.deepEqual(a.embedded, ['Linux system calls']);
  });
});

describe('scanProject + decideVerifiability', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentproof-scan-'));
  after(() => rm(dir, { recursive: true, force: true }));
  const put = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  await put('proj/src/programs/batch/PAYCALC.cbl', COBOL);
  await put('proj/src/programs/batch/HELPER.cbl', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELPER.\n       PROCEDURE DIVISION USING X.\n           GOBACK.');
  await put('proj/src/programs/batch/EMPTY.cbl', '   \n');
  await put('proj/src/templates/SKEL.cbl', '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. SKEL.');
  await put('proj/src/copybook/PAYREC.cpy', '       01 PAY-REC PIC X(10).');
  await put('proj/jcl/PAY.jcl', '//STEP1 EXEC PGM=PAYCALC');
  await put('proj/sql/t.sql', 'CREATE TABLE PAY_HIST (ID INT);');
  const files = ['proj/src/programs/batch/PAYCALC.cbl', 'proj/src/programs/batch/HELPER.cbl', 'proj/src/programs/batch/EMPTY.cbl', 'proj/src/templates/SKEL.cbl', 'proj/src/copybook/PAYREC.cpy', 'proj/jcl/PAY.jcl', 'proj/sql/t.sql'];
  const s = await scanProject(dir, files);
  const by = (n: string) => s.components.find(c => c.name === n)!;

  it('finds the root, components, links and tables', () => {
    assert.equal(s.root, 'proj/');
    assert.deepEqual(s.components.map(c => c.name).sort(), ['EMPTY', 'HELPER', 'PAYCALC', 'SKEL']);
    assert.deepEqual(by('PAYCALC').includes, [{ name: 'PAYREC', file: 'src/copybook/PAYREC.cpy' }]);
    assert.deepEqual(by('PAYCALC').calls, [{ name: 'HELPER', file: 'src/programs/batch/HELPER.cbl' }, { name: 'ILBOABN0' }]);
    assert.deepEqual(by('PAYCALC').jobs, ['jcl/PAY.jcl']);
    assert.equal(by('PAYCALC').area, 'batch');
    assert.deepEqual(s.tables, [{ name: 'PAY_HIST', file: 'sql/t.sql' }]);
    assert.deepEqual(detectLanguages(s.inventory), ['cobol']);
  });

  it('defers with reasons; callers of deferred programs are deferred', () => {
    for (const c of s.components) c.compile = { status: 'ok' };
    by('HELPER').compile = { status: 'failed', error: 'boom' };
    decideVerifiability(s.components);
    assert.equal(by('EMPTY').verifiable, false);
    assert.match(by('EMPTY').deferredReasons.join(), /empty/);
    assert.match(by('SKEL').deferredReasons.join(), /template/);
    assert.match(by('HELPER').deferredReasons.join(), /does not compile: boom/);
    const pay = by('PAYCALC').deferredReasons.join(' | ');
    assert.match(pay, /DB2 SQL/);
    assert.match(pay, /ILBOABN0 \(IBM Language Environment/);
    assert.match(pay, /calls HELPER, which is deferred/);
  });

  it('marks a clean program verifiable', () => {
    by('HELPER').compile = { status: 'ok' };
    by('HELPER').deferredReasons = [];
    decideVerifiability(s.components);
    assert.equal(by('HELPER').verifiable, true);
  });
});

describe('runtime', () => {
  it('generates a Dockerfile with each toolchain once', () => {
    const g = generateDockerfile(['cobol', 'c']);
    assert.match(g.dockerfile, /^FROM debian:bookworm-slim$/m);
    assert.match(g.dockerfile, /gnucobol3/);
    assert.match(g.dockerfile, /build-essential/);
    assert.match(g.dockerfile, /^COPY \. \/legacy$/m);
    assert.match(g.runtime, /GnuCOBOL.*GCC/);
  });
  it('quotes for sh', () => {
    assert.equal(shq("a'b c"), `'a'\\''b c'`);
  });
});

describe('validateComponent', () => {
  const rule = { title: 't', given: 'g', when: 'w', then: 'x', start_line: 2, end_line: 3, disposition: 'keep', disposition_reason: 'r' };
  const base = { summary: 'Does a thing for the business, clearly.', inputs: [], outputs: [], data_layouts: [], risks: [], modernization_notes: '' };
  it('accepts a valid answer', () => assert.equal(validateComponent({ ...base, business_rules: [rule] }, 10), undefined));
  it('rejects bad line ranges and dispositions', () => {
    assert.match(validateComponent({ ...base, business_rules: [{ ...rule, end_line: 99 }] }, 10)!, /invalid; the file has 10 lines/);
    assert.match(validateComponent({ ...base, business_rules: [{ ...rule, disposition: 'maybe' }] }, 10)!, /disposition/);
  });
});
