import type { Credential } from "./auth/index.js";
import type { Dial } from "./rpc.js";

type Ctor = new (url: string | URL, init?: string | string[] | { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;

export interface WebSocketDialOptions {
  readonly url: string | URL | (() => string | URL);
  readonly credential?: Credential;
  readonly WebSocket?: Ctor;
}

const inBrowser = (): boolean => typeof document !== "undefined";

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
      ws.onerror = () => reject(new Error(`could not open ${String(url)}`));
      ws.onclose = (e) => reject(new Error(e.reason || `upgrade refused or socket closed (${e.code})`));
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
