# Self-hosting figaro web

How to stand up figaro's web client on your own host, from nothing, with your own
identity provider. The worked example is gluck's deployment on `fig.kelliher.info`
(Authelia over lldap, Caddy, Cloudflare tunnel, a NixOS box called spain); every
step is written generically, and the kelliher.info values are marked as the example.
No secret value appears here: each secret is named, with where it lives and how to
mint it.

Facts below were read from the repos at the pins in the next section. Anything
marked **unverified** was not run on a live host by the author and should be
checked once.

## What you are building

```
browser ──https──> reverse proxy (TLS, forward-auth to your IdP)
                     │  /chat/*        static client bundle (served by the proxy)
                     │  /door, /audio, /chat/stt  + X-Figaro-Edge, Remote-User
                     ▼
               figaro-gateway  (unix socket, behind the proxy only)
                 │  /door   raw JSON-RPC passthrough  ─────────> figaro daemon [door.web]
                 │  /audio  follows an aria, voices its prose        (bearer, TLS front)
                 │  /stt    dictation in
                 ▼
          figchat-speech (unix socket) ──> Azure Speech (TTS websocket, fast transcription)
                 └──> S3 bucket for audio blobs (Garage in the example)
```

The browser holds no credential. The proxy authenticates the person (forward-auth)
and tells the gateway who it is with two headers. The gateway authenticates itself
to the figaro daemon as an OAuth client and mints its own token. The speech service
holds the Azure key.

## Parts and pins

| part | repo | pin | what it is |
|---|---|---|---|
| figaro daemon | `jack/figaro` (keel), github `jack-work/figaro` | v0.78.1 (tested; the wire is the one in `docs/aria.md`) | the store and the door the gateway dials |
| figaro-forms | `jack/figaro-forms` | v0.4.1 (branch `lane/v0.4.1`, `0faff64`, until tagged) | the TypeScript client library; builds the gateway |
| figaro-gateway | same repo, `packages/bridge` | same | the door passthrough plus voice; `nix build .#bridge` gives `bin/figaro-gateway` |
| web client | `jack/zanni` (keel), github `jack-work/zanni` | v0.28.0 (`f309c7f`); the next tag vendors figaro-forms v0.4.0 | the static bundle (`packages.figchat-shell`) |
| speech service | `jack/figchat-speech` | v0.4.0 (`9bd1a32`) | `figchat-speech`: Go, unix socket, TTS, STT, audio replay |
| Azure resource | `jack/kelliher-web` `terraform/speech` | `58b3638` (example) | Speech account, resource group data source, budget |
| edge routes (example) | `jack/kelliher-web` | v0.7.0 (`83ff21e`) | `lib.figchatRoutes`, the Caddy route text |

