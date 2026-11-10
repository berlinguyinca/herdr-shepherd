import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";
const ownerEmail = "owner@example.test";

// One owner per database, so this needs a database of its own.
const run = it.skipIf(!databaseUrl || !process.env.COPY_TEST_DATABASE);

async function withApp<T>(
  options: { mode?: "open-owner" | "accounts"; peer?: string; apiHost?: string },
  body: (
    handles: AppHandles,
    open: (origin?: string) => Promise<Response>,
    count: () => Promise<number>,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "rakazo-open-owner-"));
  const handles = await createApp({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: "docker",
    sandbox: new FakeSandboxProvider(),
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    signupAllowlist: "",
    webOrigin,
    authUrl: webOrigin,
    accessMode: options.mode ?? "open-owner",
    ownerEmail,
    ownerName: "Owner",
    apiHost: options.apiHost ?? "127.0.0.1",
    ownerPeerAddress: () => options.peer ?? "127.0.0.1",
  });
  const total = () =>
    runAsSystem("count owners", () => handles.prisma.user.count({ where: { email: ownerEmail } }));
  // Cases share one database, so "creates nothing" means no change from where this one began.
  const baseline = await total();
  try {
    return await body(
      handles,
      async (origin) =>
        handles.app.request("/api/auth/open", {
          method: "POST",
          headers: origin ? { origin } : {},
        }),
      async () => (await total()) - baseline,
    );
  } finally {
    await handles.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

run("open-owner mode signs the owner in once and reuses the account", async () => {
  await withApp({}, async (handles, open, count) => {
    const first = await open(webOrigin);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const cookie = first.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .join("; ");
    expect(cookie).toContain("session_token");
    const body = (await first.json()) as { token: string; user: { email: string } };
    expect(body.user.email).toBe(ownerEmail);
    expect(body.token.length).toBeGreaterThan(20);

    const session = await handles.app.request("/api/auth/get-session", { headers: { cookie } });
    expect(await session.json()).toMatchObject({ user: { email: ownerEmail } });
    // The mobile client sends the token as a bearer.
    const bearer = await handles.app.request("/api/auth/get-session", {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(await bearer.json()).toMatchObject({ user: { email: ownerEmail } });

    expect((await open(webOrigin)).status).toBe(200);
    expect((await open(webOrigin)).status).toBe(200);
    expect(await count()).toBe(1);

    const capabilities = await handles.app.request("/api/auth/capabilities");
    expect(await capabilities.json()).toMatchObject({
      openOwner: true,
      passwordAuth: false,
      passwordReset: false,
    });
  });
});

run("open-owner mode closes signups whatever the environment says", async () => {
  await withApp({}, async (handles, _open, count) => {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: webOrigin },
      body: JSON.stringify({
        email: "stranger@example.test",
        password: "test-password-123",
        name: "Stranger",
      }),
    });
    // Credential routes answer like a server with password sign-in turned off.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_AUTH_DISABLED" });
    expect(await count()).toBe(0);
  });
});

run("a peer outside loopback and Tailscale is refused and creates nothing", async () => {
  await withApp({ peer: "203.0.113.9" }, async (_handles, open, count) => {
    expect((await open(webOrigin)).status).toBe(403);
    expect(await count()).toBe(0);
  });
});

run("a request with no known peer is refused", async () => {
  await withApp({ peer: "" }, async (_handles, open, count) => {
    expect((await open(webOrigin)).status).toBe(403);
    expect(await count()).toBe(0);
  });
});

run("a request carrying a forwarding header is refused and creates nothing", async () => {
  await withApp({}, async (handles, _open, count) => {
    const response = await handles.app.request("/api/auth/open", {
      method: "POST",
      headers: { origin: webOrigin, "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.status).toBe(403);
    expect(await count()).toBe(0);
  });
});

run("a request through the web proxy from this computer is served", async () => {
  await withApp({}, async (handles) => {
    const response = await handles.app.request("/api/auth/open", {
      method: "POST",
      headers: { origin: webOrigin, "x-forwarded-for": "127.0.0.1" },
    });
    expect(response.status).toBe(200);
  });
});

run("a remote caller behind a forged local forwarding entry is refused", async () => {
  await withApp({}, async (handles, _open, count) => {
    const response = await handles.app.request("/api/auth/open", {
      method: "POST",
      headers: { origin: webOrigin, "x-forwarded-for": "127.0.0.1, 203.0.113.9" },
    });
    expect(response.status).toBe(403);
    expect(await count()).toBe(0);
  });
});

run("a Tailscale peer is served", async () => {
  await withApp({ peer: "100.101.102.103" }, async (_handles, open) => {
    expect((await open(webOrigin)).status).toBe(200);
  });
});

run("a foreign or missing Origin is refused and creates nothing", async () => {
  await withApp({}, async (_handles, open, count) => {
    expect((await open("http://evil.example.test")).status).toBe(403);
    expect((await open()).status).toBe(403);
    expect(await count()).toBe(0);
  });
});

run("accounts mode has no open endpoint", async () => {
  await withApp({ mode: "accounts" }, async (handles, open, count) => {
    expect((await open(webOrigin)).status).toBe(404);
    expect(await count()).toBe(0);
    const capabilities = await handles.app.request("/api/auth/capabilities");
    expect(((await capabilities.json()) as { openOwner?: boolean }).openOwner).toBeFalsy();
  });
});

run("the API refuses to start in open-owner mode on a public address", async () => {
  await expect(withApp({ apiHost: "0.0.0.0" }, async () => undefined)).rejects.toThrow(/API_HOST/);
});
