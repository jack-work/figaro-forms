import { Connection, type ConnectionState, type Dial } from "./rpc.js";
import { method, protocolVersion, type Capability, type HelloResponse } from "./wire.js";

export interface LinkOptions {
  readonly dial: Dial;
  readonly callTimeoutMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly releaseGraceMs?: number;
}

export abstract class Link {
  readonly connection: Connection;
  private helloValue: HelloResponse | undefined;

  constructor(opts: LinkOptions) {
    this.connection = new Connection({
      dial: opts.dial,
      ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
      ...(opts.retryMinMs !== undefined ? { retryMinMs: opts.retryMinMs } : {}),
      ...(opts.retryMaxMs !== undefined ? { retryMaxMs: opts.retryMaxMs } : {}),
      onOpen: (conn) => this.greet(conn),
    });
    this.connection.on(method.lapsed, () => this.connection.reconnectNow());
    this.connection.onState((state) => {
      if (state === "open") {
        this.connected(this.connection.epoch);
        return;
      }
      this.helloValue = undefined;
      this.disconnected(state);
    });
  }

  get hello(): HelloResponse | undefined {
    return this.helloValue;
  }

  get state(): ConnectionState {
    return this.connection.state;
  }

  protected abstract connected(generation: number): void;
  protected abstract disconnected(state: ConnectionState): void;

  protected greeted(): void {}

  protected offers(cap: Capability): boolean {
    return this.helloValue?.capabilities?.includes(cap) ?? false;
  }

  private async greet(conn: Connection): Promise<void> {
    const generation = conn.epoch;
    const hello = await conn.send<HelloResponse>(method.hello, { version: protocolVersion });
    if (generation !== conn.epoch) return;
    this.helloValue = hello;
    this.greeted();
  }
}
