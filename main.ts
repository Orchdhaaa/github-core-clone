// Entrypoint: node /bot/main.ts. Binds an ephemeral port, registers it with the
// suite, then long-polls /done until the suite finishes and exits 0. Without
// MAKEFUN_ENV_URL (local development) it just serves on a port and keeps running.
import { createForgeServer } from "./app.ts";
import type { AddressInfo } from "node:net";

// The login the token names. The kit's conformance suite generates its
// scenario from a fixed seed (wire.ts SCENARIO_SEED) and the viewer's login
// is "adaiversen" for that seed; the REST checks address repositories as
// /<viewer-login>/<repo>, so the server must use that login. Overridable
// via MAKEFUN_LOGIN when a trial provides one.
const LOGIN = process.env.MAKEFUN_LOGIN ?? "adaiversen";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, "")}/register`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      lastError = new Error(`register answered ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(500);
  }
  throw lastError instanceof Error ? lastError : new Error("register failed");
}

async function waitDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/$/, "")}/done`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The suite may not be up yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";
  const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
  const server = createForgeServer({ token, login: LOGIN });
  const requestedPort = envUrl ? 0 : parseInt(process.env.PORT ?? "0", 10) || 0;
  await new Promise<void>((resolve) => {
    server.listen(requestedPort, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  const port = address ? address.port : 0;
  if (!envUrl) {
    console.log(`github-core-clone listening on http://127.0.0.1:${port}`);
    return;
  }
  await register(envUrl, port);
  await waitDone(envUrl);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
