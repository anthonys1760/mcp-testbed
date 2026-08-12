/**
 * MCP surface.
 *
 * Five tools that together let an agent do one thing: put a candidate solution
 * somewhere isolated, run the tests that grade it, and read back a verdict
 * that is stable across runs.
 *
 * Tool descriptions are written for the model that will call them, not for a
 * human skimming the file. A model decides whether to call a tool almost
 * entirely from its description, so each one states what the tool does, what
 * it returns, and when not to reach for it.
 */

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { normalize } from './normalize.js';
import { parseTestOutput } from './parsers.js';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, run } from './runner.js';
import { WorkspaceError, WorkspaceManager } from './workspace.js';

export const SERVER_NAME = 'mcp-testbed';
export const SERVER_VERSION = '0.1.0';

const filesSchema = z
  .record(z.string(), z.string())
  .describe('Map of workspace-relative path to file contents, e.g. {"src/index.js": "..."}');

/** Wraps a handler so a thrown WorkspaceError becomes a tool error, not a crash. */
async function guarded<T extends object>(
  fn: () => Promise<T>,
): Promise<{ content: [{ type: 'text'; text: string }]; structuredContent?: T; isError?: true }> {
  try {
    const result = await fn();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof WorkspaceError ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

export function createServer(manager: WorkspaceManager = new WorkspaceManager()): {
  server: McpServer;
  manager: WorkspaceManager;
} {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'create_workspace',
    {
      title: 'Create workspace',
      description:
        'Creates an isolated temporary directory and returns its id. Optionally seeds it with files. ' +
        'Every other tool addresses a workspace by this id; paths are always relative to it. ' +
        'Call destroy_workspace when finished.',
      inputSchema: z.object({ files: filesSchema.optional() }),
      outputSchema: z.object({
        workspaceId: z.string(),
        filesWritten: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ files }) =>
      guarded(async () => {
        const info = await manager.create(files ?? {});
        return {
          workspaceId: info.id,
          filesWritten: Object.keys(files ?? {}).sort(),
        };
      }),
  );

  server.registerTool(
    'write_files',
    {
      title: 'Write files',
      description:
        'Writes or overwrites files in an existing workspace, creating parent directories as needed. ' +
        'Paths must be relative and stay inside the workspace. Either every file is written or none is.',
      inputSchema: z.object({ workspaceId: z.string(), files: filesSchema }),
      outputSchema: z.object({ filesWritten: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ workspaceId, files }) =>
      guarded(async () => ({ filesWritten: await manager.writeFiles(workspaceId, files) })),
  );

  server.registerTool(
    'run_tests',
    {
      title: 'Run tests',
      description:
        'Runs a command in a workspace under a fixed environment and a wall clock timeout, then parses the ' +
        'output into a pass/fail summary with failing test names. Output is normalized (paths, durations, ' +
        'timestamps and colour codes removed) so two identical runs produce identical text. ' +
        'Returns the verdict plus both normalized and raw output.',
      inputSchema: z.object({
        workspaceId: z.string(),
        command: z.string().default('npm').describe('Executable to run. Not passed through a shell.'),
        args: z.array(z.string()).default(['test']),
        timeoutMs: z.number().int().positive().max(600_000).default(DEFAULT_TIMEOUT_MS),
        maxOutputBytes: z.number().int().positive().default(DEFAULT_MAX_OUTPUT_BYTES),
        env: z.record(z.string(), z.string()).optional(),
      }),
      outputSchema: z.object({
        passed: z.boolean(),
        reporter: z.string(),
        total: z.number().nullable(),
        passedCount: z.number().nullable(),
        failedCount: z.number().nullable(),
        failures: z.array(z.object({ name: z.string(), message: z.string().optional() })),
        exitCode: z.number().nullable(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
        durationMs: z.number(),
        stdout: z.string(),
        stderr: z.string(),
        rawStdout: z.string(),
        rawStderr: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workspaceId, command, args, timeoutMs, maxOutputBytes, env }) =>
      guarded(async () => {
        const { root } = manager.get(workspaceId);
        const result = await run({ cwd: root, command, args, timeoutMs, maxOutputBytes, env });
        const summary = parseTestOutput(result.stdout, result.stderr, result.exitCode);
        const options = { workspaceRoot: root };

        return {
          ...summary,
          // A run that was killed on timeout never reported a verdict, so it
          // cannot be a pass regardless of what the partial output said.
          passed: summary.passed && !result.timedOut,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
          stdout: normalize(result.stdout, options),
          stderr: normalize(result.stderr, options),
          rawStdout: result.stdout,
          rawStderr: result.stderr,
        };
      }),
  );

  server.registerTool(
    'read_workspace',
    {
      title: 'Read workspace',
      description:
        'Lists the files in a workspace, or returns the contents of one file when path is given. ' +
        'node_modules and .git are excluded from listings. Listings are sorted, so repeated calls match.',
      inputSchema: z.object({
        workspaceId: z.string(),
        path: z.string().optional().describe('Workspace-relative file path. Omit to list all files.'),
      }),
      outputSchema: z.object({
        files: z.array(z.string()).optional(),
        path: z.string().optional(),
        contents: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ workspaceId, path: relativePath }) =>
      guarded(async () => {
        if (relativePath === undefined) {
          return { files: await manager.listFiles(workspaceId) };
        }
        return { path: relativePath, contents: await manager.readFile(workspaceId, relativePath) };
      }),
  );

  server.registerTool(
    'destroy_workspace',
    {
      title: 'Destroy workspace',
      description:
        'Deletes a workspace and everything in it. Safe to call on an id that no longer exists.',
      inputSchema: z.object({ workspaceId: z.string() }),
      outputSchema: z.object({ destroyed: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ workspaceId }) =>
      guarded(async () => {
        await manager.destroy(workspaceId);
        return { destroyed: workspaceId };
      }),
  );

  return { server, manager };
}
