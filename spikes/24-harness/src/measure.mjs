// Spike #24 — latency measurement.
// Frames are buffered with their arrival timestamp first, then decoded
// offline — so decode cost never inflates the measurement.
// e2e latency = arrival time - time encoded in the frame pixels (the /demo
// page encodes Date.now() as 14 binary cells: 4 bits s·mod16 + 10 bits ms).
// click→pixel = REST click dispatch → first arrived frame whose indicator
// pixel changed color.
import jpeg from 'jpeg-js';
import { writeFileSync } from 'node:fs';

const BASE = `http://localhost:${process.env.HARNESS_PORT || 7240}`;
const WS = BASE.replace('http', 'ws') + '/ws';
const SECONDS = Number(process.env.MEASURE_SECONDS || 12);
const CLICKS = 20;

const p = (arr, q) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(q * arr.length))];
const api = (path, body) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

const cellXY = (i) => [31 + 36 * i, 31];
const IND = [49, 77];
const lum = (d, w, x, y) => { const o = (y * w + x) * 4; return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; };
const px = (d, w, x, y) => { const o = (y * w + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
function decodePageTime(d, w) {
  let v = 0;
  for (let i = 0; i < 14; i++) { const [x, y] = cellXY(i); v = (v << 1) | (lum(d, w, x, y) > 128 ? 1 : 0); }
  const s4 = v >> 10, ms10 = v & 1023;
  return ms10 > 999 ? null : s4 * 1000 + ms10;
}
await api('/api/browser.open', { url: BASE + '/demo' });
await new Promise((r) => setTimeout(r, 1000));

const frames = []; // {recv, sentAt, jpeg}
const clickMarks = [];
const ws = new WebSocket(WS);
ws.binaryType = 'arraybuffer';
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') return;
  const recv = Date.now();
  const buf = Buffer.from(ev.data);
  frames.push({ recv, sentAt: Number(buf.readBigUInt64BE(0)), jpeg: buf.subarray(8) });
};
await new Promise((r) => { ws.onopen = r; });

console.log(`collecting ${SECONDS}s of screencast frames...`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));

// click→pixel phase — mark each click, find its frame later
let indBaseline = null;
for (let i = 0; i < CLICKS; i++) {
  await new Promise((r) => setTimeout(r, 400));
  clickMarks.push({ t: Date.now() });
  await api('/api/browser.click', { selector: '#bump' });
}
await new Promise((r) => setTimeout(r, 2000));
ws.close();

// ---- offline decode ----
const lat = [], gaps = [], ages = [], indTimeline = [];
let undecodable = 0;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  if (i) gaps.push(f.recv - frames[i - 1].recv);
  ages.push(f.recv - f.sentAt);
  const img = jpeg.decode(f.jpeg, { maxMemoryUsageInMB: 300 });
  const pt = decodePageTime(img.data, img.width);
  if (pt === null) undecodable++;
  else lat.push((now16FromRecv(f.recv) - pt + 16000) % 16000);
  indTimeline.push({ recv: f.recv, color: px(img.data, img.width, IND[0], IND[1]).join(',') });
}
function now16FromRecv(t) { return ((Math.floor(t / 1000) % 16) * 1000) + (t % 1000); }

const clicks = [];
for (const m of clickMarks) {
  const before = indTimeline.filter((f) => f.recv < m.t).at(-1)?.color;
  const after = indTimeline.find((f) => f.recv >= m.t && f.color !== before);
  if (before && after) clicks.push(after.recv - m.t);
}

const res = {
  seconds: SECONDS,
  frames: frames.length,
  undecodableFrames: undecodable,
  e2e_visual_ms: lat.length ? { p50: p(lat, 0.5), p95: p(lat, 0.95), max: Math.max(...lat) } : null,
  frame_gap_ms: { p50: p(gaps, 0.5), p95: p(gaps, 0.95), mean: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) },
  transport_age_ms: { p50: p(ages, 0.5), p95: p(ages, 0.95), max: Math.max(...ages) },
  click_to_pixel_ms: clicks.length ? { n: clicks.length, p50: p(clicks, 0.5), p95: p(clicks, 0.95), max: Math.max(...clicks) } : { n: 0 },
};
writeFileSync(new URL('../results/latency.json', import.meta.url), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
process.exit(0);
