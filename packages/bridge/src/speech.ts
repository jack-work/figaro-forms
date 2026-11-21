import WebSocket from "ws";
import { sessionField, sessionHeader } from "./door.js";

export interface SpeechRequest {
  readonly key: string;
  readonly voice?: string;
  readonly sessions?: readonly string[];
}

export interface SpeechHandlers {
  audio(pcm: Buffer): void;
  done(audioId: string | undefined): void;
  error(text: string): void;
}

export interface SpeechSession {
  write(text: string): void;
  end(): void;
  cancel(): void;
}

export type SpeechDial = (req: SpeechRequest, on: SpeechHandlers) => SpeechSession;

export const pcmFormat = { format: "pcm", rate: 24000, bits: 16, channels: 1 } as const;

export function speechOverSocket(socketPath: string): SpeechDial {
  return (req, on) => {
    const q = new URLSearchParams({ format: "pcm", key: req.key });
    if (req.voice) q.set("voice", req.voice);
    const sessions = req.sessions ?? [];
    const ws = new WebSocket(`ws+unix://${socketPath}:/tts?${q}`, sessions.length > 0 ? { headers: { [sessionHeader]: sessionField(sessions) } } : {});
    const queue: string[] = [];
    let open = false;
    let finished = false;
    const settle = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      fn();
    };
    const sendNow = (frame: string): void => ws.send(frame);
    ws.on("open", () => {
      open = true;
      for (const f of queue.splice(0)) sendNow(f);
    });
    ws.on("message", (data, binary) => {
      if (finished) return;
      if (binary) {
        on.audio(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
        return;
      }
      let f: { audio_id?: unknown; error?: unknown };
      try {
        f = JSON.parse(data.toString()) as typeof f;
      } catch {
        return;
      }
      if (typeof f.error === "string") settle(() => on.error(f.error as string));
      else if (f.audio_id !== undefined) settle(() => on.done(String(f.audio_id)));
    });
    ws.on("error", (e) => settle(() => on.error(e.message)));
    ws.on("close", () => settle(() => on.error("speech socket closed before the audio was complete")));
    const send = (obj: unknown): void => {
      if (finished) return;
      const frame = JSON.stringify(obj);
      if (open) sendNow(frame);
      else queue.push(frame);
    };
    return {
      write: (text) => send({ text }),
      end: () => send({ end: true }),
      cancel: () => {
        finished = true;
        queue.length = 0;
        ws.terminate();
      },
    };
  };
}
