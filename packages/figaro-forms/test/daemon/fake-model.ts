import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

export interface FakeModel {
  readonly url: string;
  readonly requests: readonly { readonly prompt: string; readonly toolResult: boolean }[];
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  return "";
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(res: ServerResponse, delta: object, finish: string | null = null): void {
  res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

async function words(res: ServerResponse, said: string, gapMs: number): Promise<void> {
  for (const w of said.split(/(?<= )/)) {
    sse(res, { content: w });
    await sleep(gapMs);
  }
}

export async function startFakeModel(port = 0): Promise<FakeModel> {
  const requests: { prompt: string; toolResult: boolean }[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-1", context_length: 100000, supports_tools: true }] }));
        return;
      }
      const raw = await body(req);
      let messages: ChatMessage[] = [];
      try {
        messages = (JSON.parse(raw) as { messages?: ChatMessage[] }).messages ?? [];
      } catch {
        res.writeHead(400).end();
        return;
      }
      const users = messages.filter((m) => m.role === "user");
      const prompt = text(users[users.length - 1]?.content);
      const toolResult = messages[messages.length - 1]?.role === "tool";
      requests.push({ prompt, toolResult });
      if (prompt.includes("[boom]")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the fake model refused on purpose", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if ((prompt.includes("[tool]") || prompt.includes("[slowtool]")) && !toolResult) {
        sse(res, { role: "assistant", content: "Let me look. " });
        await sleep(40);
        const call = JSON.stringify({ command: prompt.includes("[slowtool]") ? "sleep 1.2 && echo tool-ran-ok" : "echo tool-ran-ok" });
        sse(res, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] });
        for (let i = 0; i < call.length; i += 8) {
          sse(res, { tool_calls: [{ index: 0, function: { arguments: call.slice(i, i + 8) } }] });
          await sleep(20);
        }
        sse(res, {}, "tool_calls");
        res.end("data: [DONE]\n\n");
        return;
      }
      const slow = prompt.includes("[slow]");
      const said = toolResult ? "The tool said tool-ran-ok. Done." : slow ? "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. " : "Buongiorno, signore. Largo al factotum. ";
      sse(res, { role: "assistant" });
      await words(res, said, slow ? 350 : 60);
      sse(res, {}, "stop");
      res.end("data: [DONE]\n\n");
    })().catch(() => res.destroy());
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}/v1`,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
