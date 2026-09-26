// Spike #24 — harness daemon.
// Owns: one headless Chromium page (via Playwright + raw CDP screencast),
// one PTY shell (node-pty), a tiny HTTP+WS server for viewers, and a JSON
// API that the MCP shim (mcp-server.mjs) and measurement scripts call.
// Viewers are stateless: closing the tab kills nothing — the browser page
// and the shell live here.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import * as pty from 'node-pty';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HARNESS_PORT || 7240);
const VIEW_W = 1280;
const VIEW_H = 800;
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 60);
const EVERY_NTH = Number(process.env.SCREENCAST_EVERY_NTH || 1);

const __dirname = ROOT;
const NM = path.join(ROOT, '..', 'node_modules');

// ---------- static assets ----------
const VIEWER = path.join(ROOT, '..', 'viewer');
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/viewer.js': ['viewer.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};
const XTERM = {
  '/xterm/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/xterm/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  '/xterm/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};

const DEMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Harness demo page</title>
<style>
body{font:14px/1.4 -apple-system,system-ui,sans-serif;margin:0;background:#0e1116;color:#e6e6e6}
.pad{padding:24px}
#clockbar{position:fixed;top:16px;left:16px;display:flex;gap:6px}
#clockbar .c{width:30px;height:30px;background:#000;border:1px solid #333;border-radius:4px}
#ind{position:fixed;top:62px;left:16px;width:66px;height:30px;background:#3a3a3a;border-radius:4px}
#clock{position:fixed;top:100px;left:16px;font:600 22px ui-monospace,monospace;color:#7ee787}
h1{font-size:18px;margin:8px 0 16px}
button{padding:22px 30px;font-size:20px;border-radius:8px;border:0;background:#2f81f7;color:#fff;cursor:pointer}
input{padding:8px;font-size:14px;border-radius:6px;border:1px solid #444;background:#161b22;color:#e6e6e6}
#echo{font:600 16px ui-monospace,monospace;color:#ffa657;min-height:20px}
ul{font:12px ui-monospace,monospace;max-height:220px;overflow:auto;padding-left:18px;color:#9da7b3}
</style></head><body>
<div id="clockbar"></div><div id="ind"></div><div id="clock">-</div>
<div class="pad" style="padding-top:140px">
<h1>Harness-owned page <span id="cnt">0</span></h1>
<button id="bump">Bump (agent clicks me)</button>
<p><input id="echo-in" placeholder="agent types here" size="30"> <span id="echo"></span></p>
<ul id="log"></ul>
</div>
<script>
const cells=[];for(let i=0;i<14;i++){const d=document.createElement('div');d.className='c';cells.push(d);document.getElementById('clockbar').appendChild(d)}
function paint(){const t=Date.now();const v=((Math.floor(t/1000)&0xF)<<10)|(t%1000);
for(let i=0;i<14;i++)cells[i].style.background=(v>>(13-i))&1?'#fff':'#000';
document.getElementById('clock').textContent='page t='+t+'ms';requestAnimationFrame(paint)}
requestAnimationFrame(paint);
const log=(m)=>{const li=document.createElement('li');li.textContent=new Date().toISOString().slice(11,23)+' '+m;document.getElementById('log').prepend(li)};
let n=0,ind=false;
document.getElementById('bump').onclick=()=>{n++;document.getElementById('cnt').textContent=n;
ind=!ind;document.getElementById('ind').style.background=ind?'#ffd400':'#6a00ff';log('click #'+n)};
document.getElementById('echo-in').addEventListener('input',e=>{document.getElementById('echo').textContent=e.target.value;});
document.addEventListener('click',e=>{log('doc click @'+e.pageX+','+e.pageY);
const d=document.createElement('div');d.style.cssText='position:fixed;left:'+(e.pageX-6)+'px;top:'+(e.pageY-6)+'px;width:12px;height:12px;border:2px solid #ff5470;border-radius:50%;pointer-events:none';document.body.appendChild(d);});
log('page ready');
</script></body></html>`;

// ---------- state ----------
let browser, context, page, cdp;
let casting = false;
let lastFrame = null; // Buffer: jpeg bytes
const viewers = new Set(); // ws clients
let term; // node-pty
const TERM_REPLAY_LIMIT = 400 * 1024;
let termBuf = [];
let termBufSize = 0;
const previews = new Map(); // url -> {url, via, at}
let runSeq = 0;
const pendingRuns = new Map(); // marker -> {resolve, out, cmd}
const MAX_RUN_MS = 15000;
let shuttingDown = false;

// ---------- helpers ----------
const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-2]|[\x00-\x08\x0b-\x1f]|\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]/g, '');

function broadcast(obj, binary) {
  const data = binary ? obj : JSON.stringify(obj);
  for (const ws of viewers) if (ws.readyState === ws.OPEN) ws.send(data, { binary });
}
function action(tool, args) {
  broadcast({ t: 'action', tool, args, at: new Date().toISOString().slice(11, 23) });
}
function sendFrame(jpegBuf) {
  lastFrame = jpegBuf;
  const hdr = Buffer.alloc(8);
  hdr.writeBigUInt64BE(BigInt(Date.now()));
  broadcast(Buffer.concat([hdr, jpegBuf]), true);
}
function notePreview(url, via) {
  const u = url.replace(/\/+$/, '');
  if (!u.startsWith('http')) return;
  if (previews.has(u)) return;
  previews.set(u, { url: u, via, at: Date.now() });
  broadcast({ t: 'preview', url: u, via });
}
let scanTail = '';
function scanForUrls(chunk) {
  // PTY output arrives in arbitrary chunks — scan with a carry window so a
  // URL split across chunks is still matched whole.
  const s = scanTail + chunk;
  scanTail = s.slice(-300);
  let m;
  const marker = /PREVIEW:\s*(https?:\/\/[^\s"'\])}]+)/g;
  while ((m = marker.exec(s))) {
    // defer a match that runs to the buffer end — the URL may be truncated mid-chunk
    if (m.index + m[0].length === s.length) continue;
    const url = m[1].replace(/[.,;:]+$/, '');
    if (!/:\d+|\/./.test(url)) continue; // bare host is a truncated echo, not a preview
    notePreview(url, 'marker');
  }
  const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"<>)\]}]*/g;
  while ((m = urlRe.exec(s))) {
    const url = m[0].replace(/\[::1?\]/, 'localhost').replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
    notePreview(url, 'scan');
  }
}

// ---------- PTY ----------
function startTerminal() {
  term = pty.spawn('/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 110,
    rows: 28,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  term.onData((d) => {
    termBuf.push(d);
    termBufSize += d.length;
    while (termBufSize > TERM_REPLAY_LIMIT) termBufSize -= termBuf.shift().length;
    broadcast({ t: 'term', d });
    scanForUrls(d);
    for (const r of pendingRuns.values()) r.out += d;
    for (const [id, r] of pendingRuns) {
      // echoed input contains the markers too — match the LAST begin/end pair
      const bIdx = r.out.lastIndexOf(`__B_${id}__`);
      const eRe = new RegExp(`__E_${id}_(\\d+)__`);
      const after = bIdx >= 0 ? r.out.slice(bIdx) : '';
      const em = eRe.exec(after);
      if (em) {
        pendingRuns.delete(id);
        const body = after.slice(`__B_${id}__`.length, em.index);
        r.resolve({ output: stripAnsi(body).replace(/^\r?\n+/, '').trim(), exitCode: Number(em[1]) });
      }
    }
  });
  term.onExit(() => {
    broadcast({ t: 'term-dead' });
    setTimeout(() => { if (!shuttingDown) startTerminal(); }, 500);
  });
}

// ---------- Browser ----------
async function startBrowser() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 1,
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    sendFrame(Buffer.from(f.data, 'base64'));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  page.on('framenavigated', () => pageMeta());
  await page.goto(`http://localhost:${PORT}/demo`);
  // a viewer may have connected before the browser was up — start casting for it now
  if (viewers.size > 0) await setCasting(true);
}
async function setCasting(on) {
  if (!cdp || casting === on) return;
  casting = on;
  try {
    if (on) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, everyNthFrame: EVERY_NTH });
    else await cdp.send('Page.stopScreencast');
  } catch {}
}
async function pageMeta() {
  try {
    broadcast({ t: 'page', url: page.url(), title: await page.title() });
  } catch {}
}

// key -> {code, windowsVirtualKeyCode} for the special keys we forward via CDP
const SPECIAL_KEYS = {
  Enter: ['Enter', 13], Backspace: ['Backspace', 8], Tab: ['Tab', 9], Escape: ['Escape', 27],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Delete: ['Delete', 46], Home: ['Home', 36], End: ['End', 35],
};
async function keyPress(key) {
  const spec = SPECIAL_KEYS[key];
  if (!spec) return;
  const [code, vk] = spec;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

// ---------- REST tool API ----------
const tools = {
  'browser.open': async (a) => { await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); await pageMeta(); return { ok: true, url: page.url(), title: await page.title() }; },
  'browser.click': async (a) => {
    if (a.selector) { await page.click(a.selector, { timeout: 8000 }); return { ok: true, via: 'selector', selector: a.selector }; }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    return { ok: true, via: 'coords', x: a.x, y: a.y };
  },
  'browser.type': async (a) => {
    if (a.selector) { await page.click(a.selector, { timeout: 8000 }); await page.fill(a.selector, ''); }
    for (const ch of a.text) await cdp.send('Input.insertText', { text: ch });
    return { ok: true, typed: a.text.length };
  },
  'browser.read': async () => {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');
    return { url: page.url(), title: await page.title(), text };
  },
  'browser.scroll': async (a) => { await page.mouse.wheel(0, a.dy ?? 400); return { ok: true }; },
  'browser.eval': async (a) => ({ value: await page.evaluate(a.expr) }),
  'terminal.run': async (a) => {
    const id = ++runSeq;
    const timeout = Math.min(a.timeout_ms ?? MAX_RUN_MS, 60000);
    const p = new Promise((resolve) => {
      const t = setTimeout(() => {
        const r = pendingRuns.get(id);
        pendingRuns.delete(id);
        resolve({ output: stripAnsi(r?.out ?? ''), timeout: true });
      }, timeout);
      pendingRuns.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, out: '' });
    });
    term.write(`printf '__B_${id}__\\n'; { ${a.command} }; rc=$?; printf '__E_${id}_%s__\\n' "$rc"\n`);
    return p;
  },
  'terminal.write': async (a) => { term.write(a.data); return { ok: true }; },
  'terminal.read': async (a) => {
    const tail = termBuf.join('').slice(-(a.bytes ?? 4000));
    return { text: stripAnsi(tail).split('\n').slice(-(a.lines ?? 60)).join('\n') };
  },
  'previews.list': async () => ({ previews: [...previews.values()] }),
  'state': async () => ({ url: page.url(), title: await page.title().catch(() => ''), viewers: viewers.size, casting, previews: previews.size, termAlive: !!term }),
};

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/demo') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(DEMO_HTML); }
    if (STATIC[u.pathname]) {
      const [f, ct] = STATIC[u.pathname];
      res.writeHead(200, { 'content-type': ct });
      return res.end(await readFile(path.join(VIEWER, f)));
    }
    if (XTERM[u.pathname]) {
      const [rel, ct] = XTERM[u.pathname];
      const fp = path.join(NM, rel);
      res.writeHead(existsSync(fp) ? 200 : 404, { 'content-type': ct });
      return res.end(existsSync(fp) ? await readFile(fp) : 'missing');
    }
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5);
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : {};
      if (!(name in tools)) { res.writeHead(404); return res.end('{"error":"unknown tool"}'); }
      const out = await tools[name](body);
      action(name, { ...body, _via: 'api' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b || '{}')); });

