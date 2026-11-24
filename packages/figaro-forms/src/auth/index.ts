export { refusalOf, writable, type Refusal } from "../access.js";

export interface Upgrade {
  readonly protocols?: readonly string[];
  readonly headers?: { readonly [name: string]: string };
}

export interface Credential {
  readonly name: string;
  upgrade(): Upgrade | Promise<Upgrade>;
}

export type TokenSource = string | (() => string | Promise<string>);

export function edgeSession(): Credential {
  return { name: "edge-session", upgrade: () => ({}) };
}

export function bearer(token: TokenSource): Credential {
  return {
    name: "bearer",
    upgrade: async () => {
      const t = typeof token === "string" ? token : await token();
      return { headers: { Authorization: `Bearer ${t}` } };
    },
  };
}

export function apiKey(key: TokenSource): Credential {
  return { ...bearer(key), name: "api-key" };
}

export function endpointUrl(path = "/rpc", base?: string | URL): URL {
  const from = base ?? (typeof location !== "undefined" ? location.href : undefined);
  if (from === undefined) throw new Error("endpointUrl: no base URL outside a browser");
  const u = new URL(path, from);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  return u;
}

export function bridgeEndpoint(href?: string): URL {
  const page = new URL(href ?? (typeof location !== "undefined" ? location.href : ""));
  const token = new URLSearchParams(page.hash.slice(1)).get("token");
  if (!token) throw new Error("bridgeEndpoint: the page URL has no #token=; open the URL the bridge printed");
  const endpoint = endpointUrl("/rpc", page);
  endpoint.searchParams.set("token", token);
  return endpoint;
}
