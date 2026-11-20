# figaro-forms/aria: figaro's UI IR for a web client

The wire `figaro-forms/aria` carries is figaro's **UI IR** (ARCHITECTURE.md, "UI
IR" under Streaming), the turn-shaped projection of a transcript that the pager
consumes: `figaro.aria` pages of turn parts and livedoc nodes. The library adds
no vocabulary of its own. Types keep the daemon's names and fields; the fold is
the pager's fold (`sdk/aria` `Client` and `Store`) ported to TypeScript and held
to it by fixtures recorded from a Go run. The Go references, at figaro v0.78.1:
`api/rpc` (`methods.go`, `read.go`), `api/livedoc` (`node.go`, `livedoc.go`),
`api/aria` (`types.go`), `sdk/aria` (`client.go`, `store.go`). Checked against a
v0.78.1 daemon (`npm run test:daemon`, see the end).

## Go type to TypeScript type

| Go | TypeScript (`figaro-forms/aria`) | notes |
|---|---|---|
| `aria.Page` | `Page` | pull (`figaro.read` result) and push (`figaro.aria`, plus `figaro_id`: `AriaFrame`) |
| `aria.TurnPart` (embeds `aria.Turn`) | `TurnPart` (extends `Turn`) | `nodes[i]` is node `from + i` |
| `aria.Live`, `aria.NodeDelta` | `Live`, `NodeDelta` | `id` is the positional ordinal |
| `livedoc.Delta` | `Delta` | `at`, `del` are UTF-8 **byte** offsets |
| `livedoc.Node` | `Node` | `type`: `prose`, `thinking`, `tool`, `steering`; any other string is kept |
| `livedoc.FormDelta`, `livedoc.Src` | `FormDelta`, `Src` | |
| `aria.InquirySegment`, `aria.Metrics`, `aria.More`, `aria.Anchor` | same names | |
| `rpc.DoneEntry` | `DoneEntry` (`TurnDone` adds `figaro_id`) | the `turn.done` notification |
| `rpc.ReadRequest` | `ReadRequest` | `at`, `backward`, `limit` (bytes), `floor` |
| `aria.Message` | `Message` | client-side, not a wire type: `turn`, `from`, `inquiry`, `inquirySegments`, `inquiryLT`, `formDeltas`, `role`, `nodes` |
| `sdk/aria.Client` | `Transcript` | `apply(page)`, `view()`, `cursor()`, `query`, `ensure` |
| `sdk/aria.Store` | `Store` | ranges, holes, the open tail |
| `Client.OnClosed/OnLive/OnDesync/OnMetrics` | `Transcript.hooks`, `AppliedFrame` | see "What a subscriber is told" |

Fields are named as the daemon writes them: `inquiry_segments`, `sender_name`,
`tool_call_id`, `output_base`, `opened_at`, `clipped_head`, `formDeltas`. Only the
client-side `Message` and `Transcript` use camelCase, as the Go fields they mirror
have no wire names.

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

- `v: 0` starts a round. Its deltas are all `set`, so applying one twice does no
  harm.
- a delta whose `v` a read already covered is a repeat from an overlap (a push that
  raced the read). Applying a `patch` twice corrupts text, so the stream drops it.
- a close marker names the last version sent. If it is not the highest delta
  version applied, frames were missed: read again (the fold reports `desync`).
- a seal carries the whole turn.
- a read snapshot of an open turn carries `live.v`, the version it covers.

The fold does not track a per-node settled flag. A node is closed when a seal
delivers it or it lies below `live.from`; until then it is in the open message
(see "The fold"). A streamed prose node therefore stays open to the end of its
round, which in a tool turn can be the end of the turn. Render from the deltas.

### turn.done and figaro.closed

`turn.done {figaro_id, reason, idle?}` is pushed after the seal. `reason` is a stop
reason (`stop`), `interrupted` after `figaro.interrupt` (`internal/figaro/turn.go`,
`endTurn("interrupted")`, committed and sealed like any turn), or a failure
beginning `error` with the daemon's words. `idle: false` means a queued message
starts another turn. `rpc.DoneEntry` carries no turn number. See "Which turn ended"
for how the library supplies it. `figaro.closed {figaro_id}`
says the aria's endpoint closed (kill, drain); the connection stays up.
`door.lapsed {reason, after_ms}` says the connection will be closed by the door's
age limit; reconnect.

