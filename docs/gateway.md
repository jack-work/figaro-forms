# figaro-gateway

The `figaro-gateway` binary (packages/bridge) fronts gluck's figaro door for the
figaro web client and adds voice, and nothing else: speech out (it tees a followed
aria's spoken prose into figchat-speech) and transcription in (`POST /stt`). The
conversation itself is figaro's UI IR, native and untouched: `/door` is a raw
passthrough of the door's JSON-RPC, so a page folds the same `figaro.aria` frames
the pager does with `figaro-forms/aria` (docs/aria.md). It sits behind the edge:
every request needs the edge secret in `X-Figaro-Edge` and the admin in
`Remote-User`.

## Routes

- `/door` (WebSocket): JSON-RPC to the door, one upstream connection per client.
  Allowed: `angelus.hello`, `angelus.outfits`, `figaro.follow`, `figaro.unfollow`,
  `figaro.form`, `figaro.read`, `figaro.qua`, `figaro.interrupt`, `figaro.fork`,
  `figaro.list`, `figaro.create`, `figaro.set`.
  Everything else (form.create, kill) is refused. `figaro.qua` may carry only
  `figaro_id`, `text`, `images`, `traceparent` (W3C only, else refused), `attachments` and
  `dictation` (an `audio_id`, else refused; the gateway keeps it), `figaro.fork` only `figaro_id`, `at_turn` and
  `at_lt`, `figaro.create` only `outfits` (no patch, no cwd), `angelus.outfits` only
  `spec`, and `figaro.set` only `figaro_id`, `patch`, `client` and `seq`: any other
  field (`form` with its patch, context or outfits on a qua; a fork's
  `patch`, `outfits`, `seat`, `studies`, `abdicates`; a set's `outfits`, `assert`,
  `if_version`) is refused with an error naming
  it, never dropped silently. A `figaro.interrupt` also cancels pending audio for
  that aria. A message (however the browser fragments it) is limited to 1 MiB
  (`maxFrameBytes`): one over it is answered with a JSON-RPC error naming the limit
  and its size, for the request's id when its first 256 bytes show one, and the
  socket stays open; past 8 MiB (or 8 times the limit) the socket closes with 1009.
  Images go through `POST /attach`. A door connection that fails a send closes the
  page's socket with 1011 instead of taking the gateway down. A failure to
  reach the door closes the socket with a fixed reason; the detail goes to the
  gateway's log with the query and userinfo removed.
- `/audio/<aria>` or `/audio/<store>/<aria>` (WebSocket, aria is the 32-hex id; a
  store the gateway does not serve is answered with an `error` frame, code `store`,
  and the socket closes): follows the aria server-side
  with `figaro-forms/aria` (the native store: `onFrame` and `onTurnEnd`), one follow
  and one speech session per reply however many sockets listen. It speaks the
  output-role prose nodes (`node.type === "prose"`, `node.role === "output"`) of
  the frames it is told. Its frames are the gateway's own side channel, not UI IR.
- `GET /audio/key/<store>/<aria>:<turn>/<in|out>`: replay, passed to the speech socket
  with `Range`. `out` is a reply's speech; `in` is the message's own dictation. Only
  keys of the gateway's own store (404 otherwise); an unparsable target or escape
  answers 400. A streamed dictation (`/stt/stream`) is stored before its turn exists,
  so the gateway keys it: after the stream's `done` it remembers the clip for that
  session and aria (10 minutes). A `figaro.qua` from the same session that sends the
  dictated text names the clip with `dictation: <audio_id>`; when a turn opens whose
  inquiry (or one sender's segment of it) is that text, with any folded PDF text after
  it, the gateway keys the clip `<store>/<aria>:<turn>/in` (speech's
  `POST /audio/<id>/key`), logging `dictation keyed audio_id= key= session=`. A typed
  qua, or one sent as steering, keys nothing.
- `POST /stt?aria=<store>/<aria>`: dictation. See below.
- `POST /stt/key/<store>/<aria>:<turn>/in`: re-transcribe a stored clip. See below.
- `/stt/stream?aria=<store>/<aria>&lang=<bcp47>` (WebSocket): live dictation. See below.
- Anything else goes to `GatewayOptions.routes` (HTTP) or `GatewayOptions.sockets`
  (upgrades), else 404. `figaro-gateway` mounts `stt({socket, store})` on both.

## POST /stt

Body is the browser's recording, with its own `Content-Type`: `audio/webm`
(`codecs=opus` allowed) or `audio/mp4`. At most 10 MB, and the first bytes must be
those of the type claimed (EBML for webm, `ftyp` for mp4). At most 4 clips are in
flight at once (`503` beyond). The gateway passes the clip to figchat-speech, with
the bare media type as its `Content-Type`, `POST /stt` on the speech socket and answers:

- `200 {"text", "duration_ms", "audio_id"}`. `audio_id` names the stored clip in
  figchat-speech (`POST /stt/<audio_id>` there re-transcribes it).
- `400 {"error"}`: `aria` is missing, malformed, or names another store; or the body is empty.
- `405` for anything but POST.
- `413 {"error"}`: over 10 MB. A declared `Content-Length` over the limit is refused
  unread; otherwise reading stops at the limit and the connection closes.
- `415 {"error"}`: any other type (`audio/ogg` included), refused before the body is read, or a body that is not the type it claims.
- `503 {"error"}`: too many clips in flight.
- `502 {"error"}`: speech is unreachable, answers non-200 (its error text is passed on),
  or answers without `text`, `duration_ms` and `audio_id`.

`aria` is checked and not forwarded: a clip usually precedes its turn, so it has no
audio key yet. The text belongs in the composer; sending it is an ordinary prompt.

## POST /stt/key/<key>

Re-runs speech-to-text on a clip figchat-speech already holds, named by its turn key
`<store>/<aria>:<turn>/in` (plain or URL-encoded). The gateway looks the key up
(`POST /audio/keys`) and asks for `POST /stt/<audio_id>`; no body. Answers in
`/stt`'s shape, `200 {"text", "duration_ms", "audio_id"}`, or:

- `400 {"error"}`: not a clip key (`/out` included), or another store's.
- `404 {"error"}`: no clip under that key.
- `405` for anything but POST.
- `409 {"error"}`: speech holds a reply under it, not a clip.
- `503 {"error"}`: too many clips in flight (shared with `/stt`).
- `502 {"error"}`: speech unreachable or answering anything else.

## /stt/stream

Live dictation: words reach the composer while Gluck speaks. The gateway checks
`aria` as `POST /stt` does (not forwarded) and `lang` (default `en-US`, pattern
`^[a-z]{2,3}(-[A-Z]{2})?$`), takes one of the clips-in-flight slots shared with
`POST /stt`, and opens figchat-speech's WS `/stt/stream?lang=` on the speech socket.
Speech's frames pass through verbatim; the gateway adds only its own errors.

Client to server: binary frames of PCM s16le, 16 kHz, mono (an AudioWorklet; not
MediaRecorder), each 2 to 6400 bytes and even. Text frames are JSON:
`{"type":"end"}` (no more audio: finish, store, answer `done`) or
`{"type":"cancel"}` (abort, nothing stored, close 1000 without `done`).

Server to client, text (JSON):

- `{type:"ready"}`: recognition is open. Audio sent before it is held, at most 2 s
  (64000 bytes); past that, `unreachable`.
- `{type:"partial", text, offset_ms}`: the current phrase so far; replaces the last
  partial with the same `offset_ms`.
- `{type:"final", text, offset_ms, duration_ms}`: a settled phrase; append it, drop
  the partial. Finals come in offset order; a partial never follows its final.
- `{type:"done", audio_id, duration_ms, text}`: after `end`; `text` is the finals
  joined by single spaces; `audio_id` names the stored clip (WAV), which
  `POST /stt/key` re-transcribes once keyed (`POST /audio/<id>/key` on speech).
  Then close 1000.
- `{type:"error", code, text}`, then close 1011 (1008 for `bad-request`). Codes:
  `bad-request` (aria, lang, or a frame of the wrong shape; query faults are refused
  before speech is dialed), `busy` (no slot), `idle` (no audio for 10 s),
  `too-long` (over 5 minutes or 9.6 MB), `speech` (recognition failed, or speech
  closed early), `unreachable` (speech socket down, or not ready within 2 s of audio).

A client that drops mid-stream cancels recognition upstream.

## /audio frames

Server to client, text (JSON):

- `{type:"ready", aria, store}` once the follow is live. Finished turns are never
  spoken. A turn already running when the follow starts is spoken **from the join
  point on**: the text its open message holds at that moment counts as heard, and
  what arrives after it is spoken (a sentence cut in half by the join is spoken
  from its second half). The aria's speech outlives its last listener by 15 s: a
  page that reloads within that time joins the same reply, gets its own
  `audio.start` at the current position and hears nothing again, and the reply is
  still stored whole under its key. After that, a returning page starts a fresh
  follow, spoken from the join point as above. A turn that starts after the
  follow is spoken whole. After a
  reconnect the stream re-reads the running turn and the gateway speaks what it
  gained while offline, once; a turn that ended while offline is spoken from where
  it had got to.
- `{type:"audio.start", turn, key, partial?, format:"pcm", rate:24000, bits:16, channels:1, node, chars, cursor}`;
  `partial:true` when the follow joined the turn after it had begun.
- `{type:"audio.chunk", turn, node, chars, cursor, offset, bytes}` followed at once
  by one binary frame of `bytes` PCM (s16le, even length). The tags are native
  coordinates: `turn` is the turn id, `node` the ordinal of the prose node
  (`from + i` in the UI IR) and `chars` the number of UTF-16 units of that node's
  `markdown` the speech service had been fed when this audio arrived; `cursor` is
  the stream's cursor (the highest sealed turn, `Client.Cursor`) at that moment. The
  audio is at or after that point in the text, never before. `offset` is the byte
  position in this audio of the turn (it starts at 0 on every audio.start); place and
  deduplicate audio by `node` and `chars`, not by `offset`. A listener that joins
  while a reply plays gets its own `audio.start` before its first chunk; `audio.end`
  and `audio.cancel` after audio started go only to listeners that got a start.
- `{type:"audio.end", turn, key, partial?, audio_id?}` after the last chunk. `key` is
  always present: the A9 key `<store>/<aria>:<turn>/out`. A whole turn is stored
  under it and replayable at `/audio/key/<key>`, with `audio_id` when the speech
  service reports one. A `partial` turn (joined after it began) is not stored: its
  key answers 404 until something speaks the whole turn; ask with `say`.
- `{type:"audio.cancel", turn, key, why}`; `why` is `new-turn`, `interrupt` or
  `client`. No `audio.end` follows.
- `{type:"error", turn?, code, text}`: `code` is `speech` (that turn's audio is over),
  or on attach `aria_gone`, `denied`, `unavailable`, or `store` for a store this
  gateway does not serve, after which the socket closes.

Client to server:

- `{type:"cancel"}` stops the aria's pending speech for everyone, and this socket's
  running say.
- `{type:"say", turn:N}` (N a positive integer) speaks a finished turn again, to
  this socket only. The gateway reads the turn from the door, speaks the same prose
  nodes the live path does (same voice, filtering and chunking) and stores it under
  the live key `<store>/<aria>:<N>/out`, so `/audio/key/<key>` replays it afterwards.
  The asker gets `audio.start` (with `say:true`), `audio.chunk` and binary PCM, then
  `audio.end`; other sockets on the aria hear nothing. If speech already holds
  audio under the key the gateway does not synthesize and answers
  `{type:"audio.stored", turn, key}`: fetch `/audio/key/<key>`. One say at a time
  per socket. A live turn starting does not cancel a say; `cancel` or closing the
  socket does (`{type:"audio.cancel", turn, key, why:"client", ...}` goes to the
  asker on `cancel`). Refusals are `{type:"error", turn, code, text}` with `turn`
  echoing the request: `bad-turn` (not a positive integer, or no such turn),
  `open` (still running: live audio covers it), `silent` (no output prose), `busy`
  (a say is already running on this socket), `speech` (synthesis failed), `door`
  (the turn could not be read).

Prose is fed to speech from the first sentence (a terminator followed by space, a
newline, or 160 characters), not when a node closes. Thinking, tools, steering
(role `input`) and the question are never spoken. A turn's end comes from the
daemon's `turn.done`: `interrupted` cancels the audio (`why: "interrupt"`), any
other end finishes it. Markdown stripping is the speech service's.

## Log

Each `/audio` connection writes to stderr (the journal), never a token or query
string: `audio: connect aria= user=` (and `store=` when the client named one),
`audio: dialing the door`, `audio: follow ready` or `audio: follow failed code=
text=` with the refusal verbatim, `turn seen`, `tts open`, `tts done` / `tts error`
/ `turn cancelled` with chunk and byte counts (a say logs `say seen`, `say aria= turn=
chunks= bytes=`, `say stored`, `say refused ... code=`, `say failed code=speech`), and `audio: closed code= reason=
json= binary=` with the frame counts sent.

Each `/door` socket logs one line per call it passes to the door, `door: call
method= aria= session=`, with no params; the door's pushes (`figaro.aria`,
`form.delta`, `turn.done`) are not logged. Each HTTP request behind the gate logs
`http <method> <path> <status> <ms> ms session=`.

## Metrics

With `--otlp-endpoint URL` the gateway also posts metrics to `URL/v1/metrics` every
10 s (OTLP/HTTP JSON, delta temporality), named and shaped as the shared figchat
table says (captains-log 2026/11/21/figchat-metrics-table.md): durations in ms as
histograms with bounds 5 to 30000, counts as monotonic sums, attributes only
`figchat.session`, `figaro.aria`, `kind`, `outcome`.

- `figchat.gateway.door.dial_ms` (kind page, audio, handover; outcome)
- `figchat.gateway.door.first_frame_ms`: page socket open to its first frame
- `figchat.gateway.turn.first_token_ms`: a page's qua to the first frame carrying
  output for that aria
- `figchat.gateway.handover_ms` (kind between_turns, deadline, lapse_notice)
- `figchat.gateway.audio.first_byte_ms`: turn seen to its first PCM
- `figchat.gateway.reconnects` (kind door, audio): a session's socket opened again
- `figchat.gateway.errors` (kind door_closed, refused, speech, handover)

## Faults (test mode)

`--fault-socket PATH` turns on test mode: the gateway takes fault ops as one JSON
object per line on PATH (mode 0600) and answers each with one line. It refuses to
start unless it listens on loopback `--port` with loopback peers only, so the
production shape (a unix socket behind the edge) cannot be put in test mode, and
it logs `faults armed on PATH: this gateway is in test mode`. Without the flag
nothing is wrapped.

- `{"op":"door.lapse","notice":true}`: end the live door legs now (with `door.lapsed`
  first when `notice`), as gluck's door does at bearer expiry; `leg`, `ms` (after).
- `{"op":"door.bearer","ms":3000}`: every new door leg lapses ms after it opens and
  the gateway is told so, so handovers come every ms; `"ms":null` ends it.
- `{"op":"door.drop"|"door.delay", ...}` and `{"op":"page.drop"|"page.delay", ...}`:
  frames from the door, or to the page, matching `method` (or audio `type`),
  `reply` ("page", "gateway" or an id), `leg` ("first"/"later"), `notify`; delay
  takes `ms`.
- `{"op":"door.stall","ms":M}`: the next door dials wait M ms.
- `{"op":"page.close","code":1011}`: close page sockets (1006 terminates).
- `{"op":"speech.stall","ms":M}`, `{"op":"speech.fail"}`: hold or fail the next
  speech calls (TTS, dictation, streaming dictation).
- `{"op":"clear"}`, `{"op":"state"}`.

Every op takes `session` (a figchat session id) or `audio` (true for the audio
follow) to scope it, and `count` to end it after that many hits (default: until
`clear`).

`npm run test:load` in packages/bridge runs a load test through `/door` against a
fake door (LOAD_FIGAROS, LOAD_TURNS, LOAD_DELTAS, LOAD_PAGES; LOAD_DEFLATE=0 for plain sockets).

## Door handover

gluck's door closes a connection when the bearer it was admitted with expires
("the bearer expired: reconnect with a fresh token"). With a minted bearer
(`--token-url`) the gateway hides that from the page and from the audio follow:
each door leg knows its bearer's expiry, and before it the gateway opens a new leg
with a bearer that outlasts it, follows on it every aria and form the old leg
followed (and every aria a `figaro.qua` followed), then switches.

- When: from expiry minus a quarter of the bearer's life (2 s to 60 s) it waits for
  a quiet moment (no open turn, no request waiting, no frame for 500 ms) and moves
  between turns; at expiry minus 8 percent (1 s to 10 s) it moves anyway, mid-turn.
  A `door.lapsed` notice it did not expect moves at once and is never passed on.
- Nothing lost or doubled: from the moment it follows on the new leg until the
  switch, both legs deliver; the page gets the old leg's frames and the new leg's
  are held. It switches once the old leg has delivered the new leg's first frame
  (or 200 ms pass with none, 2 s at most), so nothing fanned out before the new
  follow is still in flight on the old leg. The new leg's frames, held and later,
  are then matched in order against what the old leg delivered (the daemon sends
  every follower the same bytes; every position a frame could anchor at is kept
  until later frames rule it out), and only the rest are passed on.
- A follow, unfollow or qua answered on one leg while another exists is repeated
  on the other, so a request in flight across the switch leaves both legs agreeing.
- Requests already sent on the old leg are answered from it; the old leg closes
  once they are and the overlap is matched (2 s at most when no frame comes). If
  it closes first, each unanswered request gets a JSON-RPC error, never silence.
  The gateway's own requests use negative integer ids (figaro's door takes
  integer ids only and drops a connection that sends any other), so a page request
  with a negative id is refused.
- Logged: `door handover done (between turns|deadline|lapse notice): N follows
  moved in M ms`, `door handover skipped`, `abandoned` or `failed` with why. If no
  bearer outlasting the current one can be had, or the new leg fails, the old
  leg's close reaches the page as before.

A static `--door-token-file` bearer cannot be renewed, so there is no handover.

## Compression and the door meter

`/door` and `/audio` offer permessage-deflate (level 6, context takeover, messages
under 128 bytes sent plain); audio PCM goes out uncompressed. A client that does not
offer it is served plain; `--no-deflate` stops offering it. Measured on Spain, a
turn stream deflates about 12x with context takeover (form.delta repeats itself),
a first paint 4 to 5x.

Each `/door` socket logs on close `door: session closed frames_out= bytes_out=
wire_out= frames_in= bytes_in= wire_in= deflate= session=` (bytes are JSON payload,
wire is what the socket carried) and, when tracing, ends a `door session` span with
the same numbers as `door.*` attributes, so figscope holds the baseline.

## Origin on writes

Any request behind the gate other than GET or HEAD (`POST /attach`, `POST /stt`,
`POST /stt/key/...`) with an `Origin` that is not this host or a `--origin` is
answered `403` and logged `403 foreign origin`, before it is read. A request with
no `Origin` (a script on the host) passes, as upgrades do.

## POST /attach

Body is one file, any `Content-Type`; `X-Attach-Name` (URL-encoded, cut to 120
characters) names it for the reply and is required (`400` without it), so a
cross-site form cannot post one. At most 10 MiB; two uploads are worked at once
(`503` beyond). The type is read from the bytes:

- png, jpeg, gif, webp, heic: decoded by ImageMagick from the sniffed format only, under
  its own policy, written fresh for each run and refused if it cannot be (only those
  coders; no delegates, filters or @-paths; 16K pixels a
  side, 128 MP, 256 MiB, 15 s),
  turned upright, scaled to a long edge of 1568 px, stripped of metadata (EXIF,
  GPS), and kept as png (png in) or jpeg; over 5 MB after that is scaled again or
  refused.
- pdf: `pdftotext -layout`. A pdf with no text layer (a scan) has its first 4 pages
  drawn as jpeg images (`pdftoppm -scale-to 1568`, so a huge page stays small) instead;
  it never goes out as empty text.

Answers `200 {id, kind, name, bytes, images, pages?, text?}`, or `400` (empty),
`405`, `413` (over 10 MiB, declared or read), `415` (not one of those types), `422`
(unreadable), `429` (16 waiting, or 64 MiB held), `503`. An id is 128 random bits,
held 15 minutes, and spent by the first `figaro.qua` that names it.

`figaro.qua` may carry `attachments: [id, ...]` (1 to 8) with non-empty `text`. The
gateway replaces them before the door: images (and a scan's pages) join `images`,
at most 4 with any the page sent; each pdf's text is appended to `text` as a fenced
block headed by its name and page count. An unknown, spent, expired or repeated id,
or too many images, refuses the call naming why, and nothing is spent. The ids are
capabilities, not tied to the session id (which stays correlation only). The log
says `attach kind= bytes= images= pages= text= session=` and `attachments=N` on the
qua line, never a name or content. `--no-attach` turns it off.

## Traces

With `--otlp-endpoint URL` the gateway makes spans and posts them as OTLP/HTTP JSON
to `URL/v1/traces` every 5 s or 256 spans, one batch at a time (a full queue of
4096, the batch in flight included, drops spans; a post the collector has not
answered within 10 s, or a failed one, drops its batch and is logged at most once
a minute; shutdown waits at most 3 s for the last flush). Without it the
gateway makes none, and passes a page's valid `traceparent` through untouched.

- `door <method>`: each client call with an id, from forward to the door's answer,
  under the `traceparent` a `figaro.qua` carried. The qua goes on carrying the
  gateway span's `traceparent`, so figaro's turn hangs under it.
- `http <method> <route>`: each HTTP request behind the gate, under the request's
  `traceparent` header; a malformed one is dropped. Speech calls made for it
  (`/stt`, `/stt/<id>`, `/audio/keys`, the replay) carry this span's `traceparent`.
- `tts` (and `say`): a spoken turn from tts open to done, cancel or error, under the
  last traced `figaro.qua` on that aria in the past 120 s; the `/tts` dial carries
  its `traceparent`.
- `/stt/stream` passes a valid `traceparent` header of the upgrade on to speech.

Attributes are `rpc.method`, `figaro.aria`, `figchat.session`, `tts.turn`,
`tts.bytes`, `http.request.method` and `http.response.status_code`; never params,
text or credentials. Errors are the span status, redacted.

## Session ids

A figaro web page mints one id per load and sends it as `X-Figchat-Session` on
every request; a WebSocket upgrade, which a browser cannot give headers, may carry
it as `?session=` instead (the header wins, and a query is read only on an
upgrade). An id is `[A-Za-z0-9_-]{8,64}`; anything else, or none, is `-`.

The id is correlation only: never identity, never authorization. It decides
nothing; a request with a bad or missing id is served exactly as one with a good
id. It rides:

- every gateway log line about that request or socket (`session=`);
- the door dial of that `/door` socket, as `X-Figchat-Session` (figaro ignores it
  today); the shared audio follow dials without one;
- every speech call: `POST /stt`, `POST /stt/<id>`, `POST /audio/keys` and the
  `/audio/key/` replay carry the asker's id, and so does the `/stt/stream` dial (as a header, never in its query). A `/tts` session is shared by every
  socket listening to the aria, so its header, and each audio line about that
  turn, carry the listening sessions comma-joined, deduped, in the order they
  joined, at most 8 (a say carries only the asker's).

## Sample unit

```
[Unit]
Description=figaro gateway
After=network-online.target figchat-speech.service

[Service]
ExecStart=figaro-gateway \
  --door-url wss://gluck.example.ts.net:7445/door \
  --speech-socket /run/figchat/speech.sock \
  --store gluck \
  --listen-socket /run/figaro-gateway/gateway.sock \
  --admin gluck
LoadCredential=door:/run/secrets/figaro-gateway-door-bearer
LoadCredential=edge:/run/secrets/figaro-gateway-edge
DynamicUser=yes
Group=figchat
UMask=0007
RuntimeDirectory=figaro-gateway
RuntimeDirectoryPreserve=yes
Restart=on-failure
```

The door bearer is read from `$CREDENTIALS_DIRECTORY/door`, the edge secret from
`$CREDENTIALS_DIRECTORY/edge`.

## Minting the door bearer

A static bearer expires with its token. For an OAuth client (Authelia
`client_credentials`) the gateway mints and refreshes its own:

```
figaro-gateway ... \
  --token-url https://auth.kelliher.info/api/oidc/token \
  --client-id figaro-gateway \
  --client-secret-file $CREDENTIALS_DIRECTORY/client-secret \
  --audience https://fig.kelliher.info
```

It posts `grant_type=client_credentials` and the `audience`, with the client as
HTTP basic auth (`client_secret_basic`), at start (a failure there stops the
gateway) and again at 80% of `expires_in`. A failed refresh is logged (status
only, never the secret) and retried with backoff, 1 s doubling to 60 s, while the
old token is kept until it expires; a dial after that mints on demand. A door
that refuses the upgrade with 401 makes the gateway mint a new token and redial
once. The secret file is read at each mint, so a rotated credential is picked up.
`--token-url` and `--door-token-file` are alternatives; the static bearer stays.

## Acting for the signed-in user

With `--on-behalf-of`, each door dial (for `/door` clients and for the audio
follow) also sends `X-Figaro-On-Behalf-Of: <Remote-User>`. A daemon that lists the
gateway under `[[authz.delegation]]` then seats the connection as that user: the
user's seat and grants, the user as the sender of messages, with the service's verbs
as a ceiling. A daemon that does not list it answers 403. Without the flag the
gateway acts as its own service principal.
 The audio follow dials the door as the admin;
`/door` clients dial it as their own `Remote-User`, passed to the `door` option
(where an on-behalf-of rule would attach).
