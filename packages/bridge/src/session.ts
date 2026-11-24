import type { Credential } from "figaro-forms/auth";

export const onBehalfHeader = "X-Figaro-On-Behalf-Of";

export const sessionHeader = "X-Figchat-Session";
export const noSession = "-";
const sessionPattern = /^[A-Za-z0-9_-]{8,64}$/;
const maxSessions = 8;

export function sessionOf(req: { readonly headers: { readonly [name: string]: string | string[] | undefined }; readonly url?: string | undefined }, upgrade: boolean): string {
  const header = req.headers[sessionHeader.toLowerCase()];
  let v = typeof header === "string" ? header : undefined;
  if (v === undefined && upgrade) {
    try {
      v = new URL(req.url ?? "/", "http://gateway").searchParams.get("session") ?? undefined;
    } catch {
      v = undefined;
    }
  }
  return v !== undefined && sessionPattern.test(v) ? v : noSession;
}

export function sessionList(ids: Iterable<string | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id === undefined || id === noSession || out.includes(id)) continue;
    out.push(id);
    if (out.length === maxSessions) break;
  }
  return out;
}

export const sessionField = (ids: readonly string[]): string => (ids.length > 0 ? ids.join(",") : noSession);

export function withSession(base: Credential | undefined, session: string): Credential | undefined {
  if (session === noSession) return base;
  return {
    name: base ? `${base.name}+session` : "session",
    upgrade: async () => {
      const up = base ? await base.upgrade() : {};
      return { ...up, headers: { ...(up.headers ?? {}), [sessionHeader]: session } };
    },
  };
}

export function onBehalfOf(base: Credential, user: string): Credential {
  return {
    name: `${base.name}+on-behalf-of`,
    upgrade: async () => {
      const up = await base.upgrade();
      return { ...up, headers: { ...(up.headers ?? {}), [onBehalfHeader]: user } };
    },
  };
}