Read first: `docs/aria.md` (the wire the client folds), `docs/gateway.md` (the
gateway's routes, frames and flags).

## Requirements

- Linux with systemd. Nix is the supported way to build everything (each repo has a
  flake) but nothing requires it: the gateway needs Node 24 (the flake pins
  `nodejs_24`), the client bundle needs Node 20 or newer (`node bin/figchat-bundle
  OUT`), the speech service needs Go 1.26 and `ffmpeg` with libmp3lame on its path.
- A reverse proxy that can do forward-auth, set headers, proxy websockets without
  buffering (`flush_interval -1` in Caddy) and serve a static directory. The example
  uses Caddy; nginx `auth_request` or Traefik forward-auth work the same way.
- An OIDC provider that can issue `client_credentials` tokens with an audience and
  publishes a JWKS (Authelia, Keycloak, Authentik, Zitadel ...), and a user directory
  behind it (lldap in the example).
- An Azure subscription for Speech (or replace `figchat-speech`; its API is below).
- An S3-compatible bucket for stored audio (Garage in the example). Expiry is
  swept by the service (30 days by default).
- Sockets, no new public ports: the daemon's web door is a unix socket, the gateway
  listens on a unix socket (or loopback TCP with `--port`), the speech service on a
  unix socket. The only network hop is gateway to daemon (below).
- TLS on the public name. A page needs https for the microphone and for `wss:`.

## 1. Identity

Two kinds of principal, both through your OIDC provider.

**People (the browser).** The proxy does forward-auth against the provider's session
(Authelia's `/api/authz/forward-auth`, Keycloak via oauth2-proxy and so on). On
success it copies the identity into request headers and the gateway trusts them. The
gateway serves exactly one user: `--admin USER` must equal the `Remote-User` the
proxy sends (the person's login name). Everyone else gets 403.

- Put the people allowed in a group and make the proxy's access rule require it
  (example: group `site-fig-access` on the `fig.kelliher.info` rule).
- Require a second factor in the provider's policy for this site; the gateway adds
  none of its own.
- The proxy must strip any `Remote-*` and `X-Forwarded-*` it did not set itself, then
  set `Remote-User` from the forward-auth reply. A client that can send its own
  `Remote-User` owns the aria.

**The gateway (a service).** An OIDC client using the `client_credentials` grant:

| setting | value (example) |
|---|---|
| client id | `figaro-gateway` |
| authentication at the token endpoint | `client_secret_basic` (the gateway sends HTTP basic auth) |
| grant types | `client_credentials` only |
| audience | the proxy's origin, `https://fig.kelliher.info` |
| token lifetime | any; the gateway refreshes at 80% of `expires_in` |
| secret | generated by you, stored hashed in the provider, plaintext only in the gateway's credential file |

In Authelia that is an entry under `identity_providers.oidc.clients` with
`token_endpoint_auth_method: client_secret_basic`, `grant_types: [client_credentials]`
and `audience`; the `client_secret` there is a digest, never the plaintext. In
Keycloak: a confidential client with "service accounts enabled" and an audience
mapper. For another provider, match the two facts that matter: the token carries
`iss` equal to the issuer the daemon trusts, and the client is the identity the
daemon's policy names.

The daemon maps the token to a principal named `service:<client-id>@<issuer host>`
(example: `service:figaro-gateway@auth.kelliher.info`).

## 2. The figaro daemon

Install figaro (v0.78.1) as the user whose store this is; that user is the owner.
Append to `~/.config/figaro/config.toml` (paths are the example's):

```toml
[authz]
policy = "policy.toml"

[[authz.issuers]]
issuer = "https://auth.kelliher.info"
jwks   = "https://auth.kelliher.info/jwks.json"
clients = { "figaro-gateway" = "service" }

[door.web]
path  = "/run/user/1000/figaro/web.sock"
mode  = "0660"
authn = "bearer"
```

and `~/.config/figaro/policy.toml`:

```toml
[roles.owner]
permissions = ["*:*"]

[[bind]]
role = "owner"
principals = ["user:1000"]            # the daemon's uid: the owner

[roles.figaro-gateway]
permissions = ["read:*", "listen:*", "send:*", "fork:*", "use:sandbox:local"]

[[bind]]
role = "figaro-gateway"
principals = ["service:figaro-gateway@auth.kelliher.info"]
```

Naming a policy file makes every grant explicit, so the owner bind is required or you
lock yourself out. `figaro outfit reload` reloads the policy (a policy that fails to
load leaves the old one in force); restart the daemon for `[door.web]` and the issuer.

Notes:

- `use:sandbox:local` is needed for fork. `fork:*` alone is refused with
  `none grants use here`.
- Never grant the gateway `kill`, `set` or `system`; the gateway refuses those
  methods itself, but the policy is the real fence.
- Until the on-behalf-of rule ships, the gateway acts as the service principal, not
  as the person: messages sent from the web show that sender. After it ships, the
  gateway presents the person from `Remote-User`; the policy then needs the grant
  that rule names (**unverified**: not released at the time of writing).
- If the daemon already trusts the same issuer URL elsewhere (a troupe), keep one
  `[[authz.issuers]]` entry for it and add the client to that entry; two entries for
  one issuer with one scope are refused.
- `jwks` is the provider's public JWKS. If the daemon reaches the provider over a
  private network, use that URL.

## 3. Network: gateway to the daemon's door

The gateway dials the door with `--door-url` over `wss://`. If the gateway runs on
the same host as the daemon, point it at the unix socket instead:
`--door-url ws+unix:///run/user/1000/figaro/web.sock:/door`. If it runs elsewhere
(the example: gateway on spain, daemon on gluck's desktop), put a TLS front on the
daemon host that terminates TLS and forwards to `web.sock`, listen on a private
address (the example: a tailnet address, port 7445), and allow only the gateway's
host to connect (a firewall rule on that port). The bearer protects the door, TLS
protects the bearer, the private network keeps the door off the internet. The door
is a websocket at `/door`.

## 4. The speech service

`figchat-speech` v0.4.0: one Go binary, `figchat-speech serve`, listening on a unix
socket (the example: `/run/figchat/speech.sock`), no public route. Credentials by
systemd `LoadCredential`: `azure-speech-key`, `garage-key-id`, `garage-secret`.
Egress only to the Azure Speech STT and TTS hosts for your region and to the bucket.
It needs `ffmpeg` with libmp3lame (`--ffmpeg PATH`), and its flags choose the socket,
the bucket, the region's `--tts-url`, the expiry and the sweep interval; run
`figchat-speech serve -h` for the exact set at your pin.

API (v0.4.0, keys are `<store>/<aria>:<turn>/<in|out>`):

- `POST /stt?key=K` body is a clip (`audio/webm`, `audio/ogg`, `audio/mp4`) returns
  `{text, duration_ms, audio_id}`; `POST /stt/{audio_id}` re-transcribes.
- `WS /tts?key=K&voice=V&format=pcm|mp3`: client sends `{"text":...}` frames then
  `{"end":true}`; server sends binary audio (pcm is s16le, 24 kHz, mono), then
  `{"audio_id":...}`. Markdown is normalized before it reaches Azure.
- `GET /audio/key/<K>` and `GET /audio/{id}` with `Range`; `POST /audio/keys`.

The speech service is the only part that is Azure-specific. Anything that speaks this
API on a unix socket can replace it; the gateway only uses `/tts`, `/stt` and
`/audio/key`.

### Azure Speech resource

The example creates it with OpenTofu/Terraform (`kelliher-web terraform/speech`,
`58b3638`): `azurerm ~> 4`, a SpeechServices account (S0, custom subdomain) in a
resource group that already exists (read as a data source, so the credential needs
rights on that group only), and a monthly budget with alerts. It outputs the region
and endpoint and deliberately no key. To do it by hand: create a Speech resource in
the region you want (`eastus` in the example), then fetch the key with the Azure CLI
straight into your secret store, never to the terminal:
`az cognitiveservices account keys list -g GROUP -n ACCOUNT --query key1 -o tsv`
piped to the credential file. The region is configuration, not a secret.

### Audio bucket

Stored clips and replies live in an S3 bucket (Garage in the example: bucket
`figchat-audio`, one key with read and write on that bucket only, no bucket-create).
The service sweeps objects older than its expiry. Without a reachable bucket the
service cannot start storing; if you do not want storage, that is a change to the
service, not a flag (**unverified**: confirm with the speech service's owner).

## 5. The gateway

Build: `nix build .#bridge` in figaro-forms gives `bin/figaro-gateway`; without Nix,
`npm ci && npm run build:all` and run `node packages/bridge/dist/gateway-main.js`.

```
figaro-gateway \
  --door-url wss://daemon.example.net:7445/door \
  --token-url https://auth.kelliher.info/api/oidc/token \
  --client-id figaro-gateway \
  --client-secret-file $CREDENTIALS_DIRECTORY/client-secret \
  --audience https://fig.kelliher.info \
  --speech-socket /run/figchat/speech.sock \
  --store gluck \
  --listen-socket /run/figaro-gateway/gateway.sock \
  --admin gluck \
  --edge-secret-file $CREDENTIALS_DIRECTORY/edge
```

- `--admin` is the one `Remote-User` served. `--store` is the store id in audio keys
  (`[a-z0-9-]`, up to 63).
- `--edge-secret-file` is a shared secret of at least 32 bytes that the proxy sends in
  `X-Figaro-Edge`; with it a request that skipped the proxy is refused.
- The token flags are an alternative to `--door-token-file` (a static bearer that
  expires with its token). The gateway fetches a token at start (and refuses to
  start if that fails), refreshes at 80% of its lifetime, retries failures with
  backoff keeping the old token, and mints again once after a 401.
- `--origin URL` admits pages from other origins; same-origin pages always pass.
- A unit: see `docs/gateway.md` ("Sample unit"). Give it the group that can reach the
  speech socket and the proxy's group on its own socket (`Group=`, `UMask=0007`).

## 6. The web client

Build the bundle from zanni: `nix build .#figchat-shell`, or `node bin/figchat-bundle
OUT_DIR` (Node 20 or newer). The result is one flat directory (`index.html`,
scripts, CSS, fonts, `SHA256SUMS`) with no inline script or style. `figaro-forms/aria`
is vendored into it (`node bin/figchat-vendor-aria <figaro-forms checkout>`); the
bundle's `SOURCE.json` records the ref and sha.

Serve it at `/chat/` with assets at `/chat/assets/`. Run-time configuration is
attributes on the `#app` element of `index.html`, none at build time:

| attribute | default | meaning |
|---|---|---|
| `data-door` | `/door` | the gateway's JSON-RPC passthrough |
| `data-audio` | `/audio` | `/audio/<aria>` and `/audio/key/<key>` |
| `data-stt` | `stt` (relative: `/chat/stt`) | dictation |
| `data-store` | `gluck` | the store id; must equal the gateway's `--store` |

CSP: script, style, font and img from self; `connect-src 'self'` plus an explicit
`wss://<host>` for browsers that do not count `'self'` as covering it; `media-src 'self'
blob:`. Send `Permissions-Policy: microphone=(self)`.

## 7. The reverse proxy

Routes, all behind forward-auth:

| path | goes to |
|---|---|
| `/` (html) | redirect to `/chat/` |
| `/chat/` and `/chat/assets/*` | the static bundle (`file_server`, dotfiles hidden) |
| `/door` | gateway, websocket |
| `/audio/*` | gateway, websocket and ranged GET |
| `/chat/stt` | gateway `/stt` (strip `/chat`), body up to 10 MB |

For every proxied request to the gateway set `X-Figaro-Edge` to the shared secret and
`Remote-User` to the forward-auth identity, after removing the client's versions.
Turn buffering off (`flush_interval -1`), set no `encode`, cap bodies per route, and
send websocket pings both ways about every 20 s (a CDN such as Cloudflare closes idle
sockets and answers 524 on idle responses).

The example's Caddy text is `lib.figchatRoutes { assets = <figchat-shell>; }` in
kelliher-web v0.7.0, wired as `services.kelliher-web.sites.figaro.activatedBackends`.
The gateway switch (the paths above onto the gateway socket) is the Backend's
deployment of it. Check the route text there for the exact matchers; the table is the
contract.

Behind Cloudflare: do not cache `/audio` (private, no-store), and confirm the
tunnel hostname is excluded from any cache rule.

## 8. Secrets

| secret | where it lives | how it is minted | who reads it |
|---|---|---|---|
| gateway client secret | the provider (hashed) and a credential file for the gateway | random string you generate; hash it with the provider's tool for the provider config | figaro-gateway (`--client-secret-file`, systemd `LoadCredential=client-secret`) |
| edge secret | one credential file on the gateway, the same value in the proxy's config | `openssl rand -hex 32` | gateway (`--edge-secret-file`), proxy (header injection) |
| Azure Speech key | credential `azure-speech-key` | `az cognitiveservices account keys list ... -o tsv` into the secret store | figchat-speech |
| Azure credential for terraform | the CI/secret store of whoever applies it | a service principal with rights on the one resource group | the terraform run only |
| bucket key id and secret | credentials `garage-key-id`, `garage-secret` | the bucket's own tool (Garage: create a key, grant it read and write on the bucket only) | figchat-speech |
| a static door bearer (only if you do not use the token flags) | `--door-token-file` | the provider | figaro-gateway |

In the example these are in SOPS and delivered by systemd credentials. Type secrets
into the command yourself; do not paste them into chat or a terminal that logs. If one
leaks, rotate it: the client secret in the provider, the edge secret on both ends, the
Azure key in the portal, the bucket key in the bucket.

## 9. Smoke tests, layer by layer

Run them in order; stop at the first failure.

1. **Provider.** Mint a token as the gateway would and read its claims. Put the
   client's basic-auth header in a mode-0600 file and use it: `curl -sS -d
   grant_type=client_credentials -d audience=https://fig.kelliher.info -H @hdr
   $TOKEN_URL`. Expect `access_token` and `expires_in`. 401 means the client id,
   secret or auth method is wrong.
2. **Daemon door.** With that token, upgrade a websocket on the unix socket: `curl
   -sS -o /dev/null -w '%{http_code}\n' --unix-socket web.sock -H "Authorization:
   Bearer $T" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H
   'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' http://door/door`.
   Expect 101; without the bearer, 401.
3. **Speech.** `figchat-speech stt --socket /run/figchat/speech.sock clip.webm`
   prints the transcript and timings; `figchat-speech tts --socket ... text.txt`
   reports the first-audio latency.
4. **Gateway.** On its socket, without the edge headers: expect 403. With
   `X-Figaro-Edge` and `Remote-User`: an unknown path is 404; a websocket to `/door`
   answers `angelus.hello` (the daemon's capabilities), proving the token works.
5. **Proxy.** Anonymous `GET /chat/` redirects to login and never reaches the
   gateway; a signed-in one returns the page. `GET /audio/key/x` anonymous is
   refused.
6. **End to end.** Open `/chat/`, pick an aria, send a message, watch the reply
   stream, hear it (needs a click first on iOS), dictate one with the microphone.
   Then interrupt a reply and check that audio stops.

## 10. Troubleshooting

- **Door answers 401 to the gateway.** The `iss` of the token differs from
  `[[authz.issuers]].issuer`, the client id is missing from `clients`, the token
  expired (the gateway mints once more after a 401, so a persistent 401 is
  configuration), or the daemon cannot fetch the JWKS. Check the gateway log for the
  token endpoint status; it never prints the secret.
- **Fork fails with `none grants use here`.** The role lacks `use:sandbox:local`.
- **A call is refused as a write you did not mean.** The gateway passes `qua` with
  only `figaro_id`, `text` and `images`, and `fork` with `figaro_id`, `at_turn` and
  `at_lt`; a form patch, outfits, seat, studies or abdication is refused by name, and
  `figaro.set`, `figaro.kill` and `form.create` are not allowed at all. Operator-only
  keys (anything under `system.*`, the daemon's own settings) are the owner's; the
  web path cannot set them by design. Do those at the terminal.
- **403 from the gateway.** `Remote-User` is not `--admin`, or `X-Figaro-Edge` is
  missing or wrong, or the page's origin is not the proxy's (`--origin`).
- **Socket closes with 1009.** A `door` frame over 1 MiB, such as `qua` with images;
  images are out of scope here.
- **`/chat/stt` returns 415, 413, 503.** The body is not webm or mp4 by its first
  bytes; the clip is over 10 MB; four clips are already in flight.
- **No audio.** The gateway cannot reach the speech socket (group and `UMask`), the
  Azure key or region is wrong (the gateway sends `error` with code `speech`), or the
  browser has not been unlocked by a click. Joined mid-turn, speech starts from the
  join point, not from the beginning of the reply.
- **Page loads but never connects.** CSP `connect-src` lacks `wss://<host>`, or the
  proxy buffers websockets, or the page's `data-door` does not match a proxied path.
- **Microphone denied.** The page is not https, or `Permissions-Policy` omits
  `microphone=(self)`.
- **Replies stop after about 100 s on a CDN.** Pings are not reaching the client;
  keep the proxy's idle timeouts above 20 s and do not buffer.

## Worked example: kelliher.info

- Public name `fig.kelliher.info`, through a Cloudflare tunnel to Caddy on spain.
- Identity: Authelia at `auth.kelliher.info` over lldap, group `site-fig-access` on
  the site's rule, a second factor required; the gateway is the OIDC client
  `figaro-gateway`.
- The daemon runs on gluck's desktop with `[door.web]` as a unix socket and a TLS
  front on a tailnet address, port 7445, fenced to spain.
- Spain runs `figchat-speech` (socket `/run/figchat/speech.sock`), the gateway (socket
  `/run/figaro-gateway/gateway.sock`) and the Caddy routes. Garage on spain holds
  `figchat-audio`; Azure Speech is in `eastus`, applied by a keel CI pipeline from
  `kelliher-web terraform/speech`.
- To redeploy elsewhere with another directory (lldap, FreeIPA, AD): only section 1
  changes. The provider authenticates people and the client; the daemon and gateway
  see an issuer, a JWKS and a `Remote-User`.
