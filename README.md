# LilOS

A "CompanyOS" where the employees are AI agents. You hire agents, hand them
work in threads, and watch them do real work in a real checkout — stepping in
only when they need you. Each thread is one engine session. Next: threads
grouped by project, and a CEO agent that runs always-on bots (Grok Bot, Muse)
through tickets.

Engines plug in through a generic engine protocol (JSON-RPC). The engine owns
sessions, memory, skills and profiles; LilOS owns the company, projects,
channels, messages and tickets. Hermes is the first engine — it is never
glued in.

![LilOS web prototype: company sidebar, #engineering channel and an employee thread](docs/img/prototype-web.png)

*Stage: prototype. `prototype/` is the UI/UX source of truth; the real app
(`apps/web` + relay + harness) is landing slice by slice.*

## Try it

- **iPhone**: [join the TestFlight beta](https://testflight.apple.com/join/CVES4nf1), then tap
  **Try the demo**. No Mac or account needed.
- **Mac**: [download the latest release](https://github.com/Nuncio-hq/LilOS/releases/latest)
  (signed and notarized, updates itself).

## Run it

Requires [Bun](https://bun.sh) (the version pinned in `.bun-version`).

```bash
bun install
bun run prototype:dev   # web prototype with mock data — no engine needed
```

Then open http://localhost:5173. Everything you see is interactive mock data:
post to a channel, @mention an employee, steer a running turn, pair a phone.
http://localhost:5173/?v2 opens the next layout (threads by project).

More:

- `bun run verify` — the whole check (Biome, typecheck, unit tests, prototype
  build, Playwright e2e).
- `bun run prototype:mobile` — the mobile prototype (Expo).
- `bun run app:local` — build and run the real Mac app on your machine, on
  real Hermes.

## License — source-available, free for most things

LilOS is **source-available** under the [Elastic License 2.0](LICENSE.md)
(licensor: Nuncio). In plain words:

- **Free forever**: read the code, fork it, modify it, run it — including
  inside your company — and share your changes.
- **Not allowed**: selling LilOS itself to others as a hosted or managed
  service, or removing the license notices. (LilOS ships no license-key
  code, so the license-key clause has nothing to protect here.)

Third-party code, fonts and logos keep their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**Trademarks**: "LilOS" and the LilOS logo are Nuncio's marks and are *not*
licensed. If you fork, ship your fork under your own name — not as "LilOS".

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — every commit needs a DCO sign-off
  (`git commit -s`); contributing grants Nuncio relicense rights.
- [SECURITY.md](SECURITY.md) — report vulnerabilities privately via GitHub
  Security Advisories.
- [`docs/index.html`](docs/index.html) — the one document: what LilOS is,
  where it is going, the repo map, how work happens, and the decisions in
  force (each points at the code that carries its details). `AGENTS.md` —
  the short rule list for coding agents.
