# figaro-forms/aria: the wire contract for a web client

How a page follows one figaro's transcript, as figaro v0.78.0 serves it, and what
`figaro-forms/aria` hands a page in return. The reference for the daemon side is
`api/rpc` (`methods.go`, `read.go`, `turn.go`), `api/livedoc` and `api/aria`
in figaro; the Go client is `sdk/aria`. Everything below was checked against a
v0.78.0 daemon (`npm run test:daemon`, see the end).

## Reaching the door

The same door a `FormsClient` dials: JSON-RPC 2.0, one frame per WebSocket text
message. Behind the edge that is the same-origin `/door` with `edgeSession()`; from
Node, `bearer(token)` or `apiKey(key)`. The first call on a connection is
`angelus.hello {version: 1}`; its answer names the capabilities and the caller's
principal. The client does this on every connect.

An `AriaClient` dials its own connection. `figaro.follow` replaces the channel
set a connection holds on a figaro, so a forms client and an aria client sharing
one connection would silence each other. One connection, one kind of follower.

The local `figaro-forms-bridge` allows only `angelus.hello`, `figaro.follow` and
`figaro.form` (and `figaro.set`, `form.create` with `--write`). It refuses
`figaro.read`, `figaro.qua`, `figaro.interrupt`, `figaro.fork` and `figaro.list`,
so an aria client cannot sit behind it as it stands. A daemon's `[door.web]`
passes them, subject to policy.

## Methods

| method | params | result | verb the caller needs |
|---|---|---|---|
| `figaro.follow` | `{figaro_id, channels: ["transcript"]}` | `{ok, figaro_id}` | listen |
| `figaro.unfollow` | `{figaro_id}` | `{released}` | listen |
| `figaro.read` | `{figaro_id, at?, backward?, limit?, floor?}` | a `Page` | read |
| `figaro.qua` | `{figaro_id, text, images?}` | `{ok, cursor, active?}` | send |
| `figaro.interrupt` | `{figaro_id, queue: "keep" \| "clear"}` | `{ok, stopped?, cleared?, queue?}` | send |
| `figaro.fork` | `{figaro_id, at_turn?, at_lt?, outfits?}` | `{parent, continuation, alternative}` | fork, and use on the figaro's sandbox |
| `figaro.list` | `{global?, limit?, before?}` | `{figaros, next_before?, refused?, refused_why?}` | read, per row |

`channels` is offered when `hello` lists `follow.channels`; without it a follow
carries every channel. `figaro.qua` also follows the figaro it prompts. `qua`'s
`cursor` is the newest turn id at the time, not a transcript cursor. A fork's
new aria is `alternative`; the old id stays as the continuation.

`figaro.list` drops the rows the caller may not read before it pages, and says how
many in `refused`. A page is bounded by `limit`; pass `next_before` as `before`.

### Anchors

An anchor is `{turn, node}`. `read` takes one as `at`. Forward from the zero
anchor is the beginning; backward from the zero anchor is the end. A backward read
excludes `at` itself. `limit` is a byte budget, not a count; omit it for the
daemon's page size. A turn that has no nodes yet (a question with no answer) has
one position, `(turn, 0)`.

The daemon's own node ceiling is 2^64-1, which a JS number cannot hold. A client
never sends one: to ask for "past the last turn" send a large safe turn number.

## Frames

### Page (read result and `figaro.aria` push)

```
Page      { parts: TurnPart[], more: {before?, after?}, next?: Anchor, prev?: Anchor, metrics? }
TurnPart  { turn, from, sealed, inquiry?, inquiry_segments?, at?, lts?, nodes?, live?,
            clipped_head?, clipped_tail? }
Live      { from, v, nodes?: NodeDelta[] }
NodeDelta { id, set?: {field: value}, unset?: [field], patch?: {field: {at, del, ins}} }
```

A pushed frame is a `Page` plus `figaro_id`. `nodes[i]` sits at ordinal `from + i`.
`inquiry` is the question that opened the turn; it is not a node, and an absent
`inquiry` means unchanged, not empty. `inquiry_segments` splits it by sender.

A push is one of five things, told apart by shape:

1. **Question opened**: a part with `inquiry`, `sealed: false`, no nodes, no `live`.
2. **Live delta**: a part with `live.nodes`. `live.v` is the frame version.
3. **Close marker**: a part with `live: {from, v}` and no `live.nodes`, no `nodes`.
4. **Seal**: a part with `sealed: true` and the whole turn's `nodes`.
5. **Snapshot**: what `figaro.read` returns for a turn still open: `nodes` held so
   far plus `live: {from, v}` with no `live.nodes`. A snapshot and a close marker
   have the same shape; the call you made says which one you have.

