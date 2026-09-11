# Developing Litespeed

The React web app and OpenTUI terminal client share a Node backend. Source lives in `client/`, `tui/`, `server/`, and `shared/`.

## Run from source

On macOS with Node 26.4+ and npm, from your checkout:

```sh
npm ci
npm run dev
```

Open **http://localhost:3210**. Configure a provider in Settings, or copy `.env.example` to `.env` and fill in your gateway details. The development command watches the server and serves the web client through Vite.

For a production build, run `npm run build`, then `npm start`. For the terminal, run `npm link` once and launch `litespeed` from your project directory. `npm link` points to this checkout; keep it in place. After pulling updates, run `npm install` and `npm run build` again, and restart any running Litespeed server to load the rebuilt backend.

## Verification

```sh
npm run typecheck
npm test
npm run test:e2e
npm run test:tui
npm run test:tui:startup
npm run build
```

The unit/integration suite uses temporary workspaces and mock provider/MCP servers, including streaming, permissions, cancellation, filesystem boundaries, persistence, and spawned CLI processes. Browser tests run against an isolated fixture server using installed Google Chrome. The terminal suites use real PTYs with mock providers; the startup suite checks bare `litespeed` from a separate project directory, automatic backend startup, suspend/foreground, and clean exit. Real-provider smoke tests are opt-in and require your own configured gateway.

The opt-in built-runtime test targets the exact minimum Node 26.4.0. After building, run `LITESPEED_TEST_NODE=/absolute/path/to/node26.4 npm test -- tests/runtime.test.ts`. It copies the built installation into a temporary directory and does not inherit provider credentials. It reuses installed dependencies, so fresh dependency installation needs separate validation. Older Node 22.13 runtime checks are historical evidence only; the current launcher and dependency set require Node 26.4+.

See [feature coverage](coverage.md) for current scope and [UI principles](ui-principles.md) for interface conventions.

## Real gateway compaction tests

These opt-in tests make paid model requests. Supply a gateway and two tool-capable model IDs through environment variables:

```sh
export LITELLM_BASE_URL=https://your-gateway.example/v1
export LITELLM_API_KEY=your-key
export LITESPEED_TEST_DRIVER=your-driver-model
export LITESPEED_TEST_WORKER=your-worker-model
LITESPEED_LIVE=1 node --import tsx scripts/test-live-context.ts
LITESPEED_LIVE=1 LITESPEED_LIVE_WORKFLOW=1 \
  LITESPEED_LIVE_CASES=sidekick-fusion-baseline-tools,sidekick-fusion-compact-tools \
  LITESPEED_LIVE_RESULTS=test-results/live-context-tools \
  node --import tsx scripts/test-live-context.ts
```

The first command runs compaction on/off across all four architectures. The second compares Sidekick file editing and an actual test command with compaction on/off. Both use temporary workspaces and databases, the real HTTP API and runner, and real gateway responses. Seeded history holds four exact decisions; assertions check the summary, continuation, worker completion, and root-session usage attribution. The tool workflow also checks the written file, passing process exit, and unchanged test harness. A 16,384-token model override forces compaction without a huge paid workload; the baseline uses a 200,000-token window. Both chosen models must support these input sizes. Each case has a six-minute test deadline.

JSON reports go to `test-results/live-context` by default, or `LITESPEED_LIVE_RESULTS`. They contain fixture responses and token usage, without provider credentials. These tests complement the deterministic overflow, empty-summary, cancellation, undo/redo, repeated-compaction, and UI tests; they are not a summary-quality benchmark for arbitrary repositories.

[Back to Litespeed](../README.md)
