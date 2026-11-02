// Studio display: big screen for a TV or projector. Also the sound source:
// game sounds and recorded names play from this page, so route this
// computer's audio output to the recording interface.
(function () {
  const { topic, esc, sounds } = BZ;
  const $ = (id) => document.getElementById(id);
  const room = BZ.cleanRoom(BZ.params.get('room')) || BZ.store.get('hostRoom', '');
  const hideQr = BZ.params.get('qr') === '0';

  let soundOn = false;
  let prev = null;

  if (!room) {
    $('phase').textContent = 'Add ?room=CODE to the address';
    $('soundGate').classList.add('hidden');
    return;
  }

  $('room').textContent = room;
  BZ.renderQr($('qr'), BZ.pageUrl('play.html', room));
  // Join code: ✕ hides it (remembered on this computer per room); "Show join code" brings it back.
  // ?qr=0 in the address starts with it hidden.
  const qrKey = 'displayHideQr.' + room;
  function setQrHidden(hidden) {
    $('join').classList.toggle('hidden', hidden);
    $('btnShowQr').classList.toggle('hidden', !hidden);
    BZ.store.set(qrKey, hidden);
  }
  setQrHidden(hideQr || BZ.store.get(qrKey, false));
  $('btnHideQr').onclick = () => setQrHidden(true);
  $('btnShowQr').onclick = () => setQrHidden(false);

  $('btnSound').onclick = () => {
    soundOn = true;
    sounds.unlock();
    $('soundGate').classList.add('hidden');
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  };

  function play(name) { if (soundOn) sounds[name](); }

  // ---------- recorded names ----------
  const manifests = {};  // slug -> {id, n, bytes}
  const chunks = {};     // "slug/id" -> [Uint8Array]
  const clips = {};      // slug -> {id, buffer}

  function onVoice(t, payload) {
    const parts = t.slice(topic(room, 'voice/').length).split('/');
    const slug = parts[0];
    if (parts.length === 1) {
      const m = BZ.parse(payload);
      if (m && m.id) manifests[slug] = m;
      else { delete manifests[slug]; delete clips[slug]; }
    } else if (parts.length === 3 && payload.length) {
      const key = slug + '/' + parts[1];
      (chunks[key] = chunks[key] || [])[Number(parts[2])] = new Uint8Array(payload);
    }
    assemble(slug);
  }

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
      const ctx = BZ.audioContext();
      const buffer = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(wav.buffer, res, rej);
        if (p && p.then) p.then(res, rej);
      });
      clips[slug] = { id: m.id, buffer };
      document.body.dataset.voices = Object.keys(clips).join(' ');  // for checking setup
    } catch (e) {
      console.warn('could not decode voice for', slug);
    }
  }

  function playName(name, delayMs) {
    const clip = clips[BZ.voiceSlug(name)];
    if (!soundOn || !clip) return;
    const ctx = BZ.audioContext();
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.connect(ctx.destination);
    src.start(ctx.currentTime + delayMs / 1000);
  }

  function render(s) {
    const stage = $('stage');
    if (!s) {
      stage.className = 'stage';
      $('phase').textContent = 'Waiting for host';
      $('winner').textContent = '';
      $('question').textContent = '';
      $('board').innerHTML = '';
      return;
    }
    const byId = Object.fromEntries((s.players || []).map((p) => [p.id, p]));

    // sounds + flashes on transitions only
    if (prev) {
      if (s.phase === 'armed' && (prev.phase !== 'armed' || prev.armId !== s.armId)) play('armed');
      const newWinner = s.phase === 'buzzed' && s.winner && (prev.phase !== 'buzzed' || prev.winner !== s.winner);
      const newResult = s.result && (!prev.result || prev.result.n !== s.result.n);
      const winnerName = newWinner && byId[s.winner] ? byId[s.winner].name : '';
      if (newWinner && !newResult) { play('buzz'); playName(winnerName, 500); }
      if (newWinner && newResult) playName(winnerName, 800);  // wrong -> next in line
      if (newResult) {
        play(s.result.ok ? 'correct' : 'wrong');
        const r = $('result');
        r.className = 'result';
        void r.offsetWidth;
        r.className = 'result ' + (s.result.ok ? 'ok' : 'bad');
      }
    }
    prev = s;

    stage.className = 'stage' + (s.phase === 'armed' ? ' armed' : '');
    const w = byId[s.winner];
    if (s.phase === 'armed') {
      $('phase').textContent = 'Buzzers open';
      $('winner').textContent = '';
    } else if (s.phase === 'buzzed' && w) {
      $('phase').textContent = 'Buzzed in';
      $('winner').textContent = w.name;
      $('winner').style.color = w.color;
    } else if (s.result && byId[s.result.id]) {
      $('phase').textContent = s.result.ok ? 'Correct!' : 'Wrong';
      $('winner').textContent = byId[s.result.id].name;
      $('winner').style.color = s.result.ok ? 'var(--ok)' : 'var(--bad)';
    } else {
      $('phase').textContent = 'Get ready';
      $('winner').textContent = '';
    }
    $('question').textContent = s.question || '';

    const ranked = [...(s.players || [])].sort((a, b) => b.score - a.score || a.slot - b.slot);
    $('board').innerHTML = ranked.map((p) => `
      <li style="${p.online ? '' : 'opacity:.4'}">
        <span class="dot" style="background:${esc(p.color)}"></span>
        <span class="n">${esc(p.name)}</span>
        <span class="score">${p.score}</span>
      </li>`).join('');
  }

  const client = BZ.connect({
    role: 'display',
    onStatus: (s) => BZ.setStatusBadge($('status'), s),
    onConnect: () => client.subscribe([topic(room, 'state'), topic(room, 'say'), topic(room, 'voice/#')], { qos: 1 }),
  });
  client.on('message', (t, payload) => {
    if (t.endsWith('/state')) render(BZ.parse(payload));
    else if (t.endsWith('/say')) { const m = BZ.parse(payload); if (m) playName(m.slug, 0); }
    else onVoice(t, payload);
  });
})();
