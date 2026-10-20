import { StatusDialog, V3Banner, type StatusComponent, type V3Data } from "@lilos/ui"

/* The system status the real app draws beside the shell: a line above the page
   while the relay or the engine is not fine, and the dialog behind its
   Details (also first run's "See status"). Built from `settings`, so what it
   says is what Settings → Engine says. */

const RELAY = { ok: "ok", starting: "connecting", down: "down" } as const
const ENGINE = { ok: "ok", starting: "connecting", down: "down", missing: "down", old: "degraded" } as const

export function statusRows(d: V3Data): StatusComponent[] {
  const { relay, engine } = d.settings
  const relayOk = relay.state === "ok"
  // A leg only waits on the relay while the relay is not answering.
  const engineState = relayOk ? ENGINE[engine.state] : "blocked"
  return [
    { id: "relay", label: "Local relay", state: RELAY[relay.state], reason: relayOk ? "Connected" : (relay.problem ?? `The relay is ${relay.state}.`) },
    {
      id: "engine",
      label: [engine.name, engine.version].filter(Boolean).join(" "),
      state: engineState,
      reason: engine.state === "ok" ? "Ready" : (engine.problem ?? `${engine.name} is ${engine.state}.`),
    },
  ]
}

/** The line above the page: the worst leg, only while something is wrong. */
export function StatusBanner({ data, onDetails }: { data: V3Data; onDetails: () => void }) {
  const worst = statusRows(data).find((r) => r.state === "down") ?? statusRows(data).find((r) => r.state === "connecting" || r.state === "degraded")
  if (!worst) return null
  return (
    <V3Banner
      status={worst.state === "down" ? "failed" : "waiting"}
      text={`${worst.label}: ${worst.reason}`}
      action={{ label: "Details", run: onDetails }}
    />
  )
}

export function StatusDetails({ data, onClose, onCopied }: { data: V3Data; onClose: () => void; onCopied: () => void }) {
  const rows = statusRows(data)
  return (
    <StatusDialog
      components={rows}
      diagnostics={[data.settings.about?.version ?? "LilOS", ...rows.map((r) => `${r.label}: ${r.state} · ${r.reason}`)].join("\n")}
      onClose={onClose}
      onCopied={onCopied}
    />
  )
}
