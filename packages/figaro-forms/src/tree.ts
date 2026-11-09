import { equal, has, isObject, member, put, type Json, type JsonObject } from "./json.js";
import type { Path } from "./path.js";

export type Listener = () => void;

export function share(prev: Json | undefined, next: Json, at: string[], changed: string[][]): Json {
  if (prev === next) return prev;
  if (isObject(prev) && isObject(next)) {
    const kids: [string, Json][] = [];
    let differs = false;
    for (const k of Object.keys(next)) {
      const before = member(prev, k);
      at.push(k);
      const kid = share(before, next[k] as Json, at, changed);
      at.pop();
      if (before === undefined || kid !== before) differs = true;
      kids.push([k, kid]);
    }
    for (const k of Object.keys(prev)) {
      if (!has(next, k)) {
        changed.push([...at, k]);
        differs = true;
      }
    }
    if (!differs) return prev;
    const built: Record<string, Json> = {};
    for (const [k, v] of kids) put(built, k, v);
    return built;
  }
  if (prev !== undefined && equal(prev, next)) return prev;
  changed.push([...at]);
  return next;
}

interface Node {
  readonly kids: Map<string, Node>;
  readonly listeners: Set<Listener>;
}

const node = (): Node => ({ kids: new Map(), listeners: new Set() });

export class Subscribers {
  private readonly root = node();

  add(path: Path, fn: Listener): () => void {
    let n = this.root;
    for (const seg of path) {
      let k = n.kids.get(seg);
      if (!k) {
        k = node();
        n.kids.set(seg, k);
      }
      n = k;
    }
    n.listeners.add(fn);
    return () => {
      n.listeners.delete(fn);
      this.prune(path);
    };
  }

  private prune(path: Path): void {
    const trail: Node[] = [this.root];
    for (const seg of path) {
      const k = trail[trail.length - 1]?.kids.get(seg);
      if (!k) return;
      trail.push(k);
    }
    for (let i = path.length; i > 0; i--) {
      const n = trail[i] as Node;
      if (n.listeners.size > 0 || n.kids.size > 0) return;
      trail[i - 1]?.kids.delete(path[i - 1] as string);
    }
  }

  affected(changed: readonly (readonly string[])[]): Set<Listener> {
    const out = new Set<Listener>();
    const below = (n: Node): void => {
      for (const fn of n.listeners) out.add(fn);
      for (const k of n.kids.values()) below(k);
    };
    for (const path of changed) {
      let n: Node | undefined = this.root;
      for (const seg of path) {
        for (const fn of n.listeners) out.add(fn);
        n = n.kids.get(seg);
        if (!n) break;
      }
      if (n) below(n);
    }
    return out;
  }

  get size(): number {
    let count = 0;
    const walk = (n: Node): void => {
      count += n.listeners.size;
      for (const k of n.kids.values()) walk(k);
    };
    walk(this.root);
    return count;
  }
}

export class Tree {
  private value: JsonObject;
  private readonly subs = new Subscribers();

  constructor(initial: JsonObject = {}) {
    this.value = initial;
  }

  get root(): JsonObject {
    return this.value;
  }

  subscribe(path: Path, fn: Listener): () => void {
    return this.subs.add(path, fn);
  }

  replace(next: JsonObject): readonly (readonly string[])[] {
    const changed: string[][] = [];
    const shared = share(this.value, next, [], changed);
    if (shared === this.value) return [];
    this.value = shared as JsonObject;
    for (const fn of this.subs.affected(changed)) fn();
    return changed;
  }

  get listeners(): number {
    return this.subs.size;
  }
}
