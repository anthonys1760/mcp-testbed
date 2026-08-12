import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { WorkspaceError, WorkspaceManager, safeJoin } from '../src/workspace.js';

const manager = new WorkspaceManager('mcp-testbed-test-');
after(() => manager.destroyAll());

describe('safeJoin', () => {
  it('resolves a normal relative path', () => {
    assert.equal(safeJoin('/tmp/ws', 'src/index.js'), '/tmp/ws/src/index.js');
  });

  it('rejects traversal out of the workspace', () => {
    assert.throws(() => safeJoin('/tmp/ws', '../escape.js'), WorkspaceError);
    assert.throws(() => safeJoin('/tmp/ws', 'a/../../escape.js'), WorkspaceError);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => safeJoin('/tmp/ws', '/etc/passwd'), WorkspaceError);
  });

  it('rejects a sibling directory that shares the root as a string prefix', () => {
    // The bug a naive startsWith check would have: /tmp/ws-evil begins with
    // /tmp/ws but is not inside it.
    assert.throws(() => safeJoin('/tmp/ws', '../ws-evil/x.js'), WorkspaceError);
  });

  it('rejects null bytes', () => {
    assert.throws(() => safeJoin('/tmp/ws', 'a\0b.js'), WorkspaceError);
  });

  it('rejects files that would change how a run behaves', () => {
    assert.throws(() => safeJoin('/tmp/ws', '.npmrc'), WorkspaceError);
  });
});

describe('WorkspaceManager', () => {
  it('creates a workspace seeded with files', async () => {
    const { id } = await manager.create({ 'src/a.js': 'export const a = 1;\n' });
    assert.deepEqual(await manager.listFiles(id), ['src/a.js']);
    assert.equal(await manager.readFile(id, 'src/a.js'), 'export const a = 1;\n');
  });

  it('isolates workspaces from each other', async () => {
    const first = await manager.create({ 'only-here.txt': '1' });
    const second = await manager.create({});
    assert.deepEqual(await manager.listFiles(second.id), []);
    assert.notEqual(first.root, second.root);
  });

  it('returns a sorted listing so repeated calls match', async () => {
    const { id } = await manager.create({ 'z.js': '', 'a.js': '', 'm/b.js': '' });
    assert.deepEqual(await manager.listFiles(id), ['a.js', 'm/b.js', 'z.js']);
  });

  it('writes all files or none', async () => {
    const { id } = await manager.create({});
    await assert.rejects(
      () => manager.writeFiles(id, { 'good.js': 'ok', '../bad.js': 'nope' }),
      WorkspaceError,
    );
    // The valid entry must not have landed on disk.
    assert.equal(await manager.exists(id, 'good.js'), false);
  });

  it('does not leave a workspace behind when seeding fails', async () => {
    const before = manager.list().length;
    await assert.rejects(() => manager.create({ '../escape.js': 'x' }), WorkspaceError);
    assert.equal(manager.list().length, before);
  });

  it('throws a clear error for an unknown id', () => {
    assert.throws(() => manager.get('does-not-exist'), WorkspaceError);
  });

  it('destroys a workspace and is safe to call twice', async () => {
    const { id } = await manager.create({ 'a.js': '' });
    await manager.destroy(id);
    await manager.destroy(id);
    assert.throws(() => manager.get(id), WorkspaceError);
  });
});
