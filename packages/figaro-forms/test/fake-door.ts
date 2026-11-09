import { equal, type Json, type JsonObject } from "../src/json.js";
import { applyRoot, type Patch } from "../src/patch.js";
import type { Dial, Socket, SocketEvents } from "../src/rpc.js";
import type { FormAccess, FormView } from "../src/wire.js";

interface FakeForm {
  value: JsonObject;
  version: number;
  incarnation: number;
  lastSeq: Map<string, number>;
  access?: FormAccess;
  view?: FormView;
}

interface Frame {
  id: number;
  method: string;
  params: Record<string, Json> & { figaro_id?: string };
}

export interface Conn {
  readonly events: SocketEvents;
  readonly follows: Set<string>;
  open: boolean;
  readonly received: Frame[];
}

export class FakeDoor {
  readonly forms = new Map<string, FakeForm>();
  readonly conns: Conn[] = [];
  principal = "user:gluck";
  refuse: ((id: string, patch: Patch) => string | undefined) | undefined;
  unavailable = 0;
  holdReplies = false;
  private held: (() => void)[] = [];
  private minted = 0;
  dials = 0;
  refuseDial: string | undefined;

  add(id: string, value: JsonObject, extra: Partial<FakeForm> = {}): void {
    this.forms.set(id, { value, version: 1, incarnation: 1, lastSeq: new Map(), ...extra });
  }

  dial: Dial = async (events) => {
    this.dials++;
    if (this.refuseDial) throw new Error(this.refuseDial);
    const conn: Conn = { events, follows: new Set(), open: true, received: [] };
    this.conns.push(conn);
    const socket: Socket = {
      send: (frame) => {
        if (!conn.open) throw new Error("socket closed");
        const f = JSON.parse(frame) as Frame;
        conn.received.push(f);
        queueMicrotask(() => this.handle(conn, f));
      },
      close: () => {
        if (!conn.open) return;
        conn.open = false;
        queueMicrotask(() => events.closed("closed by client"));
      },
    };
    return socket;
  };

  drop(reason = "dropped"): void {
    for (const c of this.conns) {
      if (!c.open) continue;
      c.open = false;
      c.events.closed(reason);
    }
  }

  release(): void {
    this.holdReplies = false;
    for (const fn of this.held.splice(0)) fn();
  }

  write(id: string, patch: Patch, origin = "", seq = 0): number {
    const f = this.mustForm(id);
    const next = applyRoot(patch, f.value);
    if (equal(next, f.value)) return f.version;
    f.value = next;
    f.version++;
    this.push(id, { schema: 2, aria_id: id, version: f.version, incarnation: f.incarnation, patch: patch as Json, at: Date.now(), ...(origin ? { origin, seq } : {}) });
    return f.version;
  }

  skipVersion(id: string, patch: Patch): void {
    const f = this.mustForm(id);
    f.value = applyRoot(patch, f.value);
    f.version++;
  }

  reincarnate(id: string, value: JsonObject): void {
    const f = this.mustForm(id);
    f.value = value;
    f.incarnation++;
    f.version = 1;
  }

  kill(id: string): void {
    this.forms.delete(id);
    this.push(id, { figaro_id: id }, "figaro.closed");
  }

  lapse(): void {
    for (const c of this.conns) if (c.open) this.notify(c, "door.lapsed", { reason: "age", after_ms: 1 });
    queueMicrotask(() => this.drop("lapsed"));
  }

  pushRaw(id: string, params: Record<string, Json>, method = "form.delta"): void {
    this.push(id, params, method);
  }

  private push(id: string, params: Record<string, Json>, method = "form.delta"): void {
    for (const c of this.conns) {
      if (c.open && c.follows.has(id)) this.notify(c, method, { figaro_id: id, ...params });
    }
  }

  private notify(c: Conn, method: string, params: Json): void {
    c.events.message(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private reply(c: Conn, id: number, body: { result?: Json; error?: { code: number; message: string } }): void {
    const send = (): void => {
      if (c.open) c.events.message(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    };
    if (this.holdReplies) this.held.push(send);
    else send();
  }

  private mustForm(id: string): FakeForm {
    const f = this.forms.get(id);
    if (!f) throw new Error(`no form ${id}`);
    return f;
  }

  private handle(c: Conn, f: Frame): void {
    if (!c.open) return;
    const err = (message: string, code = -32000): void => this.reply(c, f.id, { error: { code, message } });
    const id = f.params?.figaro_id ?? "";
    switch (f.method) {
      case "angelus.hello":
        this.reply(c, f.id, { result: { version: 1, capabilities: ["form.seq", "form.access", "form.view"], node: "n1", principal: { kind: "user", id: "gluck" } } });
        return;
      case "figaro.follow":
        if (!this.forms.has(id)) return err(`figaro.follow: no such form ${id}`);
        c.follows.add(id);
        this.reply(c, f.id, { result: { ok: true, figaro_id: id } });
        return;
      case "figaro.form": {
        const form = this.forms.get(id);
        if (!form) return err(`figaro.form: no such form ${id}`);
        const client = typeof f.params.client === "string" ? f.params.client : "";
        const origin = client ? `${this.principal}/${client}` : "";
        this.reply(c, f.id, {
          result: {
            snapshot: form.value,
            version: form.version,
            incarnation: form.incarnation,
            last_seq: form.lastSeq.get(origin) ?? 0,
            origin,
            ...(form.access ? { access: form.access as unknown as Json } : {}),
            ...(form.view ? { view: form.view as unknown as Json } : {}),
          },
        });
        return;
      }
      case "figaro.set": {
        if (this.unavailable > 0) {
          this.unavailable--;
          return err("form unavailable", -32041);
        }
        const form = this.forms.get(id);
        if (!form) return err(`figaro.set: no such form ${id}`);
        const patch = f.params.patch as Patch;
        const refusal = this.refuse?.(id, patch);
        if (refusal) return err(refusal);
        const client = typeof f.params.client === "string" ? f.params.client : "";
        const seq = typeof f.params.seq === "number" ? f.params.seq : 0;
        const origin = client ? `${this.principal}/${client}` : "";
        if (origin && seq > 0 && seq <= (form.lastSeq.get(origin) ?? 0)) {
          this.reply(c, f.id, { result: { ok: true, outcome: "duplicate", version: form.version } });
          return;
        }
        const ifVersion = typeof f.params.if_version === "number" ? f.params.if_version : 0;
        if (ifVersion && ifVersion !== form.version) return err(`form moved: at version ${form.version}, not ${ifVersion}: re-read and retry`);
        if (origin && seq > 0) form.lastSeq.set(origin, seq);
        const before = form.version;
        const version = this.write(id, patch, origin, seq);
        this.reply(c, f.id, { result: { ok: true, outcome: version === before ? "unchanged" : "applied", version } });
        return;
      }
      case "form.create": {
        const formId = `@${(++this.minted).toString(16).padStart(8, "0")}`;
        this.add(formId, applyRoot((f.params.patch as Patch) ?? {}, {}));
        this.reply(c, f.id, { result: { form_id: formId, version: 1 } });
        return;
      }
    }
    err(`method not found: ${f.method}`, -32601);
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}
