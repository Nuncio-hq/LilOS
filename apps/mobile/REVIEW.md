# App Review notes — LilOS beta (TestFlight)

## What the app is

LilOS is the phone companion for **LilOS on the Mac**: a Slack-style app where
the "employees" are AI agents that run on the user's own Mac. The iPhone app
is a client of that Mac — it pairs to the Mac app over a QR code and then
works against it (read threads, steer agents, approve or deny their tool
calls, watch background jobs).

## How to review it — no Mac, no account required

The app works fully offline for review:

1. Launch the app → the Welcome screen appears.
2. Tap **"Try the demo"** (the secondary button under "Connect your Mac").
3. You are now inside a scripted, fully offline demo company — every screen
   works: threads stream replies, approvals can be allowed or denied, plans,
   subagents, background jobs, settings.
4. A **Demo** badge floats on every screen. To leave: Settings → **Exit
   demo** (also shown: **Connect your Mac**, which exits to the real pairing
   flow). Exiting the demo leaves nothing behind on the device.

No sign-in, no server, no hardware besides the iPhone under review. The demo
never opens a network connection, so the whole flow also works in Airplane
Mode.

## Privacy

https://nuncio-hq.github.io/lilos-site/privacy/

## One-line beta description (TestFlight "What to Test")

> LilOS is the phone client for AI employees running on your Mac. Tap "Try
> the demo" to explore every screen offline — no account or Mac needed.
