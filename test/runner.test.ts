import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { baseEnv, run } from '../src/runner.js';
import { WorkspaceManager } from '../src/workspace.js';

const manager = new WorkspaceManager('mcp-testbed-runner-');
after(() => manager.destroyAll());

describe('baseEnv', () => {
  it('pins the settings that make output vary between machines', () => {
    const env = baseEnv('/tmp/ws');
    assert.equal(env.TZ, 'UTC');
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.HOME, '/tmp/ws');
  });
});

describe('run', () => {
  it('captures stdout and the exit code', async () => {
    const { root } = await manager.create({});
    const result = await run({ cwd: root, command: 'node', args: ['-e', 'console.log("hi")'] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'hi');
    assert.equal(result.timedOut, false);
  });

  it('reports a nonzero exit code', async () => {
    const { root } = await manager.create({});
    const result = await run({ cwd: root, command: 'node', args: ['-e', 'process.exit(3)'] });
    assert.equal(result.exitCode, 3);
  });

  it('does not inherit the parent environment', async () => {
    process.env.MCP_TESTBED_LEAK_CHECK = 'leaked';
    const { root } = await manager.create({});
    const result = await run({
      cwd: root,
      command: 'node',
      args: ['-e', 'console.log(process.env.MCP_TESTBED_LEAK_CHECK ?? "absent")'],
    });
    delete process.env.MCP_TESTBED_LEAK_CHECK;
    assert.equal(result.stdout.trim(), 'absent');
  });

  it('kills a process that exceeds the timeout', async () => {
    const { root } = await manager.create({});
    const result = await run({
      cwd: root,
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 500,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it('truncates runaway output instead of buffering it all', async () => {
    const { root } = await manager.create({});
    const result = await run({
      cwd: root,
      command: 'node',
      args: ['-e', 'for (let i = 0; i < 100000; i++) console.log("x".repeat(100))'],
      maxOutputBytes: 5_000,
    });
    assert.equal(result.truncated, true);
    assert.match(result.stdout, /output truncated/);
    assert.ok(result.stdout.length < 20_000);
  });

  it('reports a command that does not exist instead of throwing', async () => {
    const { root } = await manager.create({});
    const result = await run({ cwd: root, command: 'definitely-not-a-real-binary-xyz' });
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /Failed to start/);
  });
});
