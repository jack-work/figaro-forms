import { atom, type Atom, type WritableAtom } from "jotai/vanilla";
import type { ConnectionState } from "../rpc.js";
import type { AriaClient, AriaList, ListOptions } from "./client.js";
import type { AriaRow } from "./wire.js";
import { ariaFactsFeedOf, boundFormFeedOf, recentFeedOf, treeFeedOf, type AriaFacts, type BoundFormState, type Feed, type RecentState, type TreeState } from "./surface.js";
import type { AppliedFrame, AriaSnapshot, AriaStream, Phase } from "./stream.js";

const families = new WeakMap<AriaClient, Map<string, unknown>>();

function memo<T>(client: AriaClient, key: string, make: () => T): T {
  let m = families.get(client);
  if (!m) {
    m = new Map();
    families.set(client, m);
  }
  let a = m.get(key) as T | undefined;
  if (a === undefined) {
    a = make();
    m.set(key, a);
  }
  return a;
}

function ticker(client: AriaClient, aria: string, listen: (s: AriaStream, bump: () => void) => () => void): WritableAtom<number, [(n: number) => number], void> {
  const tick = atom(0);
  tick.onMount = (set) => {
    const stream = client.retain(aria);
    const off = listen(stream, () => set((n) => n + 1));
    return () => {
      off();
      client.release(aria);
    };
  };
  return tick as unknown as WritableAtom<number, [(n: number) => number], void>;
}

export function ariaAtom(client: AriaClient, aria: string): Atom<AriaSnapshot> {
  return memo(client, `s\0${aria}`, () => {
    const tick = ticker(client, aria, (s, bump) => s.onChange(bump));
    return atom((get) => {
      get(tick);
      return client.peek(aria).snapshot();
    });
  });
}

export function ariaPhaseAtom(client: AriaClient, aria: string): Atom<Phase> {
  return memo(client, `p\0${aria}`, () => {
    const tick = ticker(client, aria, (s, bump) => s.onChange(bump));
    return atom((get) => {
      get(tick);
      return client.peek(aria).state;
    });
  });
}

export function ariaFrameAtom(client: AriaClient, aria: string): Atom<AppliedFrame | undefined> {
  return memo(client, `f\0${aria}`, () => {
    let latest: AppliedFrame | undefined;
    const tick = ticker(client, aria, (s, bump) =>
      s.onFrame((a) => {
        latest = a;
        bump();
      }),
    );
    return atom((get) => {
      get(tick);
      return latest;
    });
  });
}

export function ariaListAtom(client: AriaClient, o: ListOptions = {}): WritableAtom<Promise<AriaList>, [], void> {
  return memo(client, `l\0${JSON.stringify(o)}`, () => {
    const rev = atom(0);
    return atom(
      (get) => {
        get(rev);
        return client.list(o);
      },
      (_get, set) => set(rev, (n) => n + 1),
    );
  });
}

export function ariaConnectionAtom(client: AriaClient): Atom<ConnectionState> {
  return memo(client, "c", () => {
    const tick = atom(0);
    tick.onMount = (set) => client.connection.onState(() => set((n) => n + 1));
    return atom((get) => {
      get(tick);
      return client.connection.state;
    });
  });
}

export interface AriaRoster {
  readonly rows: readonly AriaRow[];
  readonly next: string | undefined;
  readonly refused: number;
  readonly refusedWhy: string | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}

export type RosterAction = "more" | "refresh";

export function ariaRosterAtom(client: AriaClient, o: Omit<ListOptions, "before"> = {}): WritableAtom<AriaRoster, [RosterAction], Promise<void>> {
  return memo(client, `r\0${JSON.stringify(o)}`, () => {
    const initial: AriaRoster = { rows: [], next: undefined, refused: 0, refusedWhy: undefined, loading: true, error: undefined };
    const state = atom(initial);
    let generation = 0;
    let cursor: string | undefined;
    let inflight = false;

    const load = (write: (fn: (prev: AriaRoster) => AriaRoster) => void, action: RosterAction): Promise<void> => {
      if (action === "more" && (cursor === undefined || inflight)) return Promise.resolve();
      const mine = ++generation;
      inflight = true;
      write((s) => ({ ...s, loading: true }));
      const req: ListOptions = action === "more" ? { ...o, before: cursor as string } : o;
      return client.list(req).then(
        (list) => {
          if (mine !== generation) return;
          inflight = false;
          cursor = list.nextBefore;
          write((s) => ({
            rows: action === "more" ? [...s.rows, ...list.rows] : list.rows,
            next: list.nextBefore,
            refused: list.refused,
            refusedWhy: list.refusedWhy,
            loading: false,
            error: undefined,
          }));
        },
        (error: unknown) => {
          if (mine !== generation) return;
          inflight = false;
          write((s) => ({ ...s, loading: false, error }));
        },
      );
    };

    state.onMount = (set) => {
      const reload = () => void load(set, "refresh");
      if (client.connection.state === "open") reload();
      return client.connection.onState((s) => {
        if (s === "open") reload();
      });
    };

    return atom(
      (get) => get(state),
      (_get, set, action: RosterAction) => load((fn) => set(state, fn), action),
    );
  });
}

function feedAtom<T>(feed: Feed<T>): Atom<T> {
  const state = atom(feed.get());
  state.onMount = (set) => {
    const off = feed.subscribe(() => set(feed.get()));
    set(feed.get());
    return off;
  };
  return atom((get) => get(state));
}

export function treeAtom(client: AriaClient): Atom<TreeState> {
  return memo(client, "tree", () => feedAtom(treeFeedOf(client)));
}

export function recentAtom(client: AriaClient): Atom<RecentState> {
  return memo(client, "recent", () => feedAtom(recentFeedOf(client)));
}

export function boundFormAtom(client: AriaClient, aria: string): Atom<BoundFormState> {
  return memo(client, `bound\0${aria}`, () => feedAtom(boundFormFeedOf(client, aria)));
}

export function ariaFactsAtom(client: AriaClient, aria: string): Atom<AriaFacts> {
  return memo(client, `facts\0${aria}`, () => feedAtom(ariaFactsFeedOf(client, aria)));
}