`NodeDelta.set` merges fields (a node is created by the first `set`, which
carries `type`). `unset` removes fields. `patch` splices a streamed string field
(`markdown`, `output`, `input`) by **UTF-8 byte offsets**, not UTF-16 units, so a
JS client converts before it splices (`spliceBytes`).

### Versions and rounds

`live.v` counts frames within one round of the model: 0, 1, 2, and so on. A tool
turn is several rounds. A round ends with a close marker whose `v` is the last
version sent, and the next round restarts at `v: 0` and re-sends every node of the
turn from `live.from` as full `set` deltas. Rules a client follows:

- `v: 0` starts a round. Apply it, whatever came before. Its deltas are all `set`,
  so applying one twice does no harm.
- `v` at or below the highest applied: a duplicate (a push that overlapped a read).
  Drop it. A `patch` applied twice corrupts text.
- `v` exactly one above: apply.
- `v` more than one above: a frame was missed. Read again.
- A close marker settles the round's nodes if its `v` is the highest applied. If it
  names a later version, frames were missed: read again.
- A seal settles everything in the turn.
- A read snapshot sets the highest applied version to its `live.v`.

A node is settled (immutable) when the close marker or seal says so, or when it
lies below `live.from` in a read. A streamed prose node is therefore settled only at
the end of its round, which in a tool turn can be the end of the turn. Render from
the deltas; use `settled` to know the text is final.

### turn.done and figaro.closed

`turn.done {figaro_id, reason, idle?}` is pushed after the seal. `reason` is a stop
reason (`stop`) or a failure beginning `error` with the daemon's words. `idle:
false` means a queued message starts another turn. It is not replayed by `read`, so
a client that was away learns only that the turn sealed. `figaro.closed {figaro_id}`
says the aria's endpoint closed (kill, drain); the connection stays up.
`door.lapsed {reason, after_ms}` says the connection will be closed by the door's
age limit; reconnect.

## Node kinds and the events they become

`figaro-forms/aria` folds frames into state, and emits the difference between the
state and what it has already told subscribers. Every event carries `aria`, `type`,
`kind` and `cursor`; those about a turn carry `turn`.

| kind | type | when | fields |
|---|---|---|---|
| `input` | `input` | the turn's question is first known | `text`, `segments[{sender?, senderName?, text}]`, `sender?`, `senderName?`, `at?` |
| `prose` | `prose.delta` | text changed | `node`, `text` (all of it so far), `at`, `del`, `ins` (the splice, UTF-16) |
| | `prose.settled` | the node is final | `node`, `text` |
| `thinking` | `thinking.delta`, `thinking.settled` | same as prose | same as prose |
| `steering` | `steering.delta`, `steering.settled` | a message folded into a running turn | same as prose, plus `sender?`, `senderName?` |
| `tool` | `tool.start` | the call first appears | `tool` |
| | `tool.update` | arguments, output or timing changed while running | `tool` |
| | `tool.end` | status is `ok` or `error`, or the node settled | `tool`, `result`, `failed` |
| `unknown` | `unknown.delta`, `unknown.settled` | a node whose `type` is none of the above | `node`, `nodeType`, `text?` (the node's `markdown`, when it has one) |
| `turn` | `turn.end` | `turn.done` with a stop reason, or a sealed turn read after the fact | `reason?`, `idle?`, `replayed` |
| | `turn.error` | `turn.done` with `error...` | `reason`, `idle?` |
| `metrics` | `metrics` | the context and token counters changed | `metrics` |

`tool` is `{node, id?, name?, status: "running" | "ok" | "error", args?, input?,
summary?, output, outputBase, openedAt?, startedAt?, finishedAt?}`. `args` is the
decoded arguments and exists once the whole object parsed; `input` is the raw,
still-growing prefix before that. `output` is the daemon's clipped tail of the
tool's output; `outputBase` says where it starts.

A steering node is a user message folded into a turn the model is still working
on; it arrives at a round boundary, so it is drawn inside the agent's turn. The
turn's opening question is `input`, not steering. `sender` is an aria id or a
caller's label and is absent for a plain terminal or browser caller.

An unknown node is never dropped: the view carries `{kind: "unknown", node, type,
settled, text?}`, so a page can draw a labelled block for a node type a later daemon
adds. A `delta` is sent only while it has text; `settled` is always sent.

Order within a turn: `input`, then nodes by position, then `turn.end` or
`turn.error`. A settled event for an earlier node can follow deltas for a later
one, because settling happens at the round's close. A consumer subscribes to one
kind (`stream.on("prose", fn)`), several, or one type, or iterates
(`for await (const e of stream.events("tool"))`).

What a late attacher gets: for turns already finished, `input`, one
`*.settled` per node (no deltas), `tool.start` then `tool.end` for each call, and
`turn.end` with `replayed: true`. The reason and the error text of an old turn are
not in the transcript, so a replayed end carries none.

## Cursors

A cursor is the string `turn.pos`, for example `12.3`. It names the first position
not yet settled and told: position 0 of a turn is its question, position `n + 1` is
node `n`. So `12.0` means turn 12 has told nothing, `12.1` means the question is
told and node 0 is not final, and `13.0` means turn 12 is complete.

Every event carries the stream's cursor as of that event. Store the cursor of the
last event handled; `attach(id, {cursor})` resumes there:

- settled events (`*.settled`, `tool.end`, `input`, `turn.end`) before the cursor are
  not sent again;
- the node the cursor sits on is sent again from the start (text in full as one
  `delta` with `at: 0`, `del: 0`), because its earlier deltas were never final. A
  consumer replaces what it held for that node;
- a later `delta` always carries the whole text, so a consumer can replace as well
  as splice.

Within one `AriaStream` the state persists across reconnects, so nothing is sent
twice. Across streams (a page reload with a stored cursor) a settled event is
sent at most once and an unsettled node can be sent again; nothing is skipped.

The read that serves a cursor is `figaro.read {at: {turn, node: max(0, pos - 1)}}`
and then each `next` while `more.after`.

## Attach, catch up, follow, reconnect

```
connect -> angelus.hello
        -> figaro.follow {channels: ["transcript"]}      before the read
        -> figaro.read   from the cursor, or backward from the end   (pages)
        -> apply the pushes that arrived meanwhile       version rules above
        -> live
