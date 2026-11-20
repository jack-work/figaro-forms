# figchat-gateway

The `figchat-gateway` binary (packages/bridge) fronts gluck's figaro door for the
figchat web client and tees a followed aria's spoken prose into figchat-speech.
It sits behind the edge: every request needs the edge secret in `X-Figaro-Edge`
and the admin in `Remote-User`.

## Routes

- `/door` (WebSocket): JSON-RPC to the door, one upstream connection per client.
  Allowed: `angelus.hello`, `figaro.follow`, `figaro.unfollow`, `figaro.form`,
  `figaro.read`, `figaro.qua`, `figaro.interrupt`, `figaro.fork`, `figaro.list`.
  Everything else (set, form.create, kill) is refused. A `figaro.interrupt` also
  cancels pending audio for that aria.
- `/audio/<aria>` (WebSocket, aria is the 32-hex id): follows the aria server-side
  with `figaro-forms/aria`, one follow and one speech session per reply however
  many sockets listen.
- `GET /audio/key/<store>/<aria>:<turn>/out`: replay, passed to the speech socket
  with `Range`.
- `POST /stt?aria=<store>/<aria>`: dictation. See below.
- Anything else goes to `GatewayOptions.routes`, else 404. `figchat-gateway` mounts
  `sttRoute({socket, store})` there.

## POST /stt

Body is the browser's recording, with its own `Content-Type`: `audio/webm`
(`codecs=opus` allowed) or `audio/mp4`. At most 10 MB. The gateway passes the clip
unchanged to figchat-speech `POST /stt` on the speech socket and answers:

- `200 {"text", "duration_ms", "audio_id"}`. `audio_id` names the stored clip in
  figchat-speech (`POST /stt/<audio_id>` there re-transcribes it).
- `400 {"error"}`: `aria` is missing, malformed, or names another store; or the body is empty.
- `405` for anything but POST.
- `413 {"error"}`: over 10 MB. A declared `Content-Length` over the limit is refused
  unread; otherwise reading stops at the limit and the connection closes.
- `415 {"error"}`: any other type (`audio/ogg` included), refused before the body is read.
- `502 {"error"}`: speech is unreachable, answers non-200 (its error text is passed on),
  or answers without `text`, `duration_ms` and `audio_id`.

`aria` is checked and not forwarded: a clip usually precedes its turn, so it has no
audio key yet. The text belongs in the composer; sending it is an ordinary prompt.

## /audio frames

Server to client, text (JSON):

- `{type:"ready", aria, store}` once the follow is live. Turns already running or
  finished are not spoken; only turns that start after it.
- `{type:"audio.start", turn, key, format:"pcm", rate:24000, bits:16, channels:1, node, cursor}`
- `{type:"audio.chunk", turn, node, cursor, offset, bytes}` followed at once by one
  binary frame of `bytes` PCM (s16le, even length). `node` and `cursor` name the
  text the speech service had been fed when this audio arrived: the audio is at or
  after that point in the text, never before. `offset` is the byte position in the
  turn's audio.
- `{type:"audio.end", turn, key, audio_id?}` after the last chunk. `key` is
  `<store>/<aria>:<turn>/out`, replayable at `/audio/key/<key>`.
- `{type:"audio.cancel", turn, key, why}`; `why` is `new-turn`, `interrupt` or
  `client`. No `audio.end` follows.
- `{type:"error", turn?, code, text}`: `code` is `speech` (that turn's audio is over),
  or on attach `aria_gone`, `denied`, `unavailable`, after which the socket closes.

Client to server: `{type:"cancel"}` stops the aria's pending speech for everyone.

Prose is fed to speech from the first sentence (a terminator followed by space, a
newline, or 160 characters), not at node settle. Thinking, tools, steering and the
question are never spoken. Markdown stripping is the speech service's.

## Sample unit

```
[Unit]
Description=figchat gateway
After=network-online.target figchat-speech.service

[Service]
ExecStart=figchat-gateway \
  --door-url wss://gluck.example.ts.net:7445/door \
  --speech-socket /run/figchat/speech.sock \
  --store gluck \
  --listen-socket /run/figchat/gateway.sock \
  --admin gluck
LoadCredential=door:/run/secrets/figchat-door-bearer
LoadCredential=edge:/run/secrets/figchat-edge
DynamicUser=yes
Group=figchat
UMask=0007
RuntimeDirectory=figchat
RuntimeDirectoryPreserve=yes
Restart=on-failure
```

The door bearer is read from `$CREDENTIALS_DIRECTORY/door`, the edge secret from
`$CREDENTIALS_DIRECTORY/edge`. The audio follow dials the door as the admin;
`/door` clients dial it as their own `Remote-User`, passed to the `door` option
(where an on-behalf-of rule would attach).
