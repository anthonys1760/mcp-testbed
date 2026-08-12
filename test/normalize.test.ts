import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalize, normalizePaths, stripAnsi } from '../src/normalize.js';

describe('stripAnsi', () => {
  it('removes colour codes without touching the text', () => {
    assert.equal(stripAnsi('[32mok[39m 1 - adds'), 'ok 1 - adds');
  });

  it('leaves text without escapes unchanged', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });
});

describe('normalizePaths', () => {
  it('replaces the workspace root', () => {
    const out = normalizePaths('at /tmp/ws-abc/src/index.js:4', '/tmp/ws-abc');
    assert.equal(out, 'at <workspace>/src/index.js:4');
  });

  it('replaces the macOS /private-prefixed form of the same root', () => {
    const out = normalizePaths('at /var/folders/x/ws/src/a.js', '/private/var/folders/x/ws');
    assert.equal(out, 'at <workspace>/src/a.js');
  });

  it('masks temp paths outside the workspace', () => {
    assert.equal(normalizePaths('cache at /tmp/other/thing'), 'cache at <tmp>');
  });
});

describe('normalize', () => {
  it('produces identical text for two runs that differ only in noise', () => {
    const first = normalize(
      '[31mFAIL[39m /tmp/ws-1/a.test.js (1.23ms) at 2026-08-11T10:00:00Z',
      { workspaceRoot: '/tmp/ws-1' },
    );
    const second = normalize(
      '[31mFAIL[39m /tmp/ws-2/a.test.js (9.87ms) at 2026-08-12T18:30:11Z',
      { workspaceRoot: '/tmp/ws-2' },
    );
    assert.equal(first, second);
    assert.equal(first, 'FAIL <workspace>/a.test.js (<duration>) at <timestamp>');
  });

  it('normalizes a duration reported as a labelled field with no unit', () => {
    // Regression: TAP YAML writes `duration_ms: 1.905541`, where the number
    // carries no unit. The first version of DURATION missed this entirely and
    // node --test output was never reproducible.
    assert.equal(normalize('  duration_ms: 1.905541'), 'duration_ms: <duration>');
    assert.equal(normalize('# duration_ms 77.669667'), '# duration_ms <duration>');
  });

  it('keeps durations when asked, for profiling', () => {
    assert.match(normalize('took 42ms', { durations: false }), /42ms/);
  });

  it('strips trailing whitespace and normalizes line endings', () => {
    assert.equal(normalize('a   \r\nb\t\r\n'), 'a\nb');
  });

  it('does not collapse a real difference between two runs', () => {
    const pass = normalize('# pass 2\n# fail 0');
    const fail = normalize('# pass 1\n# fail 1');
    assert.notEqual(pass, fail);
  });
});
