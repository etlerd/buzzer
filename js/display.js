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
  const voices = BZ.voiceStore(room, () => {
    document.body.dataset.voices = voices.ready().join(' ');  // for checking setup
  });
  // p.voice is the buzzer sound the admin matched to this player (by name, or assigned by hand)
  function playVoice(slug, delayMs) { if (soundOn && slug) voices.playSlug(slug, delayMs).catch((e) => console.warn('name playback blocked', e)); }
  const voiceOf = (p) => (p ? p.voice || BZ.voiceSlug(p.name) : '');

  function render(s) {
    const stage = $('stage');
    if (!s) {
      stage.className = 'stage';
      $('phase').textContent = 'Waiting for host';
      $('winner').textContent = '';
      $('board').innerHTML = '';
      return;
    }
    const byId = Object.fromEntries((s.players || []).map((p) => [p.id, p]));

    // sounds + flashes on transitions only
    if (prev) {
      if (s.phase === 'armed' && (prev.phase !== 'armed' || prev.armId !== s.armId)) play('armed');
      const newWinner = s.phase === 'buzzed' && s.winner && (prev.phase !== 'buzzed' || prev.winner !== s.winner);
      const newResult = s.result && (!prev.result || prev.result.n !== s.result.n);
      const winnerVoice = newWinner ? voiceOf(byId[s.winner]) : '';
      // the player's own buzzer sound replaces the standard buzz; no sound loaded -> standard buzz
      if (newWinner && !newResult) { if (voices.hasSlug(winnerVoice)) playVoice(winnerVoice, 0); else play('buzz'); }
      if (newWinner && newResult) playVoice(winnerVoice, 800);  // wrong -> next in line
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
    const list = [...(s.players || [])].sort((a, b) => a.slot - b.slot);
    $('board').innerHTML = list.map((p) => `
      <li style="${p.online ? '' : 'opacity:.4'}">
        <span class="dot" style="background:${esc(p.color)}"></span>
        <span class="n">${esc(p.name)}</span>
      </li>`).join('');
  }

  const client = BZ.connect({
    role: 'display',
    onStatus: (s) => BZ.setStatusBadge($('status'), s),
    onConnect: () => client.subscribe([topic(room, 'state'), topic(room, 'say'), topic(room, 'voice/#')], { qos: 1 }),
  });
  client.on('message', (t, payload) => {
    if (t.endsWith('/state')) render(BZ.parse(payload));
    else if (t.endsWith('/say')) { const m = BZ.parse(payload); if (m) playVoice(m.slug, 0); }
    else voices.handle(t, payload);
  });
})();
