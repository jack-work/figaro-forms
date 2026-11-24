# Architecture

How `packages/figaro-forms` is laid out and why. Wire contracts live in
[aria.md](aria.md), [comments.md](comments.md) and [gateway.md](gateway.md);
this page is the map between them and the source.

## Layers

Imports point down the list. Nothing in a lower layer knows a higher one exists.

1. JSON and patches. `json.ts` (the `Json` type, `equal`, `canonical`),
   `path.ts` (dotted paths, resolved against keys that themselves contain
   dots), `patch.ts` (the daemon's patch algebra: `apply`, `inverse`,
   `tryMerge`, `setAt`, `deleteAt`, `touchedKeys`), `tree.ts` (structural
   sharing and path-scoped subscriptions). `patch.ts` mirrors the Go
   implementation; `conformance/` generates the vectors in `test/vectors`
   from it, and the TypeScript is correct when those pass.
2. Transport. `rpc.ts` is one JSON-RPC connection over an injected `Dial`,
   with reconnect and backoff. `link.ts` is the base of both clients: it owns
   the connection options, the hello and capability check, the reconnect on
   `door.lapsed` and the state fan-out. `wire.ts` is the form protocol,
   `websocket.ts` the only `Dial`, `auth/` the credentials and endpoint URLs,
   `access.ts` the client-side copy of the daemon's refusal rules.
3. Form state. `replica.ts` is one form, `client.ts` (`FormsClient`) is one
   connection plus a map of replicas held in a `registry.ts` `Registry`, the
   peek, retain, release and delayed-reap refcount that `AriaClient` also uses
   for its shared streams.
4. Pure readers of a form. `view/` flattens a form into rows, `semantics/`
   holds the well-known form ids and key catalog, `hierarchy/` projects the
   role forms for the bridge and polls them for the page, `commands*.ts` and
   `glyphs*.ts` are the command and glyph catalogs.
5. Bindings. `react/` and `jotai/` for forms, `aria/react.ts` and
   `aria/jotai.ts` for arias. They adapt a store to `useSyncExternalStore`
   or an atom and add no state of their own; `react/shared.ts` and
   `jotai/shared.ts` hold the one subscribe-and-hold hook and the one
   retained ticker atom both layers use.
6. Arias, in `aria/`. `client.ts` (`AriaClient`) owns a connection for the
   transcript protocol and builds a `FormsClient` on the same dial when a feed
   needs a form. `stream.ts` attaches to one aria, catches up and follows.
   `fold.ts` turns pages and live deltas into messages, over the interval
   store in `store.ts`. `surface.ts` and `queue.ts` fold the `@arias`,
   `@recent`, bound and queue forms into feeds. `comments.ts` and `quote.ts`
   are transcript comments and the coordinate grammar they use.

`packages/bridge` is a Node program, not a library. `bridge.ts` serves the
form protocol to the page, `gateway.ts` the transcript protocol for the chat web, and the remaining
files are what the gateway routes to: speech, dictation, attachments,
token handover, tracing and metrics.

## Entry points

`package.json` `exports` lists them. Each is one directory or file above:
`.` (layers 1 to 3), `auth`, `view`, `semantics`, `hierarchy`, `commands`,
`catalog` (the slim command doc the web needs), `glyphs`, `react`, `jotai`,
`aria`, `aria/react`, `aria/jotai`. A name that is exported from its module
but not from an entry point is internal and exists for the tests.

## The generation contract

A `Connection` bumps a generation number every time its socket changes. Each
notification handler receives the generation it arrived on, and anything that
acts on it (a replica applying a delta, a stream applying a page) compares it
with the current one first and drops it on mismatch. This is the whole defence
against a late frame from a dead socket. When a socket opens, every replica
and stream is told to begin the new generation and resync; when it closes,
they are marked stale and keep their last value.

## How an edit travels

A replica holds `confirmed` (what the daemon last said), `pending` (edits
sent or waiting, each with a sequence number) and `draft` (edits merged
locally and not yet queued). What `get` and `subscribe` see is `confirmed`
with `pending` and `draft` applied over it.

1. `set` or `unset` builds a patch against the visible tree, refuses it
   locally if `access` denies a touched key, and merges it into `draft` when
   `tryMerge` can.
2. After the debounce, the draft becomes a pending edit with the next
   sequence number. One edit is in flight at a time.
3. The daemon answers, then broadcasts a `form.delta` carrying the client id
   and sequence number. The delta, not the answer, moves `confirmed`, and it
   settles every pending edit up to that sequence. An answer that is ahead of
   the version the replica has seen starts a timer; if the delta does not
   arrive, the replica reloads.
4. A delta with a version gap, a newer incarnation, or an unknown schema
   forces a reload or marks the form incompatible. A reload replaces
   `confirmed`, renumbers or settles pending edits using the daemon's
   `last_seq`, and replays any deltas that arrived while it was loading.

An edit's promise resolves with the daemon's version when it settles, or with
a `Refusal` when it is denied, the form closes, or the form is unavailable.

## Where names come from

Form-protocol methods and every daemon error code (`errDenied`, `errMoved`,
`errFormUnavailable`, `errDormant`) are in `wire.ts`. Transcript-protocol
methods are in `aria/wire.ts` (`ariaMethod`), which reuses `method` for the
four names both protocols share (`follow`, `unfollow`, `closed`, `list`).
The replica checks `errDenied` and `errFormUnavailable`; `aria/errors.ts`
classifies all four codes into refusal kinds. `figaro.list` has one row type,
`AriaRow`, used by both the aria list and the hierarchy projection.
`commands.gen.ts`, `commands-slim.gen.ts`, `glyphs.gen.ts` and
`semantics/known-keys.gen.ts` are generated by `conformance` from figaro's own
packages; `go run . -check` in `conformance/` fails when one is stale.
