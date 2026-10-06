# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues — the tracker is public once this repository is public.

Report privately through **GitHub Security Advisories**:
[Report a vulnerability](https://github.com/Nuncio-hq/LilOS/security/advisories/new)
(the "Security" tab on this repository → "Report a vulnerability").

Please include as much of the following as you can:

- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- the affected part (web/desktop/mobile app, relay, harness, docs, CI);
- any suggested remediation.

## What to expect

- We will acknowledge your report as soon as we can, and keep you informed as
  we investigate and fix.
- Please give us a reasonable window to remediate before disclosing publicly,
  and avoid accessing other users' data or degrading the service beyond what
  is needed to demonstrate the issue.

## Scope

LilOS is a prototype: source code, CI workflows, and the public site in
`site/`. The app runs against engines and machines you operate; findings
about third-party engines (e.g. Hermes) belong to their own projects.

## Relay hardening notes

The relay binds loopback (plus an opt-in Tailscale listener for phone
pairing) and is the only thing holding the per-install token
(`~/.lilos/relay-token`, 0600). Current hardening in force:

- **Constant-time secret compares.** `session.hello`'s install token and
  the paired-device credential are checked with `timingSafeEqual` over
  SHA-256 digests (`apps/relay/src/auth.ts` `equalSecret`), so response
  timing can't reveal a matching prefix.
- **WebSocket Origin gate.** `/ws` upgrades carrying an `Origin` header
  are refused unless the origin is loopback (`localhost`/`*.localhost`,
  127.0.0.0/8, `[::1]`, any port), `file://`, `null` under an Electron
  `User-Agent` (the packaged desktop app — a bare `null` is what a foreign
  page's sandboxed iframe sends, so it's refused), or the request's own
  `Host`. Non-browser clients send no `Origin` and pass. This is
  defense-in-depth: the token still does the real auth.
- **Pairing exchange throttle.** `POST /pair/exchange` spends one-time,
  5-minute grants. After **5 consecutive `unknown` codes** the endpoint
  answers **`429 {error:"throttled"}` for 60 seconds** — every exchange,
  valid codes included. `used`/`expired` replies never count against the
  budget (they prove the caller already held a real code), and a
  successful exchange resets it. The budget is shared across callers;
  pairing is rare, so a lockout only delays a real attempt by a minute.
- **Pre-upgrade credential check + hello deadline.** `/ws` upgrades carry
  a credential in the query — `?token=` for install-token clients,
  `?deviceId=&credential=` for paired phones — checked **before**
  `server.upgrade` (`apps/relay/src/auth.ts` `authorizeRelayUpgrade`, the
  #564 feed-gate pattern; the token compare stays constant-time via
  `equalSecret`). A refused handshake answers `401` and never attaches, so
  an unauthenticated peer can't hold a socket whose frame buffer may reach
  `MAX_FRAME_BYTES` (160 MiB). An attached socket that hasn't completed
  `session.hello` within **10 s** (`HELLO_DEADLINE_MS`) is closed
  `4408`, so a stalled peer can't linger pre-auth either. `session.hello`
  still authenticates the same credential on the socket — the gate bounds
  what runs before it, it doesn't replace it.
