/**
 * End to end over the real MCP protocol.
 *
 * These drive the server through a linked in-memory transport rather than
 * calling the handlers directly, so schema validation, serialization and the
 * tool registration surface are all exercised the way a real host exercises
 * them. A unit test that calls the handler function would pass even if the
 * tool were never registered.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { SERVER_NAME, createServer } from '../src/server.js';
import type { WorkspaceManager } from '../src/workspace.js';

let client: Client;
let manager: WorkspaceManager;

/** Calls a tool and returns its structured output, failing loudly on error. */
async function call<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: T;
    content?: Array<{ type: string; text?: string }>;
  };
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? 'tool reported an error');
  }
  return result.structuredContent as T;
}

before(async () => {
  const created = createServer();
  manager = created.manager;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    created.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

after(async () => {
  await manager.destroyAll();
  await client.close();
});

describe('tool registration', () => {
  it('advertises every tool with a description', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'create_workspace',
      'destroy_workspace',
      'read_workspace',
      'run_tests',
      'write_files',
    ]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a description`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    }
  });

  it('identifies itself', () => {
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  });
});

describe('the grading loop', () => {
  it('runs a passing suite and reports a structured verdict', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {
      files: {
        'add.js': 'export const add = (a, b) => a + b;\n',
        'add.test.js': [
          "import assert from 'node:assert/strict';",
          "import { test } from 'node:test';",
          "import { add } from './add.js';",
          "test('adds', () => assert.equal(add(2, 2), 4));",
        ].join('\n'),
        'package.json': JSON.stringify({ name: 'candidate', type: 'module' }),
      },
    });

    const result = await call<{
      passed: boolean;
      reporter: string;
      passedCount: number;
      failedCount: number;
      stdout: string;
    }>('run_tests', { workspaceId, command: 'node', args: ['--test'] });

    assert.equal(result.passed, true);
    assert.equal(result.reporter, 'node-test');
    assert.equal(result.passedCount, 1);
    assert.equal(result.failedCount, 0);
  });

  it('reports the failing test by name when the candidate is wrong', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {
      files: {
        'add.js': 'export const add = (a, b) => a * b;\n', // wrong on purpose
        'add.test.js': [
          "import assert from 'node:assert/strict';",
          "import { test } from 'node:test';",
          "import { add } from './add.js';",
          "test('adds two numbers', () => assert.equal(add(2, 3), 5));",
        ].join('\n'),
        'package.json': JSON.stringify({ name: 'candidate', type: 'module' }),
      },
    });

    const result = await call<{
      passed: boolean;
      failedCount: number;
      failures: Array<{ name: string }>;
    }>('run_tests', { workspaceId, command: 'node', args: ['--test'] });

    assert.equal(result.passed, false);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(
      result.failures.map((f) => f.name),
      ['adds two numbers'],
    );
  });

  it('produces byte identical output for the same code in two workspaces', async () => {
    // This is the property the whole server exists to provide. Two workspaces
    // have different absolute paths and different run durations, so without
    // normalization these would never match.
    const files = {
      'a.test.js': [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "test('fails', () => assert.equal(1, 2));",
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'candidate', type: 'module' }),
    };

    const first = await call<{ workspaceId: string }>('create_workspace', { files });
    const second = await call<{ workspaceId: string }>('create_workspace', { files });

    const runOne = await call<{ stdout: string }>('run_tests', {
      workspaceId: first.workspaceId,
      command: 'node',
      args: ['--test'],
    });
    const runTwo = await call<{ stdout: string }>('run_tests', {
      workspaceId: second.workspaceId,
      command: 'node',
      args: ['--test'],
    });

    assert.equal(runOne.stdout, runTwo.stdout);
    assert.ok(runOne.stdout.length > 0);
  });

  it('does not report a pass when the suite was killed on timeout', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {
      files: { 'hang.js': 'setInterval(() => {}, 1000);\n' },
    });

    const result = await call<{ passed: boolean; timedOut: boolean }>('run_tests', {
      workspaceId,
      command: 'node',
      args: ['hang.js'],
      timeoutMs: 700,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.passed, false);
  });
});

describe('error handling', () => {
  it('returns a tool error, not a crash, for an unknown workspace', async () => {
    await assert.rejects(
      () => call('read_workspace', { workspaceId: 'nope' }),
      /Unknown workspace/,
    );
  });

  it('refuses a path that escapes the workspace', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {});
    await assert.rejects(
      () => call('write_files', { workspaceId, files: { '../escape.js': 'x' } }),
      /escapes the workspace/,
    );
  });

  it('rejects arguments that do not match the schema', async () => {
    await assert.rejects(() => call('create_workspace', { files: { 'a.js': 42 } }));
  });
});

describe('workspace inspection', () => {
  it('lists and reads back what was written', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {
      files: { 'src/index.js': 'export default 1;\n' },
    });

    await call('write_files', { workspaceId, files: { 'README.md': '# candidate\n' } });

    const listing = await call<{ files: string[] }>('read_workspace', { workspaceId });
    assert.deepEqual(listing.files, ['README.md', 'src/index.js']);

    const file = await call<{ contents: string }>('read_workspace', {
      workspaceId,
      path: 'src/index.js',
    });
    assert.equal(file.contents, 'export default 1;\n');
  });

  it('destroys a workspace', async () => {
    const { workspaceId } = await call<{ workspaceId: string }>('create_workspace', {});
    await call('destroy_workspace', { workspaceId });
    await assert.rejects(() => call('read_workspace', { workspaceId }), /Unknown workspace/);
  });
});
