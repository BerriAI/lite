# Developing Speedrail

The React web app and OpenTUI terminal client share a Node backend. Source lives in `client/`, `tui/`, `server/`, and `shared/`.

## Run from source

On macOS with Node 26.4+ and npm, from your checkout:

```sh
npm ci
npm run dev
```

Open **http://localhost:3210**. Configure a provider in Settings, or copy `.env.example` to `.env` and fill in your gateway details. The development command watches the server and serves the web client through Vite.

For a production build, run `npm run build`, then `npm start`. For the terminal, run `npm link` once and launch `speedrail` from your project directory. `npm link` points to this checkout; keep it in place. After pulling updates, run `npm install` and `npm run build` again, and restart any running Speedrail server to load the rebuilt backend.

## Verification

```sh
npm run typecheck
npm test
npm run test:e2e
npm run test:tui
npm run test:tui:startup
npm run build
```

The unit/integration suite uses temporary workspaces and mock provider/MCP servers, including streaming, permissions, cancellation, filesystem boundaries, persistence, and spawned CLI processes. Browser tests run against an isolated fixture server using installed Google Chrome. The terminal suites use real PTYs with mock providers; the startup suite checks bare `speedrail` from a separate project directory, automatic backend startup, suspend/foreground, and clean exit. Real-provider smoke tests are opt-in and require your own configured gateway.

The opt-in built-runtime test targets the exact minimum Node 26.4.0. After building, run `SPEEDRAIL_TEST_NODE=/absolute/path/to/node26.4 npm test -- tests/runtime.test.ts`. It copies the built installation into a temporary directory and does not inherit provider credentials. It reuses installed dependencies, so fresh dependency installation needs separate validation. Older Node 22.13 runtime checks are historical evidence only; the current launcher and dependency set require Node 26.4+.

See [feature coverage](coverage.md) for current scope and [UI principles](ui-principles.md) for interface conventions.

[Back to Speedrail](../README.md)
