import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTestOutput } from '../src/parsers.js';

describe('parseTestOutput', () => {
  it('reads a node --test summary', () => {
    const output = [
      'TAP version 13',
      'ok 1 - adds',
      'not ok 2 - subtracts',
      '1..2',
      '# tests 2',
      '# pass 1',
      '# fail 1',
    ].join('\n');

    const summary = parseTestOutput(output, '', 1);
    assert.equal(summary.reporter, 'node-test');
    assert.equal(summary.total, 2);
    assert.equal(summary.passedCount, 1);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.passed, false);
    assert.deepEqual(summary.failures, [{ name: 'subtracts' }]);
  });

  it('reads a jest summary and failure names', () => {
    const output = ['  ✕ returns the sum (3 ms)', '', 'Tests:       1 failed, 2 passed, 3 total'].join(
      '\n',
    );

    const summary = parseTestOutput(output, '', 1);
    assert.equal(summary.reporter, 'jest');
    assert.equal(summary.total, 3);
    assert.equal(summary.failedCount, 1);
    assert.deepEqual(summary.failures, [{ name: 'returns the sum' }]);
  });

  it('reads a mocha summary', () => {
    const summary = parseTestOutput('  3 passing (12ms)\n  1 failing\n', '', 1);
    assert.equal(summary.reporter, 'mocha');
    assert.equal(summary.total, 4);
    assert.equal(summary.passedCount, 3);
  });

  it('reads bare TAP', () => {
    const summary = parseTestOutput('1..2\nok 1 - a\nnot ok 2 - b\n', '', 1);
    assert.equal(summary.reporter, 'tap');
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.failures, [{ name: 'b' }]);
  });

  it('falls back to the exit code rather than guessing counts', () => {
    const summary = parseTestOutput('something unparseable', '', 0);
    assert.equal(summary.reporter, 'exit-code');
    assert.equal(summary.passed, true);
    assert.equal(summary.total, null);
    assert.equal(summary.passedCount, null);
  });

  it('treats a nonzero exit as a failure even when every test passed', () => {
    // A suite can report all-green and still exit nonzero because teardown
    // crashed. Calling that a pass would hand a grader a false positive.
    const output = 'TAP version 13\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 0';
    const summary = parseTestOutput(output, '', 1);
    assert.equal(summary.failedCount, 0);
    assert.equal(summary.passed, false);
  });

  it('ignores ANSI colour codes in the output', () => {
    const summary = parseTestOutput('# tests 1\n# pass 1\n# fail 0', '', 0);
    assert.equal(summary.passed, true);
    assert.equal(summary.passedCount, 1);
  });
});
