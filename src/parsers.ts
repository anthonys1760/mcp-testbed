/**
 * Test output parsing.
 *
 * The goal is a verdict a program can act on, not a wall of text a model has
 * to re-read. Each parser recognises one reporter format and returns null when
 * the output is not its format, so `parseTestOutput` can try them in order.
 *
 * The fallback is deliberate and important: when no parser matches, the result
 * reports counts as unknown and falls back to the exit code rather than
 * guessing. A wrong count is worse than an absent one, because a grader would
 * treat it as ground truth.
 */

import { stripAnsi } from './normalize.js';

export interface TestFailure {
  name: string;
  message?: string;
}

export interface TestSummary {
  /** Which parser produced this, or `exit-code` for the fallback. */
  reporter: 'node-test' | 'tap' | 'jest' | 'mocha' | 'exit-code';
  passed: boolean;
  total: number | null;
  passedCount: number | null;
  failedCount: number | null;
  failures: TestFailure[];
}

type Parser = (text: string) => Omit<TestSummary, 'passed'> | null;

/**
 * `node --test` summary block, in either of its two shapes. Piped output was
 * TAP (`# tests 4`) up to Node 22; Node 23 made spec the default reporter even
 * without a TTY, which prints `ℹ tests 4` instead. Same numbers, different
 * sigil, so one parser handles both.
 */
const parseNodeTest: Parser = (text) => {
  const count = (label: string): number | null => {
    const match = new RegExp(`^[#ℹ] ${label} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };

  const tests = count('tests');
  const pass = count('pass');
  const fail = count('fail');
  if (tests === null || pass === null || fail === null) return null;

  const tapFailures = collectTapFailures(text);
  return {
    reporter: 'node-test',
    total: tests,
    passedCount: pass,
    failedCount: fail,
    failures: tapFailures.length > 0 ? tapFailures : collectSpecFailures(text),
  };
};

/** Bare TAP: a `1..N` plan plus `ok` / `not ok` lines. */
const parseTap: Parser = (text) => {
  const plan = /^1\.\.(\d+)$/m.exec(text);
  const okLines = text.match(/^ {0,4}ok \d+/gm) ?? [];
  const notOkLines = text.match(/^ {0,4}not ok \d+/gm) ?? [];
  if (!plan && okLines.length === 0 && notOkLines.length === 0) return null;

  const total = plan ? Number(plan[1]) : okLines.length + notOkLines.length;
  return {
    reporter: 'tap',
    total,
    passedCount: okLines.length,
    failedCount: notOkLines.length,
    failures: collectTapFailures(text),
  };
};

/** Jest and Vitest: `Tests:  1 failed, 2 passed, 3 total`. */
const parseJest: Parser = (text) => {
  const line = /^\s*Tests:\s+(.+)$/m.exec(text);
  if (!line) return null;

  const summary = line[1];
  const read = (label: string): number | null => {
    const match = new RegExp(`(\\d+)\\s+${label}`).exec(summary);
    return match ? Number(match[1]) : null;
  };

  const failedCount = read('failed') ?? 0;
  const passedCount = read('passed') ?? 0;
  const total = read('total') ?? passedCount + failedCount;

  return {
    reporter: 'jest',
    total,
    passedCount,
    failedCount,
    failures: [...text.matchAll(/^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm)].map((m) => ({
      name: m[1].trim(),
    })),
  };
};

/** Mocha spec reporter: `3 passing`, `1 failing`. */
const parseMocha: Parser = (text) => {
  const passing = /^\s*(\d+) passing/m.exec(text);
  const failing = /^\s*(\d+) failing/m.exec(text);
  if (!passing && !failing) return null;

  const passedCount = passing ? Number(passing[1]) : 0;
  const failedCount = failing ? Number(failing[1]) : 0;

  return {
    reporter: 'mocha',
    total: passedCount + failedCount,
    passedCount,
    failedCount,
    failures: [...text.matchAll(/^\s*\d+\)\s+(.+)$/gm)].map((m) => ({ name: m[1].trim() })),
  };
};

/**
 * Pulls failure names out of TAP `not ok` lines.
 *
 * Kept separate from the parsers because `node --test` emits TAP-shaped
 * failures underneath its own summary block, so both parsers want it.
 */
function collectTapFailures(text: string): TestFailure[] {
  return [...text.matchAll(/^ {0,4}not ok \d+ - (.+?)(?:\s+#.*)?$/gm)].map((match) => ({
    name: match[1].trim(),
  }));
}

/**
 * Pulls failure names out of the spec reporter's `✖ failing tests:` section.
 *
 * Only that trailing section is scanned, on purpose. In the main run flow a
 * failing test's `✖` line appears once inline and once in this section, and a
 * failing describe block gets a `✖` line of its own. Scanning the whole text
 * would double count tests and misreport suites as tests.
 */
function collectSpecFailures(text: string): TestFailure[] {
  const marker = text.indexOf('✖ failing tests:');
  if (marker === -1) return [];
  return [...text.slice(marker).matchAll(/^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gmu)].map((match) => ({
    name: match[1].trim(),
  }));
}

const PARSERS: Parser[] = [parseNodeTest, parseJest, parseMocha, parseTap];

/**
 * Parses combined test output into a structured summary.
 *
 * `exitCode` is authoritative for the pass/fail verdict even when a reporter
 * is recognised. A suite can print a clean summary and still exit non-zero
 * because of a teardown crash, and calling that a pass would be wrong.
 */
export function parseTestOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): TestSummary {
  const text = stripAnsi(`${stdout}\n${stderr}`);

  for (const parser of PARSERS) {
    const parsed = parser(text);
    if (parsed) {
      return {
        ...parsed,
        passed: exitCode === 0 && (parsed.failedCount ?? 0) === 0,
      };
    }
  }

  return {
    reporter: 'exit-code',
    passed: exitCode === 0,
    total: null,
    passedCount: null,
    failedCount: null,
    failures: [],
  };
}
