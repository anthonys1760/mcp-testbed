# mcp-testbed

An MCP server that gives an agent an isolated workspace, runs its tests, and returns a **deterministic** pass/fail verdict.

The use case is grading. If you are evaluating whether a model can solve a software engineering problem, you need to put its candidate solution somewhere safe, run a suite against it, and get back an answer a program can act on. Doing that naively produces results that are almost right, which is the worst kind: output littered with absolute paths, wall clock durations and colour codes, so two runs of identical code never match, and any comparison against a reference solution fails for reasons that have nothing to do with the code.

This server exists to make that last part go away.

```
create_workspace  ->  write_files  ->  run_tests  ->  read_workspace  ->  destroy_workspace
```

## Quick start

```bash
npm install
npm test          # 50 tests
npm run build
```

Register it with any MCP host. For Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "testbed": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-testbed/dist/index.js"]
    }
  }
}
```

## What a run looks like

```js
const { workspaceId } = (await client.callTool({
  name: 'create_workspace',
  arguments: {
    files: {
      'package.json': JSON.stringify({ name: 'candidate', type: 'module' }),
      'add.js': 'export const add = (a, b) => a * b;',      // wrong on purpose
      'add.test.js': `
        import assert from 'node:assert/strict';
        import { test } from 'node:test';
        import { add } from './add.js';
        test('adds two numbers', () => assert.equal(add(2, 3), 5));
      `,
    },
  },
})).structuredContent;

const result = (await client.callTool({
  name: 'run_tests',
  arguments: { workspaceId, command: 'node', args: ['--test'] },
})).structuredContent;
```

```json
{
  "passed": false,
  "reporter": "node-test",
  "total": 1,
  "passedCount": 0,
  "failedCount": 1,
  "failures": [{ "name": "adds two numbers" }],
  "exitCode": 1,
  "timedOut": false,
  "truncated": false,
  "stdout": "...normalized...",
  "rawStdout": "...untouched..."
}
```

## Determinism

This is the part worth reading. Four sources of run to run variation are removed from `stdout` and `stderr`, while `rawStdout` and `rawStderr` keep the untouched output for a human to debug with.

| Source of noise | Handling |
| --- | --- |
| Absolute paths | Workspace root becomes `<workspace>`; other temp paths become `<tmp>`. Both the real and symlink resolved form are replaced, because macOS reports `/var/folders/...` for a directory created under `/private/var/...`. |
| Durations | `1.23ms` and labelled fields like `duration_ms: 1.905541` both become `<duration>`. The labelled form needs its own pattern, and missing it was a real bug the determinism test caught. |
| Timestamps | ISO 8601 becomes `<timestamp>`. |
| Colour codes | ANSI sequences stripped before anything else, since an escape can sit mid-token and stop other patterns matching. |

The environment is pinned rather than inherited. `TZ=UTC`, `LC_ALL=C`, a fixed `PATH`, `HOME` pointed at the workspace, and package manager banners suppressed. Inheriting the parent environment is the most common reason a suite passes on one machine and fails on another, so the parent environment is dropped entirely.

Directory listings are sorted, because `readdir` order is filesystem dependent.

The end to end test asserts the actual property: the same failing test in two different workspaces produces **byte identical** output.

Normalization is deliberately narrow. Over-aggressive scrubbing is worse than none, because it can erase the difference between a passing run and a failing one. There is a test asserting that a pass and a fail do not normalize to the same string.

## Verdicts

`run_tests` recognises `node --test`, TAP, Jest, Vitest and Mocha, and reports which parser matched. When none matches it returns `reporter: "exit-code"` with null counts rather than guessing. A wrong count is worse than an absent one, since a grader would treat it as ground truth.

Two rules override a clean-looking summary:

- A non-zero exit code is a failure even when every test reported passing. A suite can print all green and still exit non-zero because teardown crashed.
- A run killed on timeout is never a pass, whatever the partial output said.

## Isolation

Workspaces are addressed by opaque UUID. A caller never sees or supplies an absolute path.

Path containment resolves the target and checks it against a separator terminated prefix. A plain `startsWith(root)` would accept `/tmp/ws-evil` for a root of `/tmp/ws`, and there is a test for exactly that case. Absolute paths, `..` traversal and null bytes are rejected, as are files that would change how a run behaves (`.npmrc`, `.git`). Writes are validated as a batch before any of them touch disk, so a bad path halfway through cannot leave a partial write behind.

Runs are bounded on both axes: a wall clock timeout that kills the whole process group (killing only the direct child leaves orphaned test workers alive), and a per stream output cap so a runaway `console.log` cannot exhaust memory.

**Threat model.** This is workspace isolation, not a security sandbox. `run_tests` executes a command you hand it, with your user's permissions and network access. It protects a grading run from the mess an agent makes, not a host from hostile code. If you are running genuinely untrusted code, put a container or VM boundary around this process.

## Tools

| Tool | Purpose |
| --- | --- |
| `create_workspace` | Creates an isolated temp directory, optionally seeded with files. Returns its id. |
| `write_files` | Writes or overwrites files. All or nothing. |
| `run_tests` | Runs a command under a fixed environment and timeout. Returns a structured verdict plus normalized and raw output. |
| `read_workspace` | Lists files, or reads one. Listings are sorted and exclude `node_modules` and `.git`. |
| `destroy_workspace` | Deletes a workspace. Idempotent. |

Tool descriptions are written for the model that will call them. A model decides whether to reach for a tool almost entirely from its description, so each states what it does, what it returns, and when not to use it.

## Layout

```
src/normalize.ts   output normalization
src/workspace.ts   workspace lifecycle and path containment
src/runner.ts      bounded process execution
src/parsers.ts     test reporter parsing
src/server.ts      MCP tool surface
src/index.ts       stdio entry point
```

Tests drive the server through a linked in-memory transport rather than calling handlers directly, so schema validation, serialization and tool registration are all exercised the way a real host exercises them. A unit test that called the handler would pass even if the tool were never registered.

## Requirements

Node 20 or newer. Runtime dependencies are `@modelcontextprotocol/server` and `zod`, nothing else.

## License

MIT
