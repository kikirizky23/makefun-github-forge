// Entry point for the GitHub-compatible git forge (make.fun github-core-clone-01).
//
// The harness drives this process through two HTTP calls against the env URL:
//   1. POST /register  with { "port": <the port we ended up listening on> }
//   2. GET  /done      polled until it answers { "done": true }
//
// The port is never hard-coded: we ask the OS for a free one (listen(0)) and
// report back whatever it chose, so this entrypoint works in any sandbox.

import { createApp } from "./app.ts";

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? "";
const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function announcePort(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
  });
  if (!res.ok) {
    throw new Error(`register failed: HTTP ${res.status}`);
  }
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    const res = await fetch(`${ENV_URL}/done`);
    if (!res.ok) {
      throw new Error(`done poll failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { done?: unknown };
    if (body.done === true) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

// Bind the app to an OS-chosen free port and hand back the port number.
async function startServer(): Promise<number> {
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  boundServer = server;
  return addr.port;
}

// The running server, kept so main() can shut it down once the harness is done.
let boundServer: ReturnType<typeof createApp> | null = null;

async function shutdownServer(): Promise<void> {
  if (boundServer === null) return;
  const server = boundServer;
  boundServer = null;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  if (!ENV_URL) {
    throw new Error("MAKEFUN_ENV_URL is not set");
  }

  const port = await startServer();
  await announcePort(port);
  await waitUntilDone();
  await shutdownServer();
}

await main();
process.exit(0);
