#!/usr/bin/env node
/**
 * Entry point. Speaks MCP over stdio, which is what a local agent host expects.
 *
 * Nothing may be written to stdout other than protocol frames: stdout is the
 * transport. Diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';

async function main(): Promise<void> {
  const { server, manager } = createServer();

  // Workspaces live in the OS temp directory. Without this, an interrupted
  // session leaves them behind.
  const shutdown = async (): Promise<void> => {
    await manager.destroyAll();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
  process.stderr.write('mcp-testbed listening on stdio\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`mcp-testbed failed to start: ${String(error)}\n`);
  process.exit(1);
});
