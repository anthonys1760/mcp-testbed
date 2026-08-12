/**
 * Workspace lifecycle and path containment.
 *
 * A workspace is a throwaway directory that holds one candidate solution and
 * the tests that grade it. Workspaces are addressed by opaque id rather than
 * by path, so a caller never sees or supplies an absolute path and cannot
 * point the server at somewhere it should not be writing.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class WorkspaceError extends Error {}

/** Files an agent may not create, because they change how a run behaves. */
const DENIED_BASENAMES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.git']);

export interface WorkspaceInfo {
  id: string;
  root: string;
  createdAt: number;
}

/**
 * Resolves `relativePath` inside `root` and refuses anything that escapes.
 *
 * Checking the resolved path with a separator-terminated prefix is what makes
 * this safe: a plain `startsWith(root)` would accept `/tmp/ws-1-evil` for a
 * root of `/tmp/ws-1`.
 */
export function safeJoin(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new WorkspaceError(`Absolute paths are not allowed: ${relativePath}`);
  }
  if (relativePath.includes('\0')) {
    throw new WorkspaceError('Path contains a null byte');
  }

  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);

  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new WorkspaceError(`Path escapes the workspace: ${relativePath}`);
  }

  const basename = path.basename(resolved);
  if (DENIED_BASENAMES.has(basename)) {
    throw new WorkspaceError(`Writing ${basename} is not allowed`);
  }

  return resolved;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceInfo>();

  constructor(private readonly prefix = 'mcp-testbed-') {}

  async create(files: Record<string, string> = {}): Promise<WorkspaceInfo> {
    const root = await mkdtemp(path.join(tmpdir(), this.prefix));
    const info: WorkspaceInfo = { id: randomUUID(), root, createdAt: Date.now() };
    this.workspaces.set(info.id, info);

    try {
      await this.writeFiles(info.id, files);
    } catch (error) {
      // Never leave a half-populated workspace behind for the caller to
      // discover on a later tool call.
      await this.destroy(info.id);
      throw error;
    }

    return info;
  }

  get(id: string): WorkspaceInfo {
    const info = this.workspaces.get(id);
    if (!info) throw new WorkspaceError(`Unknown workspace: ${id}`);
    return info;
  }

  async writeFiles(id: string, files: Record<string, string>): Promise<string[]> {
    const { root } = this.get(id);

    // Validate every path before writing any of them, so a bad entry halfway
    // through the map cannot leave a partial write on disk.
    const targets = Object.entries(files).map(
      ([relativePath, contents]) => [safeJoin(root, relativePath), contents, relativePath] as const,
    );

    for (const [absolute, contents] of targets) {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, 'utf8');
    }

    return targets.map(([, , relativePath]) => relativePath).sort();
  }

  async readFile(id: string, relativePath: string): Promise<string> {
    const { root } = this.get(id);
    return readFile(safeJoin(root, relativePath), 'utf8');
  }

  /**
   * Lists files relative to the workspace root, sorted.
   *
   * Sorting matters: readdir order is filesystem dependent, and an unsorted
   * listing would make otherwise identical runs produce different output.
   */
  async listFiles(id: string, options: { includeNodeModules?: boolean } = {}): Promise<string[]> {
    const { root } = this.get(id);
    const found: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!options.includeNodeModules && (entry.name === 'node_modules' || entry.name === '.git')) {
          continue;
        }
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          found.push(path.relative(root, absolute));
        }
      }
    };

    await walk(root);
    return found.sort();
  }

  async exists(id: string, relativePath: string): Promise<boolean> {
    const { root } = this.get(id);
    try {
      await stat(safeJoin(root, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async destroy(id: string): Promise<void> {
    const info = this.workspaces.get(id);
    if (!info) return;
    this.workspaces.delete(id);
    await rm(info.root, { recursive: true, force: true });
  }

  /** Used on shutdown so a crashed session does not litter the temp directory. */
  async destroyAll(): Promise<void> {
    await Promise.all([...this.workspaces.keys()].map((id) => this.destroy(id)));
  }

  list(): WorkspaceInfo[] {
    return [...this.workspaces.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
