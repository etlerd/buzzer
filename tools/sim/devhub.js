// Computer stand-in for the hub: runs the real game logic (sim binary) and
// serves the web pages, the admin page, uploads and a virtual-pods page.
// Lets you rehearse the host and display screens with no hardware.
//
//   cd tools/sim && npm install && npm run build && npm start
//   then open http://localhost:8080/  (host), /display.html, /pods.html (virtual buttons)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(__dirname, '../../web');
const VOICE_DIR = path.resolve(process.env.VOICE_DIR || path.join(__dirname, 'voices'));
const SIM = process.env.SIM_BIN || path.join(__dirname, 'sim');
fs.mkdirSync(VOICE_DIR, { recursive: true });

// ---------- game logic process ----------
const sim = spawn(SIM, [VOICE_DIR], { stdio: ['pipe', 'pipe', 'inherit'] });
sim.on('exit', (code) => { console.error('sim exited', code); process.exit(1); });
let lastState = null;
let lastFrame = null;
let buf = '';
sim.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.includes('"t":"state"')) lastState = line;
    if (line.includes('"t":"frame"')) lastFrame = line;
    if (line.includes('"t":"sound"')) console.log('aux jack would play:', line);
    for (const c of wss.clients) if (c.readyState === 1) c.send(line);
  }
});
const toSim = (line) => sim.stdin.write(line.replace(/\n/g, ' ') + '\n');

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.json': 'application/json' };

function adminPage() {
  const src = fs.readFileSync(path.resolve(__dirname, '../../firmware/hub/admin_page.h'), 'utf8');
  return src.slice(src.indexOf('R"HTML(') + 7, src.indexOf(')HTML"'));
}

function readBody(req) {
  return new Promise((res) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => res(Buffer.concat(parts))); });
}

// minimal multipart/form-data: first file part
function firstFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const start = body.indexOf(boundary);
  const headEnd = body.indexOf('\r\n\r\n', start);
  const end = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headEnd);
  if (start < 0 || headEnd < 0 || end < 0) return null;
  return body.subarray(headEnd + 4, end);
}

function safe(p) { return typeof p === 'string' && p.startsWith('/') && !p.includes('..') && p.length < 64; }
// voice clips live in VOICE_DIR; everything else is read-only from web/
function voicePath(p) { return path.join(VOICE_DIR, path.basename(p)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/admin') { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(adminPage()); }
    if (p === '/api/files') {
      const files = fs.readdirSync(VOICE_DIR).map((f) => ({ path: '/voice/' + f, size: fs.statSync(path.join(VOICE_DIR, f)).size }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ version: 'simulator', total: 10e6, used: files.reduce((a, f) => a + f.size, 0), files }));
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const target = url.searchParams.get('path');
      const data = firstFile(await readBody(req), req.headers['content-type']);
      if (!safe(target) || !data) { res.writeHead(400); return res.end('upload failed'); }
      if (target.startsWith('/voice/')) { fs.writeFileSync(voicePath(target), data); toSim('{"c":"voices"}'); }
      else console.log(`(simulator ignores web file upload: ${target}, ${data.length} bytes)`);
      res.writeHead(200); return res.end('ok');
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const target = url.searchParams.get('path');
      if (safe(target) && target.startsWith('/voice/')) { try { fs.unlinkSync(voicePath(target)); } catch (e) { /* missing */ } toSim('{"c":"voices"}'); }
      res.writeHead(200); return res.end('ok');
    }
    if (p.startsWith('/voice/')) {
      const f = voicePath(p);
      if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(fs.readFileSync(f)); }
    }
    let file = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
    if (p === '/pods.html') file = path.join(__dirname, 'pods.html');
    if (!file.startsWith(ROOT) && p !== '/pods.html') { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

// ---------- WebSocket (same messages as the hub's port 81) ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  if (lastState) ws.send(lastState);
  if (lastFrame) ws.send(lastFrame);
  ws.on('message', (m) => toSim(String(m)));
});

server.listen(PORT, () => {
  console.log(`Simulated hub: http://localhost:${PORT}/  ·  display: /display.html  ·  virtual pods: /pods.html  ·  admin: /admin`);
});
