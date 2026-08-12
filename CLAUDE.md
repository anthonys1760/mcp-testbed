# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

An MCP server that gives an agent an isolated workspace, runs its tests, and returns a **deterministic** pass/fail verdict. Determinism is the product. Anything that makes two runs of identical code produce different output is a bug, and the end to end test asserts byte identical output across two workspaces.

Read `README.md` for the user facing description. This file covers what you need to change code safely.

## Critical: this uses MCP SDK v2, not v1

This is the single most likely thing to get wrong, because v1 is far more common in training data.

**Correct (what this repo uses):**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

server.registerTool(
  'tool_name',
  {
    title: 'Human readable title',
    description: '...',
    inputSchema: z.object({ field: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ field }) => ({
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  }),
);
```

**Wrong (v1 API, will not work here):**

- `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`
- `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'`
- `server.tool(name, description, schema, handler)`
- Passing a raw Zod shape `{ field: z.string() }` instead of `z.object({ ... })`. The raw shape form still exists but is deprecated.

The client package is `@modelcontextprotocol/client` v2, used only in tests.

If you need to check an API, read the types in `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`. The barrel file `index.d.mts` is a minified re-export and is not readable.

## Commands

```bash
npm test                          # all tests, via tsx + node:test
npx tsx --test test/normalize.test.ts   # a single file
npm run typecheck                 # tsc --noEmit
npm run build                     # tsc, emits to dist/
npm start                         # runs the built server on stdio
```

Tests run against `src/` through `tsx`, not against `dist/`. You do not need to build before testing.

## Toolchain gotchas

- **TypeScript 7.** `tsconfig.json` needs `"types": ["node"]` explicitly. Without it every `process`, `Buffer` and `node:*` import fails to resolve. Do not remove that line.
- **ESM with NodeNext.** Relative imports must carry a `.js` extension even in `.ts` source: `import { normalize } from './normalize.js'`. This is correct, not a mistake to fix.
- **`npm run prepare` runs the build.** A plain `npm install` will therefore compile. If the build is broken, install fails.

## Invariants, do not break these

Each of these has a test. If you find yourself deleting or loosening one, that is the signal to stop.

1. **stdout is the transport.** Never `console.log` from `src/`. Diagnostics go to `process.stderr`. A stray write to stdout corrupts the protocol stream.

2. **Normalization stays narrow.** Over-aggressive scrubbing can erase the difference between a passing run and a failing one. `test/normalize.test.ts` asserts that a pass and a fail do not normalize to the same string. Raw output is always preserved alongside normalized output.

3. **Exit code is authoritative.** A non-zero exit is a failure even when the parsed summary says every test passed, because teardown can crash after a green report. Do not "fix" this to trust the summary.

4. **A timed out run is never a pass**, regardless of partial output.

5. **The timeout kills the process group,** via `process.kill(-pid, signal)` with `detached: true` on spawn. Killing only the direct child orphans a test runner's workers. Do not simplify to `child.kill()`.

6. **Path containment uses a separator terminated prefix check.** `resolved === base || resolved.startsWith(base + path.sep)`. Do not simplify to `startsWith(base)`: that accepts `/tmp/ws-evil` for a root of `/tmp/ws`, and there is a test named for exactly that case.

7. **Writes are all or nothing.** Every path in a batch is validated before any file is written, so a bad entry cannot leave a partial write behind.

8. **Directory listings are sorted.** `readdir` order is filesystem dependent and unsorted output is non-deterministic.

9. **The child environment is pinned, not inherited.** See `baseEnv()` in `src/runner.ts`. Adding a passthrough of `process.env` would reintroduce the machine dependence this exists to remove.

10. **Unknown reporter means null counts,** not guessed ones. A wrong count is worse than an absent one, because a grader treats it as ground truth.

## Layout

```
src/normalize.ts   output normalization (paths, durations, timestamps, ANSI)
src/workspace.ts   workspace lifecycle, safeJoin path containment
src/runner.ts      bounded process execution, baseEnv
src/parsers.ts     reporter parsing, one parser per format, returns null on no match
src/server.ts      MCP tool surface, the `guarded` error wrapper
src/index.ts       stdio entry point, signal handling, cleanup
```

`src/server.ts` is the only file that knows about MCP. Everything else is plain TypeScript with no protocol awareness, which is what makes the rest unit testable.

## Testing conventions

- `test/server.test.ts` drives the server through `InMemoryTransport.createLinkedPair()` with a real `Client`, not by calling handlers directly. A handler level test would pass even if a tool were never registered. Keep new tool tests at this level.
- Everything else is unit tested against the module directly.
- `node:test` and `node:assert/strict` only. There is no test framework dependency and adding one is not wanted.
- Each `WorkspaceManager` in a test file gets an `after(() => manager.destroyAll())` so runs do not litter the temp directory.

## Deliberately not done

Do not add these without being asked. Their absence is a decision, not an oversight.

- **Shell execution.** `spawn` is called without `shell: true` on purpose. Commands are an executable plus an argument array, which removes shell injection as a concern entirely.
- **Network isolation.** Out of scope. The README's threat model section states plainly that this is workspace isolation, not a security sandbox, and that claim should not be quietly upgraded.
- **Persistence.** Workspaces are in-memory records over temp directories and die with the process. There is no database and none is wanted.
- **HTTP transport.** stdio only. The SDK supports HTTP, but this server has no use for it.
- **More reporters.** Add one only if there is a test with real captured output for it. Do not add a parser speculatively.

## Style

Comments explain **why**, not what. Existing comments document the reasoning behind a non-obvious decision (why the process group, why the prefix check, why the environment is pinned). Match that. Do not add comments that restate the code.

Prose in this repo avoids dashes as punctuation. Use a comma, colon or period.
