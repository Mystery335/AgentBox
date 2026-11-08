import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SectionFile, unfence } from '../src/translator/agent.ts';
import { targetProfile } from '../src/translator/targets.ts';

describe('targetProfile', () => {
  it('maps the Analyzer target language to a profile', () => {
    assert.equal(targetProfile('Python 3.12').id, 'python');
    assert.equal(targetProfile('Java 21').id, 'java');
    assert.equal(targetProfile('C (C17)').id, 'c');
    assert.equal(targetProfile('JavaScript').id, 'javascript');
    assert.equal(targetProfile('Rust').id, 'python'); // no profile: falls back to Python so the code can still run
    assert.equal(targetProfile('Python 3.12').fileName('INTEREST'), 'interest.py');
    assert.equal(targetProfile('Java 21').fileName('ACCT-UPDATE'), 'AcctUpdate.java');
  });
});

describe('SectionFile', () => {
  it('keeps sections in first-written order and replaces in place', () => {
    const f = new SectionFile();
    f.write('imports', 'import sys');
    f.write('main', 'def main():\n    return 0');
    f.write('imports', '```python\nimport os\nimport sys\n```');
    assert.equal(f.source, 'import os\nimport sys\n\n\ndef main():\n    return 0\n');
    assert.match(f.view(), /section "imports" \(file lines 1-2\)/);
    assert.match(f.view(), /section "main" \(file lines 5-6\)/);
    f.remove('imports');
    assert.equal(f.source, 'def main():\n    return 0\n');
  });
  it('labels checker errors with their section', () => {
    const f = new SectionFile();
    f.write('imports', 'import os');
    f.write('br_01_fee', 'def br_01_fee():\n    return undefined_name');
    assert.equal(
      f.annotate('interest.py:5:12: F821 Undefined name'),
      'interest.py:5:12: [section "br_01_fee", line 2] F821 Undefined name'
    );
  });
  it('unfences code', () => {
    assert.equal(unfence('```py\nx = 1\n```'), 'x = 1');
    assert.equal(unfence('x = 1\n\n'), 'x = 1');
  });
});

describe('completeness checks', async () => {
  const { definesFunction, missingLayouts } = await import('../src/translator/agent.ts');
  it('finds defined functions, not calls', () => {
    const py = 'def br_01_fee(x):\n    return x\n\nbr_02_rate(1)\n';
    assert.equal(definesFunction(py, 'br_01_fee'), true);
    assert.equal(definesFunction(py, 'br_02_rate'), false);
    assert.equal(definesFunction('static int br_03(int a) {\n return a; }', 'br_03'), true);
    assert.equal(definesFunction('x = br_03(a);', 'br_03'), false);
    assert.equal(definesFunction(py, 'interest.br_01_fee'), true);
  });
  it('reports includes the shared module dropped', () => {
    const src = 'class AcctRec:\n    pass\n# TRANSREC layout\nclass TransRec: ...';
    assert.deepEqual(missingLayouts(src, ['copybooks/ACCTREC.cpy', 'copybooks/TRANSREC.cpy', 'copybooks/COMCODE.cpy']), ['COMCODE']);
  });
});

describe('retryDelay', async () => {
  const { retryDelay } = await import('../src/llm.ts');
  it('waits long on rate limits, short on other errors', () => {
    assert.equal(retryDelay('Nemotron returned HTTP 429: Too Many Requests', 0), 20_000);
    assert.equal(retryDelay('HTTP 429', 2), 80_000);
    assert.equal(retryDelay('HTTP 429', 9), 160_000);
    assert.equal(retryDelay('HTTP 503', 1), 4000);
  });
});

describe('relevantShared', async () => {
  const { relevantShared } = await import('../src/translator/agent.ts');
  it('shows base + only the layouts the program includes', () => {
    const shared = { source: 'ALL', sections: { base: 'def clock(): ...', ACCTREC: 'class AcctRec: ...', TAXREC: 'class TaxRec: ...' } };
    const out = relevantShared(shared, { includes: [{ name: 'ACCTREC', file: 'copybooks/ACCTREC.cpy' }] });
    assert.match(out, /section base/);
    assert.match(out, /class AcctRec/);
    assert.doesNotMatch(out, /class TaxRec/);
    assert.match(out, /not used by this program: TAXREC/);
    assert.equal(relevantShared({ source: 'ALL' }, { includes: [] }), 'ALL');
  });
});

describe('rule -> modern line ranges', async () => {
  const { functionRange, ruleRanges, examplesBlock } = await import('../src/translator/agent.ts');
  it('finds Python function ranges', () => {
    const py = 'import sys\n\n\ndef br_01_fee(x):\n    """BR-01"""\n    return x\n\n\ndef main():\n    return 0\n';
    assert.deepEqual(functionRange(py, 'br_01_fee'), { start: 4, end: 6 });
    assert.deepEqual(ruleRanges(py, [{ rule_id: 'r:BR-01', function: 'br_01_fee' }, { rule_id: 'r:BR-02', function: 'missing' }]), [{ rule_id: 'r:BR-01', start_line: 4, end_line: 6 }]);
  });
  it('finds brace-language function ranges', () => {
    const java = 'class A {\n  static int br03(int a) {\n    if (a > 0) { return a; }\n    return 0;\n  }\n}\n';
    assert.deepEqual(functionRange(java, 'br03'), { start: 2, end: 5 });
  });
  it('shows legacy examples with visible spaces', () => {
    const b = examplesBlock([{ input: 'A 1\nEND\n', expected: 'TOTAL    5\n[exit 4]' }]);
    assert.ok(b.includes('stdin: "A 1\\nEND\\n"'), b);
    assert.match(b, /"TOTAL    5"/);
    assert.equal(examplesBlock([]), '');
  });
});
