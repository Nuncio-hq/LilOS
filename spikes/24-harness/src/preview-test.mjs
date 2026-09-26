// Spike #24 — preview URL discovery experiment.
// Compares three detection paths for "an agent just started a dev server":
//   A) generic localhost-URL scan of PTY output
//   B) explicit `PREVIEW: <url>` marker convention
//   C) harness-side port polling via lsof
// Reports detection latency for each.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = `http://localhost:${process.env.HARNESS_PORT || 7240}`;
const WS = BASE.replace('http', 'ws') + '/ws';
const api = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const PORT_A = 8941, PORT_B = 8942, PORT_C = 8943;
const events = [];
const ws = new WebSocket(WS);
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  if (m.t === 'preview') events.push({ url: m.url, via: m.via, at: Date.now() });
};
await new Promise((r) => { ws.onopen = r; });

function lsofHit(port) {
  return new Promise((res) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], (e, out) => res(!e && out.includes('LISTEN')));
  });
}
async function pollPort(port, t0) {
  let tries = 0;
  while (Date.now() - t0 < 8000) {
    tries++;
    if (await lsofHit(port)) return { ms: Date.now() - t0, tries };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ms: null, tries };
}
const found = (port) => events.find((e) => e.url.includes(`:${port}`));

// case A: python http.server prints its own URL -> generic scan should catch it
let t0 = Date.now();
const lsofA = pollPort(PORT_A, t0);
await api('/api/terminal.write', { data: `cd /tmp/site && python3 -m http.server ${PORT_A} >/dev/null &\n` });
// ^ stdout suppressed on purpose? No: keep output visible so the scan has something to read — run again without suppression:
await api('/api/terminal.write', { data: `python3 -m http.server ${PORT_B} --directory /tmp/site &\n` });
const tB = Date.now();
const lsofB = pollPort(PORT_B, tB);
// case B: PREVIEW marker for a URL printed by convention
const tMarker = Date.now();
await api('/api/terminal.write', { data: `echo "PREVIEW: http://localhost:${PORT_C}/my-preview"\n` });
const lsofC = pollPort(PORT_C, t0);

await new Promise((r) => setTimeout(r, 4000));
ws.close();
const res = {
  scan_dev_server: { url: found(PORT_B)?.url ?? null, detect_ms: found(PORT_B) ? found(PORT_B).at - tB : null },
  explicit_marker: { url: found(PORT_C)?.url ?? null, detect_ms: found(PORT_C) ? found(PORT_C).at - tMarker : null },
  lsof_poll_A: await lsofA,
  lsof_poll_B: await lsofB,
  lsof_poll_silent_C: await lsofC, // nothing listens on PORT_C -> should time out/null
  all_events: events,
};
writeFileSync(new URL('../results/preview-discovery.json', import.meta.url), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
process.exit(0);
