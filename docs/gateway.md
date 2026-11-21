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
  Allowed: `angelus.hello`, `figaro.follow`, `figaro.unfollow`, `figaro.form`,
  `figaro.read`, `figaro.qua`, `figaro.interrupt`, `figaro.fork`, `figaro.list`.
  Everything else (set, form.create, kill) is refused. `figaro.qua` may carry only
  `figaro_id`, `text` and `images`, and `figaro.fork` only `figaro_id`, `at_turn` and
  `at_lt`: any other field (`form` with its patch, context or outfits; a fork's
  `patch`, `outfits`, `seat`, `studies`, `abdicates`) is refused with an error naming
  it, never dropped silently. A `figaro.interrupt` also cancels pending audio for
  that aria. Frames are limited to 1 MiB, so `qua` images (the daemon allows up to
  4 of 10 MiB) are out of scope here and close the socket with 1009. A failure to
  reach the door closes the socket with a fixed reason; the detail goes to the
  gateway's log with the query and userinfo removed.
- `/audio/<aria>` or `/audio/<store>/<aria>` (WebSocket, aria is the 32-hex id; a
  store the gateway does not serve is answered with an `error` frame, code `store`,
  and the socket closes): follows the aria server-side
  with `figaro-forms/aria` (the native store: `onFrame` and `onTurnEnd`), one follow
  and one speech session per reply however many sockets listen. It speaks the
  output-role prose nodes (`node.type === "prose"`, `node.role === "output"`) of
  the frames it is told. Its frames are the gateway's own side channel, not UI IR.
- `GET /audio/key/<store>/<aria>:<turn>/out`: replay, passed to the speech socket
  with `Range`. Only keys of the gateway's own store (404 otherwise); an unparsable
  target or escape answers 400.
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
  from its second half). A turn that starts after the follow is spoken whole. After a
  reconnect the stream re-reads the running turn and the gateway speaks what it
  gained while offline, once; a turn that ended while offline is spoken from where
  it had got to.
- `{type:"audio.start", turn, key, format:"pcm", rate:24000, bits:16, channels:1, node, chars, cursor}`
- `{type:"audio.chunk", turn, node, chars, cursor, offset, bytes}` followed at once
  by one binary frame of `bytes` PCM (s16le, even length). The tags are native
  coordinates: `turn` is the turn id, `node` the ordinal of the prose node
  (`from + i` in the UI IR) and `chars` the number of UTF-16 units of that node's
  `markdown` the speech service had been fed when this audio arrived; `cursor` is
  the stream's cursor (the highest sealed turn, `Client.Cursor`) at that moment. The
  audio is at or after that point in the text, never before. `offset` is the byte
  position in the turn's audio.
- `{type:"audio.end", turn, key, audio_id?}` after the last chunk. `key` is always
  present: the A9 key `<store>/<aria>:<turn>/out`, replayable at
  `/audio/key/<key>`. `audio_id` is present when the speech service reports one.
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
