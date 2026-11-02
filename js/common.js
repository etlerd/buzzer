// Shared helpers: configuration, MQTT connection, topics, storage, sound.
// All pages talk through one MQTT broker. Topic layout (ROOM = room code):
//   gsbuzz/v1/ROOM/state   retained  host -> everyone   full game state (JSON)
//   gsbuzz/v1/ROOM/voice/… retained  admin -> display    name recordings (see admin.js)
//   gsbuzz/v1/ROOM/say               admin -> display    play a name now (test button)
//   gsbuzz/v1/ROOM/hello             player -> host     join + heartbeat {id,name}
//   gsbuzz/v1/ROOM/buzz              player -> host     {id, armId, rt}
(function () {
  const DEFAULT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  const PREFIX = 'gsbuzz/v1';
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  const params = new URLSearchParams(location.search);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('gsbuzz.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('gsbuzz.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
    del(key) {
      try { localStorage.removeItem('gsbuzz.' + key); } catch (e) { /* ignore */ }
    },
  };

  function brokerUrl() {
    return params.get('broker') || store.get('broker', '') || DEFAULT_BROKER;
  }

  function cleanRoom(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  function newRoomCode(len = 5) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('');
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function topic(room, sub) {
    return `${PREFIX}/${room}/${sub}`;
  }

  // Connect to the broker. onStatus receives 'connecting' | 'online' | 'offline'.
  function connect({ role, will, onStatus, onConnect }) {
    const opts = {
      clientId: `gsbuzz-${role}-${newId()}`,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 1500,
      connectTimeout: 8000,
    };
    const user = params.get('user') || store.get('brokerUser', '');
    const pass = params.get('pass') || store.get('brokerPass', '');
    if (user) { opts.username = user; opts.password = pass; }
    if (will) opts.will = will;

    const client = mqtt.connect(brokerUrl(), opts);
    const status = (s) => onStatus && onStatus(s);
    status('connecting');
    client.on('connect', () => { status('online'); onConnect && onConnect(); });
    client.on('reconnect', () => status('connecting'));
    client.on('offline', () => status('offline'));
    client.on('close', () => status('offline'));
    client.on('error', (err) => console.warn('MQTT error', err && err.message));
    return client;
  }

  function parse(payload) {
    try {
      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      return text ? JSON.parse(text) : null;
    } catch (e) { return null; }
  }

  // Short synthesized sounds; no audio files needed.
  let audioCtx = null;
  function audio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function tone(freq, ms, type = 'square', gain = 0.15, delay = 0) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay / 1000;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }
  const sounds = {
    unlock() { audio(); },
    buzz() { tone(220, 450, 'sawtooth', 0.2); tone(110, 450, 'square', 0.12); },
    armed() { tone(880, 90, 'sine', 0.15); tone(1320, 120, 'sine', 0.15, 100); },
    correct() { tone(660, 120, 'triangle', 0.2); tone(880, 120, 'triangle', 0.2, 120); tone(1320, 260, 'triangle', 0.2, 240); },
    wrong() { tone(160, 600, 'sawtooth', 0.2); },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Build a URL for another page in this site, carrying room and custom broker settings.
  function pageUrl(page, room) {
    const url = new URL(page, location.href);
    url.search = '';
    if (room) url.searchParams.set('room', room);
    const b = brokerUrl();
    if (b !== DEFAULT_BROKER) url.searchParams.set('broker', b);
    return url.toString();
  }

  function renderQr(el, text) {
    if (!window.qrcode || !el) return;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  // File key for a player's name recording: "Mary-Jo O'Neil" -> "maryjooneil"
  function voiceSlug(name) {
    let s = '';
    for (const ch of String(name || '')) {
      if (ch >= 'A' && ch <= 'Z') s += ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) s += ch;
      if (s.length >= 24) break;
    }
    return s;
  }

  // Collects name recordings arriving over MQTT and decodes them for playback.
  //   voice/<slug>            retained manifest {id, n, bytes} (empty = deleted)
  //   voice/<slug>/<id>/<i>   retained WAV bytes, chunk i of n
  // onChange(slug, ready) fires when a clip becomes playable or is removed.
  function voiceStore(room, onChange) {
    const prefix = topic(room, 'voice/');
    const manifests = {};
    const chunks = {};
    const clips = {};

    async function assemble(slug) {
      const m = manifests[slug];
      if (!m || (clips[slug] && clips[slug].id === m.id)) return;
      const key = slug + '/' + m.id;
      const list = chunks[key] || [];
      for (let i = 0; i < m.n; i++) if (!list[i]) return;  // still arriving
      const wav = new Uint8Array(m.bytes);
      let off = 0;
      for (const c of list) { wav.set(c, off); off += c.length; }
      delete chunks[key];
      try {
        const ctx = audio();
        const buffer = await new Promise((res, rej) => {
          const p = ctx.decodeAudioData(wav.buffer, res, rej);
          if (p && p.then) p.then(res, rej);
        });
        clips[slug] = { id: m.id, buffer };
        onChange && onChange(slug, true);
      } catch (e) {
        console.warn('could not decode voice for', slug);
      }
    }

    return {
      manifests,
      handle(t, payload) {
        if (!t.startsWith(prefix)) return;
        const parts = t.slice(prefix.length).split('/');
        const slug = parts[0];
        if (parts.length === 1) {
          const m = parse(payload);
          if (m && m.id) manifests[slug] = m;
          else {
            delete manifests[slug];
            if (clips[slug]) { delete clips[slug]; onChange && onChange(slug, false); }
          }
        } else if (parts.length === 3 && payload.length) {
          const key = slug + '/' + parts[1];
          (chunks[key] = chunks[key] || [])[Number(parts[2])] = new Uint8Array(payload);
        }
        assemble(slug);
      },
      has(name) { return !!clips[voiceSlug(name)]; },
      pending(name) { const s = voiceSlug(name); return !!manifests[s] && !clips[s]; },
      ready() { return Object.keys(clips); },
      play(name, delayMs = 0) {
        const clip = clips[voiceSlug(name)];
        const ctx = audio();
        if (!clip || !ctx) return false;
        const src = ctx.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(ctx.destination);
        src.start(ctx.currentTime + delayMs / 1000);
        return true;
      },
    };
  }

  function setStatusBadge(el, s) {
    if (!el) return;
    el.dataset.status = s;
    el.textContent = s === 'online' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Offline';
  }

  window.BZ = {
    DEFAULT_BROKER, PREFIX, params, store, brokerUrl, cleanRoom, newRoomCode, newId,
    topic, connect, parse, sounds, esc, pageUrl, renderQr, setStatusBadge, voiceSlug, audioContext: audio, voiceStore,
  };
})();