```

Following first means no frame falls in the gap between a read and a follow. Pushes
that arrive during the read are held and applied after it, under the version rules,
so an overlap is dropped and a hole is read again. With no cursor the default is
the tail: one backward read, the last page of history (`from: "start"` reads
forward from the beginning instead). `loadOlder()` reads a page before the oldest
turn held and adds it to the snapshot without events, so a speaker is not handed
old turns.

On any lost connection the state is kept, the phase becomes `offline`, and the
connection retries with backoff. When it opens again the stream repeats the sequence
from its own cursor. A frame gap or a close marker for a version never reached
triggers the same re-read without a reconnect. Phases: `connecting`, `catching-up`,
`live`, `offline`, `refused`, `gone`, `closed`, `detached`.

## Refusals

A refused call comes back as a JSON-RPC error; `ariaRefusal(err)` names it:

| kind | daemon says | meaning |
|---|---|---|
| `denied` | code -32020 | the principal's policy does not grant the verb on that aria |
| `not_found` | message `... aria <id> not found` | no such aria, or one the caller may not read: the daemon words both the same |
| `dormant` | -32042 | the call needs a live agent and the aria is asleep |
| `moved` | -32030 | the aria's tree is moving between nodes |
| `unavailable` | -32041 | a form is momentarily unavailable |

A refused follow or read puts the stream in `refused` (denied) or `gone`
(not_found), with `snapshot().refusal` and a rejected `ready()`. Reading and
listening are separate grants: a read-only principal can attend and cannot prompt.
A fork needs `fork` on the aria and `use` on its sandbox, so a policy that grants
`fork:*` alone refuses it with `none grants use here`.

## Using it

```ts
import { AriaClient } from "figaro-forms/aria";
import { webSocketDial } from "figaro-forms";
import { doorUrl, edgeSession } from "figaro-forms/auth";

const client = new AriaClient({ dial: webSocketDial({ url: doorUrl("/door"), credential: edgeSession() }) });
const stream = client.attach(id, { cursor: saved });
stream.on("prose", (e) => speak(e));
stream.subscribe((e) => (saved = e.cursor));
await stream.ready();
await stream.prompt("ciao");
```

`figaro-forms/aria/react` has `AriaProvider`, `useAria(id)` (a snapshot of turns and
phase), `useAriaEvents(id, filter, handler)`, `useAriaPhase`, `useAriaList` and
`useAriaStream`. `figaro-forms/aria/jotai` has `ariaAtom`, `ariaPhaseAtom`,
`ariaEventAtom` and `ariaListAtom`. `apps/demo` has a page that attends one figaro.

## Running the conformance test

```
cd figaro && git checkout v0.78.0 && go build -o /tmp/figaro078 ./cmd/figaro
cd figaro-forms/packages/figaro-forms
FIGARO_BIN=/tmp/figaro078 npm run test:daemon
```

The run starts the binary with `--angelus` on a temp root: its own config, state,
cache and runtime directories and socket, a fake chat-completions server behind the
`gateway` provider, and a policy binding `user:gluck@edge.test` (read, listen, send,
fork, use) and `user:viewer@edge.test` (read, listen). It never touches the daemon
on your own runtime directory, and it stops what it started.
