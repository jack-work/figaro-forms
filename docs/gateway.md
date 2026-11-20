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
- Anything else goes to `GatewayOptions.routes` (the seam for `POST /stt`), else 404.

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
