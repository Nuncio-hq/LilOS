# Third-Party Notices

LilOS is licensed under the [Elastic License 2.0](LICENSE.md). It includes or
borrows ideas from the third-party works listed below. Each work is used under
its own license, which is reproduced in the referenced project; the notices
here keep the attribution comments that already live in the code.

Ordinary npm dependencies are covered by the licenses in their own packages
(`node_modules/<pkg>/LICENSE`) and are not listed one by one.

## Ported code and borrowed ideas (MIT)

| Work | License | Where it shows up in LilOS |
|---|---|---|
| [T3 Code](https://github.com/pingdotgg/t3code) | MIT | Resumable subscription with snapshot + replay (`channel.subscribe { afterSeq }` → `channel.snapshot`/`channel.synced`): `apps/relay/src/session.ts`, `packages/contracts/src/app/wire.ts`, `packages/client-runtime/src/client.ts` (`connection-runtime` transport-owner pattern). |
| [Synara](https://github.com/Emanuele-web04/synara) | MIT | Conversation placeholder-title rule (first ~6 words / ~60 chars): `apps/relay/src/store.ts`. |
| [Hermes Agent / Hermes Desktop](https://github.com/NousResearch/hermes-agent) | MIT | Reconnect replay via per-channel seq watermarks: `packages/client-runtime/src/client.ts` (`json-rpc-gateway.ts`); declared-once/generated wire contracts: `packages/contracts/scripts/gen-schemas.ts` (`gen_gateway_contracts.py`); model hide/show idea: `packages/ui/src/chat/model-visibility-dialog.tsx` (`apps/desktop/src/store/model-visibility.ts`). |

## Vendored UI components (MIT)

- [shadcn/ui](https://ui.shadcn.com/) — MIT. Vendored under
  `packages/ui/src/components/ui/`.
- [AI Elements](https://github.com/vercel/ai-elements) — MIT (Vercel).
  Vendored under `packages/ui/src/components/ai-elements/`.

## Spike code

- `apps/desktop/native/lilos-svc/main.swift` is ported from LilOS's own
  research spike (`spikes/21-smappservice`, issue #34/#35). It is first-party
  code and ships under ELv2 like the rest of the repo.

## Bundled assets

- **Geist font** — [Vercel Geist](https://github.com/vercel/geist-font), SIL
  Open Font License 1.1, bundled via `@fontsource-variable/geist`
  (`apps/web`, `prototype/web`).
- **Lucide icons** — [lucide-icons/lucide](https://github.com/lucide-icons/lucide),
  ISC License, bundled via `lucide-react`.
- **SF Symbols (iOS)** — rendered at runtime by Apple iOS through
  `expo-symbols`; they are Apple system resources, not bundled files, and
  stay on-device.

## Provider logos

Model-provider marks come from [models.dev](https://github.com/sst/models.dev)
(MIT, SST): `packages/ui-native/src/components/provider-logo.tsx` vendors the
monochrome SVG path data (`anthropic`, `openai`, `xai`, `alibaba`), and
`packages/ui/src/components/ai-elements/model-selector.tsx` loads
`models.dev/logos/<slug>.svg` at runtime.

The marks themselves (Anthropic, OpenAI, xAI, Alibaba, and any other provider
mark reachable through models.dev) are **trademarks of their owners**. They
are used only to identify the provider a model belongs to; ELv2 does not
license those marks to anyone.

## LilOS's own marks

"**LilOS**" and the LilOS logo (`assets/brand/`) are trademarks of Nuncio. The
Elastic License grants no right to use them — forks may not present
themselves as LilOS.
