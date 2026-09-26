# Reference projects

Before you design a seam, read how these projects solve it. All three are MIT
licensed: port ideas and code with an attribution comment. Don't port their
frameworks (T3/Synara use Effect-TS) or anything they own that we don't.
Cite the files you read in the issue.

| Project | Borrow | Start at |
|---|---|---|
| T3 Code `pingdotgg/t3code` | client/server split, seq-based sync (snapshot + replay), provider adapter + capabilities, `contracts` / `client-runtime` split | `docs/internals/`, `packages/contracts/src/providerRuntime.ts`, `apps/server/src/provider/Services/ProviderAdapter.ts` |
| Synara `Emanuele-web04/synara` | ACP adapter, adapter conformance tests, mock/conformance agents | `apps/server/src/provider/acp/`, `apps/server/src/provider/providerAdapterConformance.ts`, `apps/server/scripts/acp-mock-agent.ts` |
| Hermes Desktop `NousResearch/hermes-agent` | a renderer over a headless engine, JSON-RPC client with reconnect replay, a wire contract declared once and generated for TS | `apps/shared/src/json-rpc-gateway.ts`, `tui_gateway/contracts/`, `scripts/gen_gateway_contracts.py` |
