import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { webSocketDial } from "../src/websocket.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function refusingEndpoint(status: number, body: string): Promise<string> {
  server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/rpc`;
}

describe("webSocketDial", () => {
  it("names the status and the endpoint's reason when the upgrade is refused, so a gateway can log why", async () => {
    const url = await refusingEndpoint(403, "on-behalf-of refused: no delegation\n");
    const dial = webSocketDial({ url, WebSocket: NodeWebSocket as unknown as never });
    const err = await dial({ message: () => {}, closed: () => {} }).then(
      () => undefined,
      (e: unknown) => e as Error & { status?: number },
    );
    expect(err?.status).toBe(403);
    expect(err?.message).toBe(`could not open ${url}: HTTP 403: on-behalf-of refused: no delegation`);
  });

  it("keeps the status a token refresh keys on when the endpoint answers 401", async () => {
    const url = await refusingEndpoint(401, "unauthorized");
    const dial = webSocketDial({ url, WebSocket: NodeWebSocket as unknown as never });
    const err = await dial({ message: () => {}, closed: () => {} }).catch((e: Error & { status?: number }) => e);
    expect((err as { status?: number }).status).toBe(401);
  });
});
