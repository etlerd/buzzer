// Connection to the hub.
//   Served by the hub (http://192.168.4.1): WebSocket on port 81.
//   Opened as a local file on the host laptop: USB cable (Web Serial, Chrome/Edge),
//   and display windows on the same laptop receive state via BroadcastChannel.
// Both paths carry the same JSON messages.
window.Link = (function () {
  const params = new URLSearchParams(location.search);
  const local = location.protocol === 'file:' && !params.get('hub');
  // The hub serves pages on port 80 and WebSocket on 81. The computer simulator
  // (tools/sim) serves both on one port, with the socket at /ws.
  const wsUrl = params.get('hub') || (location.port
    ? `ws://${location.host}/ws`
    : `ws://${location.hostname || '192.168.4.1'}:81/`);
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('gsbuzz') : null;

  let handlers = {};
  let ws = null;
  let writer = null;
  let lastState = null;
  let status = 'connecting';

  function setStatus(s) {
    status = s;
    handlers.onStatus && handlers.onStatus(s);
  }

  function receive(msg, fromUsb) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'state') {
      lastState = msg;
      handlers.onState && handlers.onState(msg);
      if (fromUsb && bc) bc.postMessage(msg);  // feed display windows on this laptop
    } else if (msg.t === 'error') {
      handlers.onError && handlers.onError(msg.msg);
    }
  }

  // ---------- Wi-Fi ----------
  function openWs() {
    setStatus('connecting');
    ws = new WebSocket(wsUrl);
    ws.onopen = () => setStatus('online');
    ws.onmessage = (e) => { try { receive(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
    ws.onclose = () => { setStatus('offline'); setTimeout(openWs, 1000); };
    ws.onerror = () => ws.close();
  }

  // ---------- USB ----------
  async function connectUsb() {
    if (!('serial' in navigator)) throw new Error('This browser has no USB serial support. Use Chrome or Edge.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    setStatus('online');
    const enc = new TextEncoderStream();
    enc.readable.pipeTo(port.writable);
    writer = enc.writable.getWriter();
    send({ c: 'hello' });
    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith('{')) { try { receive(JSON.parse(line), true); } catch (err) { /* partial line */ } }
        }
      }
    } finally {
      writer = null;
      setStatus('offline');
    }
  }

  function send(cmd) {
    const text = JSON.stringify(cmd);
    if (ws && ws.readyState === 1) ws.send(text);
    else if (writer) writer.write(text + '\n');
    else return false;
    return true;
  }

  function start(h) {
    handlers = h;
    if (!local) { openWs(); return; }
    if (h.role === 'host') {
      setStatus('usb');
      // a display window opened later asks for the current state
      if (bc) bc.onmessage = (e) => { if (e.data === 'want-state' && lastState) bc.postMessage(lastState); };
    } else {
      setStatus('connecting');
      if (bc) {
        bc.onmessage = (e) => { if (e.data && e.data.t) { setStatus('online'); receive(e.data); } };
        bc.postMessage('want-state');
      }
    }
  }

  return {
    start, send, connectUsb,
    get local() { return local; },
    get canUpload() { return !local; },
    get status() { return status; },
  };
})();

// Shared helpers
window.esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

// Must match gs::voiceSlug() in the hub firmware.
window.voiceSlug = function (name) {
  let s = '';
  for (const ch of String(name)) {
    if (ch >= 'A' && ch <= 'Z') s += ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) s += ch;
    if (s.length >= 24) break;
  }
  return s;
};

window.setStatusBadge = function (el, s) {
  el.dataset.status = s === 'usb' ? 'offline' : s;
  el.textContent = { online: 'Connected', connecting: 'Connecting…', offline: 'Disconnected', usb: 'Not connected' }[s] || s;
};