// ---------- WS (viewer channel) ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', async (ws) => {
  viewers.add(ws);
  ws.send(JSON.stringify({ t: 'term-snapshot', d: termBuf.join('') }));
  ws.send(JSON.stringify({ t: 'previews', list: [...previews.values()] }));
  try { ws.send(JSON.stringify({ t: 'page', url: page.url(), title: await page.title() })); } catch {}
  if (lastFrame) {
    const hdr = Buffer.alloc(8); hdr.writeBigUInt64BE(BigInt(Date.now()));
    ws.send(Buffer.concat([hdr, lastFrame]), { binary: true });
  }
  await setCasting(true);

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: m.kind === 'move' ? 'mouseMoved' : m.kind === 'down' ? 'mousePressed' : 'mouseReleased',
          x: m.x, y: m.y, button: 'left', clickCount: m.kind === 'move' ? 0 : 1,
        });
      } else if (m.t === 'key') {
        if (m.text) await cdp.send('Input.insertText', { text: m.text });
        if (m.key && (m.key.length > 1 || /[^ -~]/.test(m.key))) await keyPress(m.key);
      } else if (m.t === 'term-in') {
        term.write(m.d);
      } else if (m.t === 'wheel') {
        await page.mouse.wheel(0, m.dy);
      }
    } catch {}
  });
  ws.on('close', async () => {
    viewers.delete(ws);
    if (viewers.size === 0) await setCasting(false);
  });
});

await new Promise((r) => server.listen(PORT, r));
console.log(`harness up: viewer http://localhost:${PORT}/  (ws /ws, api /api/*)`);
await startTerminal();
await startBrowser();
process.on('SIGINT', async () => { shuttingDown = true; try { await browser.close(); } catch {} process.exit(0); });
