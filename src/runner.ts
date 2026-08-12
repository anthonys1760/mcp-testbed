/**
 * Bounded command execution.
 *
 * Three properties matter for grading an agent's work, and none of them come
 * for free from `child_process.spawn`:
 *
 *   1. It must terminate. A test suite that hangs would otherwise hold the
 *      tool call open indefinitely.
 *   2. It must not return unbounded output. A runaway `console.log` in a loop
 *      can produce gigabytes.
 *   3. It must run under a fixed environment, or the same code produces
 *      different output on different machines.
 */

import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  command: string;
  args?: string[];
  /** Wall clock limit. The process group is killed when it elapses. */
  timeoutMs?: number;
  /** Per-stream cap. Output past this is dropped and flagged as truncated. */
  maxOutputBytes?: number;
  /** Merged over the deterministic base environment. */
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * A deliberately small environment.
 *
 * The parent environment is not inherited. Inheriting it is the single most
 * common reason a suite passes locally and fails in CI: a stray `NODE_ENV`,
 * `NODE_OPTIONS` or locale setting leaks in and changes behaviour. `TZ` and
 * `LC_ALL` are pinned because date and sort order both surface in test output.
 */
export function baseEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    TZ: 'UTC',
    LC_ALL: 'C',
    LANG: 'C',
    CI: '1',
    // Suppress the update banners and telemetry prompts that package managers
    // print on first run, which would otherwise appear in the first run's
    // output but not in later ones.
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
  };
}

/** Collects a stream up to `limit` bytes, reporting whether it overflowed. */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${text}\n[output truncated at ${this.limit} bytes]` : text;
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const {
    cwd,
    command,
    args = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env = {},
  } = options;

  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...baseEnv(cwd), ...env },
      // `detached` puts the child in its own process group so that on timeout
      // we can signal the whole group. Killing only the direct child leaves
      // orphaned grandchildren (a test runner's workers) running.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = new BoundedBuffer(maxOutputBytes);
    const stderr = new BoundedBuffer(maxOutputBytes);
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the process group created by `detached`.
        process.kill(-child.pid, signal);
      } catch {
        // Already gone. Nothing to clean up.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Escalate for anything that ignores SIGTERM, so the promise cannot
      // hang past the timeout the caller asked for.
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      stderr.push(Buffer.from(`Failed to start ${command}: ${error.message}`));
      settle(null, null);
    });

    child.on('close', settle);
  });
}
