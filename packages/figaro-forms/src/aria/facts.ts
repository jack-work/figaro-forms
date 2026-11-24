import { ConnectionLost } from "../rpc.js";
import type { AriaClient } from "./client.js";
import { Feed, feedOf } from "./feeds.js";
import { text } from "./rows.js";
import { treeFeedOf, type TreeNode } from "./tree.js";
import type { Page } from "./wire.js";

export interface AriaFacts {
  readonly aria: string;
  readonly ready: boolean;
  readonly mantra: string | undefined;
  readonly turns: number | undefined;
  readonly error: string | undefined;
}

const lastTurn = (page: Page): number => page.parts.reduce((n, p) => Math.max(n, p.turn), 0);

const activityOf = (n: TreeNode | undefined): string => (n ? `${n.state}\0${n.activeAt ?? ""}\0${n.ctx ?? ""}` : "");

export class AriaFactsFeed extends Feed<AriaFacts> {
  constructor(
    private readonly client: AriaClient,
    private readonly aria: string,
  ) {
    super({ aria, ready: false, mantra: undefined, turns: undefined, error: undefined });
  }

  protected open(): () => void {
    const { client, aria } = this;
    const tree = treeFeedOf(client);
    let session = 0;
    let reading = false;
    let readAgain = false;
    let seen: string | undefined;
    let turns: number | undefined;
    let pageMantra: string | undefined;
    let error: string | undefined;

    const show = (): void => {
      const n = tree.get().nodes.get(aria);
      this.publish({ aria, ready: turns !== undefined, mantra: n ? n.mantra : pageMantra, turns, error });
    };

    const count = (): void => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      const mine = session;
      const settled = (): void => {
        reading = false;
        show();
        if (readAgain) {
          readAgain = false;
          count();
        }
      };
      client.read(aria, { backward: true, limit: 1 }).then(
        (page) => {
          if (mine !== session) return;
          turns = lastTurn(page);
          pageMantra = text(page.metrics?.mantra);
          error = undefined;
          settled();
        },
        (err: unknown) => {
          if (mine !== session) return;
          if (!(err instanceof ConnectionLost)) error = err instanceof Error ? err.message : String(err);
          settled();
        },
      );
    };

    const moved = (): void => {
      const now = activityOf(tree.get().nodes.get(aria));
      if (seen === undefined || (seen !== "" && now !== "" && now !== seen)) count();
      seen = now;
      show();
    };

    const offTree = tree.subscribe(moved);
    const offLink = client.connection.onState((state) => {
      if (state === "open" && !reading) count();
    });
    moved();
    return () => {
      session++;
      reading = false;
      readAgain = false;
      offTree();
      offLink();
    };
  }
}

export const ariaFactsFeedOf = (client: AriaClient, aria: string): Feed<AriaFacts> => feedOf(client, `facts\0${aria}`, () => new AriaFactsFeed(client, aria));
