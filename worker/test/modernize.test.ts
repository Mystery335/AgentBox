import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonical, parseBatch } from '../src/modernize/sandbox.ts';
import { legacyBuildCommand, pickComponent, splitOf } from '../src/modernize/index.ts';
import { pickTarget } from '../src/modernize/targets.ts';
import { stripLineNumbers, type StoredComponent } from '../src/modernize/agents.ts';

describe('parseBatch', () => {
  const n = 'APnonce';
  it('reads stdout, stderr and exit code per case', () => {
    const out =
      `${n} BUILD_OK\n` +
      `${n} CASE 01\nhello\nworld\n\n${n} EXIT 01 0\n\n${n} ENDERR 01\n` +
      `${n} CASE 02\n\n${n} EXIT 02 4\nboom\n${n} ENDERR 02\n` +
      `${n} CASE 03\npartial\n${n} EXIT 03 124\n\n${n} ENDERR 03\n${n} DONE\n`;
    const r = parseBatch(out, n);
    assert.equal(r.built, true);
    assert.deepEqual(r.cases.get('01'), { stdout: 'hello\nworld\n', stderr: '', exitCode: 0, timedOut: false });
    assert.deepEqual(r.cases.get('02'), { stdout: '', stderr: 'boom', exitCode: 4, timedOut: false });
    assert.equal(r.cases.get('03')!.timedOut, true);
    assert.equal(r.cases.get('03')!.stdout, 'partial');
  });
  it('reports a build failure with its log', () => {
    const r = parseBatch(`${n} BUILD_FAIL\nmain.py:3: SyntaxError\n`, n);
    assert.equal(r.built, false);
    assert.match(r.buildLog, /SyntaxError/);
    assert.equal(r.cases.size, 0);
  });
  it('ignores marker lookalikes printed by the program (different nonce)', () => {
    const out = `${n} BUILD_OK\n${n} CASE 01\nAPother EXIT 01 9\nok\n${n} EXIT 01 0\n\n${n} ENDERR 01\n`;
    assert.equal(parseBatch(out, n).cases.get('01')!.stdout, 'APother EXIT 01 9\nok');
  });
});

describe('canonical', () => {
  it('ignores CRLF, trailing spaces and trailing blank lines', () => {
    assert.equal(canonical('A  \r\nB\n\n\n', 0), canonical('A\nB', 0));
  });
  it('keeps leading spaces and inner spacing', () => {
    assert.notEqual(canonical('  12.50', 0), canonical('12.50', 0));
    assert.notEqual(canonical('A  B', 0), canonical('A B', 0));
  });
  it('includes a non-zero exit code', () => {
    assert.equal(canonical('x', 4), 'x\n[exit 4]');
    assert.notEqual(canonical('x', 4), canonical('x', 0));
  });
});

describe('legacyBuildCommand', () => {
  it('turns a cobc syntax check into an executable build', () => {
    assert.equal(
      legacyBuildCommand("cobc -fsyntax-only -I 'copybooks' 'src/PAY.cob'", ['src/SUB.cob']),
      "cobc -x -o /tmp/legacy_prog -I 'copybooks' 'src/PAY.cob' 'src/SUB.cob'"
    );
  });
  it('builds C with gcc and fixes an empty include dir', () => {
    assert.equal(legacyBuildCommand("gcc -fsyntax-only -I '' 'main.c'", []), "gcc -o /tmp/legacy_prog -I . 'main.c'");
  });
  it('assembles and links NASM', () => {
    assert.match(legacyBuildCommand("nasm -f elf64 -o /dev/null 'a.asm'", []), /-o \/tmp\/legacy\.o 'a\.asm' && \(ld -o \/tmp\/legacy_prog/);
  });
  it('rejects commands it does not understand', () => {
    assert.throws(() => legacyBuildCommand('make', []));
  });
});

describe('pickComponent', () => {
  const comp = (name: string, extra: Partial<StoredComponent> = {}): StoredComponent => ({
    name,
    path: `src/${name}.cob`,
    language: 'cobol',
    lines: 100,
    includes: [],
    calls: [],
    file_io: [],
    takes_parameters: false,
    compile: { status: 'ok', command: `cobc -fsyntax-only 'src/${name}.cob'` },
    verifiable: true,
    rule_ids: ['r1'],
    ...extra,
  });
  it('prefers the first slice, then no file I/O', () => {
    const list = [comp('A'), comp('B', { file_io: [{ name: 'F', assign: 'F' }] }), comp('C')];
    assert.equal(pickComponent(list, ['src/C.cob'])!.name, 'C');
    assert.equal(pickComponent(list, ['src/B.cob'])!.name, 'B');
    assert.equal(pickComponent(list, [])!.name, 'A');
  });
  it('never picks unverifiable or non-compiling programs', () => {
    const list = [comp('A', { verifiable: false }), comp('B', { compile: { status: 'failed' } })];
    assert.equal(pickComponent(list, ['src/A.cob']), undefined);
  });
  it('honours --only', () => {
    assert.equal(pickComponent([comp('A'), comp('B')], [], 'b')!.name, 'B');
  });
});

describe('targets and splits', () => {
  it('maps target languages to sandbox profiles', () => {
    assert.equal(pickTarget('Python 3.12').profile.id, 'python');
    assert.equal(pickTarget('Java 21').profile.id, 'java');
    assert.equal(pickTarget('TypeScript').profile.id, 'typescript');
    assert.equal(pickTarget('JavaScript (Node)').profile.id, 'javascript');
    assert.equal(pickTarget('C17').profile.id, 'c');
    assert.equal(pickTarget('Go 1.22').profile.id, 'go');
    assert.deepEqual([pickTarget('Rust').profile.id, pickTarget('Rust').fallback], ['python', true]);
  });
  it('puts every third case in holdout', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(splitOf), ['debug', 'debug', 'holdout', 'debug', 'debug', 'holdout']);
  });
  it('strips echoed line numbers only when every line has one', () => {
    assert.equal(stripLineNumbers('   1| a\n   2| b'), 'a\nb');
    assert.equal(stripLineNumbers('x = 1\n   2| b'), 'x = 1\n   2| b');
  });
});

describe('lineDiff', () => {
  it('shows only differing lines, with the first differing column', async () => {
    const { lineDiff } = await import('../src/modernize/agents.ts');
    const d = lineDiff('A\nEMPLOYEES     0\nC', 'A\nEMPLOYEES    0\nC');
    assert.match(d, /line 2 \(first difference at column 14\)/);
    assert.doesNotMatch(d, /line 1|line 3/);
  });
});
