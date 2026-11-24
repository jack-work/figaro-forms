import type { FormsClient } from "../client.js";
import type { Freshness } from "../replica.js";
import type { JsonObject } from "../json.js";
import type { AriaClient } from "./client.js";
import { errorOf, Feed, feedOf, idle, ReplicaFeed, readyOf } from "./feeds.js";
import { byRecent, moreOf, num, rowsOf, text } from "./rows.js";

export const recentFormID = "@recent";

export interface RecentRow {
  readonly name: string;
  readonly id: string;
  readonly handle: string | undefined;
  readonly title: string;
  readonly state: string;
  readonly cwd: string | undefined;
  readonly activeAt: number | undefined;
}

export interface RecentState {
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly error: string | undefined;
  readonly rows: readonly RecentRow[];
  readonly more: number;
}

export function foldRecent(root: JsonObject): RecentRow[] {
  const rows: (RecentRow & { sortKey: string })[] = [];
  for (const [name, row] of rowsOf(root)) {
    const id = text(row.id);
    if (!id) continue;
    rows.push({
      name,
      id,
      handle: text(row.handle),
      title: text(row.title) ?? text(row.handle) ?? id,
      state: text(row.state) ?? "",
      cwd: text(row.cwd),
      activeAt: num(row.active_at),
      sortKey: id,
    });
  }
  return rows.sort(byRecent).map(({ sortKey: _, ...r }) => r);
}

export function recentFeed(forms: () => FormsClient): Feed<RecentState> {
  return new ReplicaFeed<RecentState>(
    forms,
    recentFormID,
    (r) => ({ ready: readyOf(r), freshness: r.status.freshness, error: errorOf(r), rows: foldRecent(r.root), more: moreOf(r.root) }),
    { ...idle, rows: [], more: 0 },
  );
}

export const recentFeedOf = (client: AriaClient): Feed<RecentState> => feedOf(client, "recent", () => recentFeed(() => client.forms));
