// Studio display: read-only big screen for a TV or projector.
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
  if (hideQr) $('join').classList.add('hidden');

  $('btnSound').onclick = () => {
    soundOn = true;
    sounds.unlock();
    $('soundGate').classList.add('hidden');
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  };

  function play(name) { if (soundOn) sounds[name](); }

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
      if (s.phase === 'buzzed' && s.winner && (prev.phase !== 'buzzed' || prev.winner !== s.winner)) play('buzz');
      if (s.result && (!prev.result || prev.result.n !== s.result.n)) {
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
    onConnect: () => client.subscribe(topic(room, 'state'), { qos: 1 }),
  });
  client.on('message', (t, payload) => render(BZ.parse(payload)));
})();
