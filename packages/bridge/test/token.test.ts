import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { webSocketDial } from "figaro-forms";
import { onBehalfOf } from "../src/session.js";
import { ClientCredentials, redialAfterRejection } from "../src/token.js";

interface Hit {
  readonly auth: string;
  readonly body: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function endpoint(): Promise<{ url: string; hits: Hit[]; mode: { status: number; expiresIn: number }; server: Server }> {
  const hits: Hit[] = [];
  const mode = { status: 200, expiresIn: 100 };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      hits.push({ auth: String(req.headers.authorization), body: Buffer.concat(parts).toString() });
      if (mode.status !== 200) return void res.writeHead(mode.status).end("nope");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: `tok-${hits.length}`, expires_in: mode.expiresIn, token_type: "bearer" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise<void>((ok) => server.close(() => ok())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, hits, mode, server };
}

function stub(): { fetch: typeof fetch; calls: number; mode: { status: number; expiresIn: number } } {
  const s = { calls: 0, mode: { status: 200, expiresIn: 100 }, fetch: undefined as unknown as typeof fetch };
  s.fetch = (async () => {
    s.calls++;
    if (s.mode.status !== 200) return new Response("nope", { status: s.mode.status });
    return new Response(JSON.stringify({ access_token: `tok-${s.calls}`, expires_in: s.mode.expiresIn }), { status: 200 });
  }) as typeof fetch;
  return s;
}

const opts = (url: string, extra: Partial<ConstructorParameters<typeof ClientCredentials>[0]> = {}) => ({
  tokenUrl: url,
  clientId: "figaro-gateway",
  secret: () => "s3cret/+",
  audience: "https://fig.kelliher.info",
  ...extra,
});

describe("client credentials", () => {
  it("asks for the audience with the client as basic auth, and never sends the secret in the body", async () => {
    const ep = await endpoint();
    const c = new ClientCredentials(opts(ep.url));
    cleanups.push(() => c.close());
    await c.start();
    expect(await c.token()).toBe("tok-1");
    expect(ep.hits).toHaveLength(1);
    expect(ep.hits[0]?.auth).toBe(`Basic ${Buffer.from("figaro-gateway:s3cret%2F%2B").toString("base64")}`);
    const body = new URLSearchParams(ep.hits[0]?.body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("audience")).toBe("https://fig.kelliher.info");
    expect(ep.hits[0]?.body).not.toContain("s3cret");
  });

  it("refreshes at 80% of expires_in, before the token expires", async () => {
    vi.useFakeTimers();
    const f = stub();
    const c = new ClientCredentials(opts("http://x/token", { fetch: f.fetch }));
    cleanups.push(() => c.close());
    await c.start();
    await vi.advanceTimersByTimeAsync(79_000);
    expect(f.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.calls).toBe(2);
    expect(await c.token()).toBe("tok-2");
  });

  it("keeps the old token and retries with backoff when a refresh fails, then recovers", async () => {
    vi.useFakeTimers();
    const f = stub();
    const lines: string[] = [];
    const c = new ClientCredentials(opts("http://x/token", { fetch: f.fetch, log: (l) => lines.push(l), retryMinMs: 1000, retryMaxMs: 4000 }));
    cleanups.push(() => c.close());
    await c.start();
    f.mode.status = 503;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(f.calls).toBe(2);
    expect(await c.token()).toBe("tok-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.calls).toBe(4);
    expect(lines.join("\n")).toContain("503");
    expect(lines.join("\n")).toContain("keeping the token");
    expect(lines.join("\n")).not.toContain("s3cret");
    f.mode.status = 200;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await c.token()).toBe("tok-5");
  });

  it("retries an unavailable token endpoint at start with backoff, as when Authelia restarts beside the gateway", async () => {
    vi.useFakeTimers();
    const f = stub();
    f.mode.status = 502;
    const c = new ClientCredentials(opts("http://x/token", { fetch: f.fetch, retryMinMs: 1000, retryMaxMs: 4000 }));
    cleanups.push(() => c.close());
    const started = c.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.calls).toBe(3);
    f.mode.status = 200;
    await vi.advanceTimersByTimeAsync(4_000);
    await started;
    expect(await c.token()).toBe("tok-4");
  });

  it("gives up at start once the retries would pass startWithinMs", async () => {
    vi.useFakeTimers();
    const f = stub();
    f.mode.status = 503;
    const c = new ClientCredentials(opts("http://x/token", { fetch: f.fetch, retryMinMs: 1000, retryMaxMs: 4000, startWithinMs: 10_000 }));
    cleanups.push(() => c.close());
    const started = expect(c.start()).rejects.toThrow("503");
    await vi.advanceTimersByTimeAsync(20_000);
    await started;
    expect(f.calls).toBe(4);
  });

  it("mints a token that lasts past a time only when the one it holds does not", async () => {
    const ep = await endpoint();
    let t = 1_000_000;
    const c = new ClientCredentials(opts(ep.url, { now: () => t, refreshAt: 100 }));
    cleanups.push(() => c.close());
    expect(await c.lasting(t)).toBe(t + 100_000);
    expect(ep.hits).toHaveLength(1);
    expect(await c.lasting(t + 50_000)).toBe(t + 100_000);
    expect(ep.hits).toHaveLength(1);
    t += 40_000;
    expect(await c.lasting(t + 61_000)).toBe(t + 100_000);
    expect(ep.hits).toHaveLength(2);
    expect(await c.token()).toBe("tok-2");
  });

  it("fails start when the first mint fails, and token() fails once the held token has expired and refresh keeps failing", async () => {
    const ep = await endpoint();
    ep.mode.status = 401;
    const first = new ClientCredentials(opts(ep.url));
    await expect(first.start()).rejects.toThrow("401");
    ep.mode.status = 200;
    ep.mode.expiresIn = 1;
    let t = 0;
    const c = new ClientCredentials(opts(ep.url, { now: () => t, refreshAt: 100 }));
    cleanups.push(() => c.close());
    await c.start();
    ep.mode.status = 500;
    t = 10_000;
    await expect(c.token()).rejects.toThrow("500");
  });

  it("mints again after a 401 on dial and redials once with the new token", async () => {
    const ep = await endpoint();
    const c = new ClientCredentials(opts(ep.url));
    cleanups.push(() => c.close());
    await c.start();
    const used: string[] = [];
    const dial = redialAfterRejection(async () => {
      const t = await c.token();
      used.push(t);
      if (t === "tok-1") throw Object.assign(new Error("could not open"), { status: 401 });
      return { send: () => {}, close: () => {} };
    }, (g) => c.rejected(g), () => c.generation);
    await dial({ message: () => {}, closed: () => {} });
    expect(used).toEqual(["tok-1", "tok-2"]);
  });

  it("does not throw away a token minted since the one that was refused", async () => {
    const ep = await endpoint();
    const c = new ClientCredentials(opts(ep.url));
    cleanups.push(() => c.close());
    await c.start();
    const stale = c.generation;
    await c.token();
    c.rejected(0);
    expect(await c.token()).toBe("tok-1");
    c.rejected(stale);
    expect(await c.token()).toBe("tok-2");
    const fresh = c.generation;
    c.rejected(stale);
    expect(c.generation).toBe(fresh);
    expect(await c.token()).toBe("tok-2");
  });

  it("logs and backs off when the secret file cannot be read, keeping the token it has", async () => {
    vi.useFakeTimers();
    const f = stub();
    const lines: string[] = [];
    let readable = true;
    const c = new ClientCredentials(opts("http://x/token", { fetch: f.fetch, log: (l) => lines.push(l), retryMinMs: 1000, secret: () => { if (!readable) throw new Error("ENOENT: no such file '/run/credentials/client-secret'"); return "s"; } }));
    cleanups.push(() => c.close());
    await c.start();
    readable = false;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(lines.join("\n")).toContain("unreadable");
    expect(lines.join("\n")).not.toContain("/run/credentials");
    expect(await c.token()).toBe("tok-1");
    readable = true;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await c.token()).toBe("tok-2");
  });

