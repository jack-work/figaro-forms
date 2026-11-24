import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface EdgeGate {
  readonly secret: string;
  readonly admin: string;
  readonly peers?: readonly string[];
}

export const edgeHeader = "x-figaro-edge";

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function edgeRefusal(edge: EdgeGate, req: IncomingMessage): string | undefined {
  if (edge.peers) {
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!edge.peers.includes(peer)) return "not from the edge";
  }
  const given = req.headers[edgeHeader];
  if (typeof given !== "string" || !sameSecret(given, edge.secret)) return "not from the edge";
  if (req.headers["remote-user"] !== edge.admin) return "admin only";
  return undefined;
}
