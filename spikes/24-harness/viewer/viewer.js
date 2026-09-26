// Spike #24 viewer: paints screencast frames, forwards input to the harness,
// renders the shared PTY via xterm.js, and shows the agent activity feed.
// The WebSocket auto-reconnects: closing this window never kills the harness,
// and a reconnect replays the last frame + terminal backlog.
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const feedEl = document.getElementById('feed');
const statsEl = document.getElementById('stats');
const metaEl = document.getElementById('pagemeta');
const pvEl = document.getElementById('previews');
const termEl = document.getElementById('term');
const liveEl = document.getElementById('live');

const term = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 12 });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(termEl);
term.focus();

let ws = null;
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
term.onData((d) => send({ t: 'term-in', d }));

let frames = 0, ageSum = 0, ageN = 0, lastStat = Date.now();

function addFeed(tool, args, at) {
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${at}</span> <b>${tool}</b> ${args ? escapeHtml(JSON.stringify(args)).slice(0, 120) : ''}`;
  feedEl.prepend(div);
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function paintFrame(buf) {
  const dv = new DataView(buf);
  const sentAt = Number(dv.getBigUint64(0));
  const bmp = await createImageBitmap(new Blob([buf.slice(8)], { type: 'image/jpeg' }));
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  frames++; ageSum += Date.now() - sentAt; ageN++;
}

function onMessage(ev) {
  if (typeof ev.data !== 'string') return paintFrame(ev.data);
  const m = JSON.parse(ev.data);
  if (m.t === 'term' || m.t === 'term-snapshot') term.write(m.d);
  else if (m.t === 'action') addFeed(m.tool, m.args, m.at);
  else if (m.t === 'page') metaEl.textContent = `${m.title || ''} — ${m.url}`;
  else if (m.t === 'preview') renderPreview(m.url, m.via);
  else if (m.t === 'previews') m.list.forEach((p) => renderPreview(p.url, p.via));
  else if (m.t === 'term-dead') addFeed('terminal', 'process exited', '');
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { liveEl.textContent = 'LIVE'; liveEl.classList.remove('off'); };
  ws.onmessage = onMessage;
  ws.onclose = () => { liveEl.textContent = 'OFFLINE'; liveEl.classList.add('off'); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}
connect();

function renderPreview(url, via) {
  if (pvEl.querySelector(`a[href="${url}"]`)) return;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank';
  a.textContent = `preview ${via === 'marker' ? '★' : '🔎'} ${url}`;
  pvEl.appendChild(a);
}

// input → harness (browser page)
function toPageCoords(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.round((e.offsetX * canvas.width) / r.width), y: Math.round((e.offsetY * canvas.height) / r.height) };
}
canvas.addEventListener('mousedown', (e) => {
  const p = toPageCoords(e);
  const r = canvas.getBoundingClientRect();
  metaEl.textContent = `click → page ${p.x},${p.y} (canvas css ${r.width.toFixed(0)}x${r.height.toFixed(0)} @ ${r.left.toFixed(0)},${r.top.toFixed(0)})`;
  send({ t: 'mouse', kind: 'down', ...p });
});
canvas.addEventListener('mouseup', (e) => send({ t: 'mouse', kind: 'up', ...toPageCoords(e) }));
canvas.addEventListener('mousemove', (e) => { if (e.buttons & 1) send({ t: 'mouse', kind: 'move', ...toPageCoords(e) }); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); send({ t: 'wheel', dy: e.deltaY }); }, { passive: false });
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('#term')) return; // xterm handles its own
  if (e.metaKey || e.ctrlKey || e.altKey) return; // keep browser shortcuts local
  const text = e.key.length === 1 ? e.key : undefined;
  send({ t: 'key', key: e.key, code: e.code, text });
});

setInterval(() => {
  const dt = (Date.now() - lastStat) / 1000;
  statsEl.textContent = `~${(frames / dt).toFixed(0)} fps · frame age ~${ageN ? (ageSum / ageN).toFixed(0) : '-'} ms`;
  frames = 0; ageSum = 0; ageN = 0; lastStat = Date.now();
}, 1000);