## The fold: messages, the open tail, the cursor

`Transcript.apply(page)` is `sdk/aria` `Client.Apply`. It turns pages into
**messages**: `Message {turn, from, inquiry?, inquirySegments?, inquiryLT?,
formDeltas?, role, nodes}`.

- A message is one slice of a turn's nodes: `nodes[i]` is node `from + i`. The
  question rides only the slice that starts the turn (`from === 0`). A turn with
  output is one `role: "output"` message at `from 0` holding the inquiry and the
  first nodes (there is no separate input slice); a turn that has a question and no
  nodes yet is a `role: "input"` message with `nodes: []`. A user's steering
  interjection is an ordinary node (`type: "steering"`, `role: "input"`) inside a
  slice.
- A turn past 40000 bytes of text splits into several output messages (`appendUnits`
  in `client.go`); later slices carry no inquiry. A node is never split.
- **closed** messages are immutable: the nodes a seal delivered, and the nodes
  below `Live.From` (released while the turn is still open, which is how a steer
  splits a run). They are held in the `Store`: ranges sorted by `From`,
  non-overlapping and never adjacent (`store.go`), so `view().closed` is always
  ascending by `(turn, from)`. Pages sorted the same way is a wire invariant
  (`api/aria/types.go`, `Page.Parts`).
- the **open** message (`view().open`) is the one mutable suffix of the turn in
  flight, from `max(Live.From, released, held)` to the last node. It comes after
  every closed slice of its turn. On a sealed part the fold drops it
  (`client.go`, `fold`: `if c.store.OpenTurn() == id { c.store.ResetOpen() }`), so
  `view().open === undefined` means no turn is running. It does not mean every
  message is final in an aria that still shows an open one.
- a node is **running** while it sits in the open message: a prose node streams in
  place; a `tool` node moves `status` from `running` to `ok` or `error` and gains
  `args`, `output`, `finished_at`. Render from `node.type` and `node.status`.

Version handling follows the Go client: deltas are applied in the order they
arrive, a `set` repeats harmlessly, a close marker whose `v` is not the highest
delta version applied means frames were missed, and the fold reports `desync`
(the highest sealed turn) so the stream reads again from there. One thing the Go
client does not do, and the stream does: a pushed delta whose `v` is at or below
the version a read already covered (and is not `0`, which starts a round) is
dropped before the fold, because a `patch` applied twice corrupts text.

