import type { Credential } from "./auth/index.js";
import type { Dial } from "./rpc.js";

type Ctor = new (url: string | URL, init?: string | string[] | { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;

export interface WebSocketDialOptions {
  readonly url: string | URL | (() => string | URL);
  readonly credential?: Credential;
  readonly WebSocket?: Ctor;
}

const inBrowser = (): boolean => typeof document !== "undefined";

const maxReason = 512;

function refused(url: string | URL, status?: number, reason?: string): Error {
  const detail = [status ? `HTTP ${status}` : "", reason ?? ""].filter(Boolean).join(": ");
  return Object.assign(new Error(`could not open ${String(url)}${detail ? `: ${detail}` : ""}`), status ? { status } : {});
}

interface UpgradeResponse {
  readonly statusCode?: number;
  setEncoding(enc: string): void;
  on(ev: "data", f: (chunk: string) => void): void;
  on(ev: "end" | "error", f: () => void): void;
  destroy(): void;
}

function onRefusedUpgrade(ws: WebSocket, done: (status: number, reason: string) => void): void {
  const node = ws as unknown as { on?: (ev: string, f: (req: { destroy(): void }, res: UpgradeResponse) => void) => void };
  if (typeof node.on !== "function") return;
  node.on("unexpected-response", (req, res) => {
    let body = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      req.destroy();
      res.destroy();
      done(res.statusCode ?? 0, body.trim().slice(0, maxReason));
    };
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length >= maxReason) finish();
    });
    res.on("end", finish);
    res.on("error", finish);
  });
}

export function webSocketDial(o: WebSocketDialOptions): Dial {
  return async (events) => {
    const up = (await o.credential?.upgrade()) ?? {};
    const url = typeof o.url === "function" ? o.url() : o.url;
    const WS = o.WebSocket ?? (globalThis.WebSocket as unknown as Ctor | undefined);
    if (!WS) throw new Error("no WebSocket implementation in this runtime");
    const protocols = up.protocols ? [...up.protocols] : undefined;
    let ws: WebSocket;
    if (up.headers) {
      if (inBrowser()) {
        throw new Error(`a browser cannot send headers on a WebSocket upgrade: ${o.credential?.name ?? "this credential"} works only outside a browser; behind the edge use edgeSession()`);
      }
      ws = new WS(url, { headers: { ...up.headers }, ...(protocols ? { protocols } : {}) });
    } else {
      ws = protocols ? new WS(url, protocols) : new WS(url);
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => {
        const status = Number(/Unexpected server response: (\d{3})/.exec((e as { message?: string }).message ?? "")?.[1]);
        reject(refused(url, Number.isFinite(status) && status > 0 ? status : undefined));
      };
      ws.onclose = (e) => reject(new Error(`${e.reason || "upgrade refused or socket closed"} (close ${e.code})`));
      onRefusedUpgrade(ws, (status, reason) => reject(refused(url, status, reason)));
    });
    ws.onerror = null;
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") events.message(e.data);
    };
    ws.onclose = (e: CloseEvent) => events.closed(e.reason || `socket closed (${e.code})`);
    return {
      send: (frame) => ws.send(frame),
      close: () => ws.close(),
    };
  };
}
