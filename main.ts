// Entrypoint: bind the forge on an ephemeral port, tell the trial harness
// where it lives, wait for the harness to say the trial is done, then stop.
//
// The harness hands us its base URL in MAKEFUN_ENV_URL. When it is absent
// (a local run) the server simply stays up until it is killed.

import { Store } from './src/store.ts';
import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function register(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await postJson(`${envUrl}/register`, { port })) return;
    await sleep(500);
  }
  throw new Error('could not register with the trial harness');
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // The harness answers again shortly; a failed poll is not fatal.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  const port = address.port;

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    // No harness: stay up for local checks, and say where.
    console.error(`forge listening on 127.0.0.1:${port}`);
    process.on('SIGTERM', () => {
      server.close(() => process.exit(0));
    });
    return;
  }
  await register(envUrl, port);
  await waitForDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
