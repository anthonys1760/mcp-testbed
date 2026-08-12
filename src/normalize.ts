/**
 * Output normalization.
 *
 * Test output is full of things that change between otherwise identical runs:
 * absolute paths, wall clock durations, timestamps, PIDs, ANSI colour codes.
 * If an agent is graded on whether its output matches a reference, those
 * details are noise that makes a correct run look like a failure.
 *
 * Every normalizer here is deliberately narrow. Over-aggressive scrubbing is
 * worse than none, because it can erase the difference between a passing run
 * and a failing one.
 */

/** Matches ANSI SGR and cursor sequences emitted by test reporters. */
const ANSI = /\[[0-?]*[ -/]*[@-~]/g;

/** `1.23ms`, `45 ms`, `2.5s` and similar duration literals with a unit suffix. */
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|s|seconds?)\b/gi;

/**
 * Duration reported as a labelled field with no unit on the number itself:
 * `duration_ms: 1.905541` in TAP YAML, `# duration_ms 77.66` in a summary.
 *
 * This needs its own pattern because DURATION requires the unit adjacent to
 * the digits. Without it, a `node --test` run is never byte identical across
 * two workspaces, which was exactly what the end to end determinism test
 * caught.
 */
const DURATION_FIELD = /\b(duration(?:_ms|_s)?)(\s*[:=]\s*|\s+)\d+(?:\.\d+)?\b/gi;

/** ISO 8601 timestamps, with or without fractional seconds and zone. */
const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** Temp directory names that leak the OS temp root even outside the workspace. */
const TMP_PATH = /\/(?:tmp|var\/folders)\/[^\s'":)\]]+/g;

export interface NormalizeOptions {
  /** Absolute workspace root, replaced with `<workspace>` when present. */
  workspaceRoot?: string;
  /** Defaults to true. Set false to keep real durations for profiling. */
  durations?: boolean;
  /** Defaults to true. */
  timestamps?: boolean;
}

/** Strips ANSI escape sequences. Safe to run on any text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Replaces the workspace root with a stable placeholder.
 *
 * Handles the real path as well as the symlink-resolved form, because macOS
 * reports `/var/folders/...` for a workspace created under `/private/var/...`
 * and a run that only replaced one of them would still be non-deterministic.
 */
export function normalizePaths(text: string, workspaceRoot?: string): string {
  let out = text;
  if (workspaceRoot) {
    for (const root of new Set([workspaceRoot, workspaceRoot.replace(/^\/private/, '')])) {
      if (root) out = out.split(root).join('<workspace>');
    }
  }
  return out.replace(TMP_PATH, '<tmp>');
}

/**
 * Applies every enabled normalizer, in an order chosen so that later passes
 * cannot re-introduce noise that earlier ones removed.
 *
 * ANSI first, because escape codes can sit in the middle of a duration literal
 * and would otherwise stop the duration pattern from matching.
 */
export function normalize(text: string, options: NormalizeOptions = {}): string {
  const { workspaceRoot, durations = true, timestamps = true } = options;

  let out = stripAnsi(text);
  out = normalizePaths(out, workspaceRoot);
  if (timestamps) out = out.replace(ISO_TIMESTAMP, '<timestamp>');
  if (durations) {
    // Labelled fields first. DURATION would otherwise consume the trailing
    // `_ms` of `duration_ms` as a unit and leave the number behind.
    out = out.replace(DURATION_FIELD, '$1$2<duration>');
    out = out.replace(DURATION, '<duration>');
  }

  // Normalize line endings and trailing whitespace so a diff does not trip on
  // a reporter that pads lines to terminal width.
  return out
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}