Holes are first class. `transcript.query(from, to)` returns segments of messages
with a `gap` after each run where the store holds nothing; `ensure(from, to)`
fetches (a backward `figaro.read` before the first missing anchor, 30 messages at a
time at 4096 bytes each, as the pager's history fetcher) until none remain and
throws `StalledError` if a fetch does not shrink the hole. `evictBefore`,
`cloneBelow`, `setClosedLimit`, `tailFrom`, `skip` and `before` are the Go methods
of the same names. The node ceiling `2^64-1` is `Number.MAX_SAFE_INTEGER` here.

The **cursor** is the highest sealed turn (`Client.Cursor`). `attach(id, {cursor})`
resumes with a forward read from that turn; the turn is read again and the store
drops what it holds.

### What a subscriber is told

`stream.onFrame(fn)` hands over an `AppliedFrame` for every page applied:

| field | meaning |
|---|---|
| `source` | `"read"` (catch-up) or `"push"` (a `figaro.aria` notification) |
| `frame` | the `Page`, verbatim |
| `closed` | the messages this page closed, oldest first (`OnClosed`) |
| `open` | the open message after the page, if a turn is open (`OnLive`) |
| `nodes` | the nodes the page touched, after folding: `{turn, id, node, delta?}`, `delta` being the native `NodeDelta` for a live frame |
| `sealed` | turn ids this page sealed for the first time |
| `desync` | set when the fold wants a re-read (`OnDesync`); the stream already does it |
| `metrics` | the page's `Metrics` (`OnMetrics`) |

`snapshot()` is `{aria, view: {closed, open}, metrics, done, ends, phase, refusal,
error, cursor, olderAvailable}`. `loadOlder()` and `ensure()` fold quietly: no
`onFrame` for history. A consumer that speaks or logs output listens to `onFrame`
and reads `nodes` where `node.type === "prose"` and `node.role === "output"`.

### Which turn ended

`turn.done` carries no turn. The daemon pushes it right after it seals the turn
(`internal/figaro/agent.go`, `finishTurn`: `Seal`, then `turn.done`), on the same
connection, so the turn it ends is the one just sealed. `stream.onTurnEnd(fn)` gives
`{turn, replayed, done?}`:

- live: `{turn, replayed: false, done: {reason, idle?}}` at `turn.done`, with the
  turn from the seal that preceded it. `reason` is `stop`, `interrupted`, or
  `error: ...`.
- replayed: `{turn, replayed: true}` with no `done`, whenever a read (catch-up, or
  after a reconnect that missed it) shows a turn sealed that the stream had not seen
  end. The daemon does not record how a turn ended: `turn.done` is only pushed, and
  `figaro.read` returns no reason, so an old turn's interrupted or failed ending is
  not recoverable (figaro#200). The turn number is exposed regardless.

Each turn is told once. `onDone(fn)` is the bare `DoneEntry`, live only, and
`snapshot().ends` lists what has been told.

## Attach, catch up, follow, reconnect

```
connect -> angelus.hello
        -> figaro.follow {channels: ["transcript"]}      before the read
        -> figaro.read   forward from the cursor turn, or backward from the end (pages)
        -> apply the pushes that arrived meanwhile       repeats dropped
        -> live
```

Following first means no frame falls in the gap between a read and a follow. Pushes
that arrive during the read are held and applied after it; an overlap is dropped
and a hole is read again. With no cursor the default is the tail: one backward
read, the last page of history, and `more.before` says whether older turns exist
(`from: "start"` reads forward from the beginning instead). `loadOlder()` reads a
page before the oldest message held and folds it without `onFrame`, so a speaker
is not handed old turns.

Attaching to a turn already running starts from the snapshot the read returns:
the open message holds the nodes so far, and everything after it arrives as
deltas. Nothing earlier in that turn is replayed as a delta.

On any lost connection the state is kept, the phase becomes `offline`, and the
connection retries with backoff. When it opens again the stream reads forward from
its cursor turn and folds the result into what it holds. A close marker for a
version never reached triggers the same re-read without a reconnect. Phases: `connecting`, `catching-up`,
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
const stream = client.attach(id);
stream.onFrame(({ nodes }) => nodes.forEach(({ turn, id, node }) => render(turn, id, node)));
stream.onTurnEnd((end) => finish(end.turn, end.done?.reason));
await stream.ready();
await stream.qua("ciao");
const { closed, open } = stream.snapshot().view;
```

`figaro-forms/aria/react` has `AriaProvider`, `useAria(id)` (the snapshot),
`useAriaFrames(id, handler)`, `useAriaPhase`, `useAriaList` and `useAriaStream`.
`figaro-forms/aria/jotai` has `ariaAtom`, `ariaPhaseAtom`, `ariaFrameAtom` and
`ariaListAtom`. `apps/demo` has a page that attends one figaro and renders each
node by its native `type`.

## Running the tests

`npm test` replays fixtures recorded from `sdk/aria` v0.78.1 through the
TypeScript store (`test/aria/fixtures`, from the tapes in `test/aria/tapes`) and
compares closed messages, the open message, desync, metrics, query segments and
counters step by step. They are checked in because the nix build has no Go.
Regenerate with `npm run aria-fixtures` (needs Go and the figaro module); add a
tape and rerun.

```
cd figaro && git checkout v0.78.1 && go build -o /tmp/figaro0781 ./cmd/figaro
cd figaro-forms/packages/figaro-forms
FIGARO_BIN=/tmp/figaro0781 npm run test:daemon
```

The daemon run starts the binary with `--angelus` on a temp root: its own config,
state, cache and runtime directories and socket, a fake chat-completions server
behind the `gateway` provider, and a policy binding `user:gluck@edge.test` (read,
listen, send, fork, use) and `user:viewer@edge.test` (read, listen). It never
touches the daemon on your own runtime directory, and it stops what it started.