  it("does not retry other failures", async () => {
    let n = 0;
    const dial = redialAfterRejection(async () => {
      n++;
      throw Object.assign(new Error("boom"), { status: 500 });
    }, () => {}, () => 0);
    await expect(dial({ message: () => {}, closed: () => {} })).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  it("sees a 401 refused upgrade as status 401 on the dial error", async () => {
    const server = createServer();
    server.on("upgrade", (_req, sock) => sock.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise<void>((ok) => server.close(() => ok())));
    const dial = webSocketDial({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/door`,
      credential: { name: "t", upgrade: () => ({ headers: { Authorization: "Bearer x" } }) },
      WebSocket: WebSocket as never,
    });
    await expect(dial({ message: () => {}, closed: () => {} })).rejects.toMatchObject({ status: 401 });
  });

  it("adds the user the gateway acts for to the upgrade, beside the bearer", async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const server = createServer();
    server.on("upgrade", (req, sock) => {
      seen.push(req.headers);
      sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise<void>((ok) => server.close(() => ok())));
    const cred = onBehalfOf({ name: "bearer", upgrade: () => ({ headers: { Authorization: "Bearer t" } }) }, "gluck");
    const dial = webSocketDial({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/door`, credential: cred, WebSocket: WebSocket as never });
    await expect(dial({ message: () => {}, closed: () => {} })).rejects.toMatchObject({ status: 403 });
    expect(seen[0]?.["x-figaro-on-behalf-of"]).toBe("gluck");
    expect(seen[0]?.authorization).toBe("Bearer t");
  });
});
