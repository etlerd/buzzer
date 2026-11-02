// Player phone: join a room, show the buzzer, send buzzes.
// Fairness: the phone measures reaction time from the moment IT saw the buzzers
// open until the tap. Network delay in either direction does not count against
// the player when the host uses "Reaction time" mode.
(function () {
  const { store, topic, esc } = BZ;
  const $ = (id) => document.getElementById(id);
  const FALSE_START_MS = 1000;
  const HELLO_EVERY_MS = 4000;

  let myId = store.get('playerId', '');
  if (!myId) { myId = BZ.newId(); store.set('playerId', myId); }
  let room = BZ.cleanRoom(BZ.params.get('room')) || store.get('playRoom', '');
  let name = store.get('playerName', '');

  let client = null;
  let helloTimer = null;
  let state = null;
  let lastArmId = null;
  let armedAt = 0;
  let buzzedArm = null;       // armId I already buzzed in
  let penaltyUntil = 0;       // false-start lockout end (performance.now time)
  let lastResultN = null;
  let wakeLock = null;

  // ---------- join form ----------
  function showForm() {
    $('game').classList.add('hidden');
    $('joinForm').classList.remove('hidden');
    $('room').value = room;
    $('name').value = name;
    (room ? $('name') : $('room')).focus();
  }

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const newRoom = BZ.cleanRoom($('room').value);
    const newName = $('name').value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!newRoom || !newName) return;
    const roomChanged = newRoom !== room;
    room = newRoom;
    name = newName;
    store.set('playRoom', room);
    store.set('playerName', name);
    const u = new URL(location.href);
    u.searchParams.set('room', room);
    history.replaceState(null, '', u);
    if (roomChanged || !client) start();
    else { hello(); showGame(); }
  });

  // ---------- game ----------
  function showGame() {
    $('joinForm').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('me').textContent = `${name} · ${room}`;
    requestWakeLock();
    render();
  }

  function hello() {
    if (client && client.connected) {
      client.publish(topic(room, 'hello'), JSON.stringify({ id: myId, name }), { qos: 0 });
    }
  }

  function start() {
    if (client) {
      client.publish(topic(room, 'hello'), JSON.stringify({ id: myId, bye: true }));
      client.end(true);
    }
    clearInterval(helloTimer);
    state = null;
    lastArmId = null;
    showGame();
    client = BZ.connect({
      role: 'player',
      will: { topic: topic(room, 'hello'), payload: JSON.stringify({ id: myId, bye: true }), qos: 0, retain: false },
      onStatus: (s) => { BZ.setStatusBadge($('status'), s); render(); },
      onConnect: () => {
        client.subscribe(topic(room, 'state'), { qos: 1 });
        hello();
      },
    });
    client.on('message', (t, payload) => {
      if (!t.endsWith('/state')) return;
      onState(BZ.parse(payload));
    });
    helloTimer = setInterval(hello, HELLO_EVERY_MS);
  }

  function me() { return state && state.players && state.players.find((p) => p.id === myId); }

  function onState(s) {
    state = s;
    if (s && s.phase === 'armed' && s.armId !== lastArmId) {
      lastArmId = s.armId;
      armedAt = performance.now();
    }
    if (s && s.result && s.result.n !== lastResultN) {
      const first = lastResultN === null;
      lastResultN = s.result.n;
      if (!first && s.result.id === myId) flash(s.result.ok);
    }
    render();
  }

  function flash(ok) {
    const b = document.body;
    b.classList.remove('flash-ok', 'flash-bad');
    void b.offsetWidth; // restart animation
    b.classList.add(ok ? 'flash-ok' : 'flash-bad');
    if (navigator.vibrate) navigator.vibrate(ok ? [80, 60, 80] : [400]);
  }

  // ---------- buzzing ----------
  function press(e) {
    e.preventDefault();
    const btn = $('buzzer');
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 120);
    if (!state || !client || !client.connected || !me()) return;
    if ((state.excluded || []).includes(myId)) return;
    const now = performance.now();

    if (state.phase === 'armed') {
      if (buzzedArm === state.armId || now < penaltyUntil) return;
      buzzedArm = state.armId;
      const rt = Math.round(now - armedAt);
      client.publish(topic(room, 'buzz'), JSON.stringify({ id: myId, armId: state.armId, rt }), { qos: 1 });
      if (navigator.vibrate) navigator.vibrate(60);
      render();
    } else if (state.phase === 'locked') {
      // false start: short lockout so mashing the button before it opens does not pay off
      penaltyUntil = now + FALSE_START_MS;
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      render();
      setTimeout(render, FALSE_START_MS + 20);
    }
  }
  $('buzzer').addEventListener('pointerdown', press);
  $('buzzer').addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- rendering ----------
  function setButton(mode, label) {
    const b = $('buzzer');
    b.dataset.mode = mode;
    b.textContent = label;
  }
  function setInfo(html) { $('info').innerHTML = html; }

  function render() {
    if ($('game').classList.contains('hidden')) return;
    const mine = me();

    if (!client || !client.connected) { setButton('locked', 'WAIT'); setInfo('Connecting…'); return; }
    if (!state) { setButton('locked', 'WAIT'); setInfo(`Waiting for host to open room <strong class="code">${esc(room)}</strong>`); return; }
    if ((state.kicked || []).includes(myId)) { setButton('out', 'OUT'); setInfo('Removed by the host'); return; }
    if (!mine) { setButton('locked', 'WAIT'); setInfo('Joining…'); return; }

    const excluded = (state.excluded || []).includes(myId);
    const penalty = performance.now() < penaltyUntil;
    const winner = state.players.find((p) => p.id === state.winner);
    const qpos = (state.queue || []).findIndex((q) => q.id === myId);

    if (state.phase === 'armed') {
      if (excluded) { setButton('out', 'OUT'); setInfo('Locked out for this question'); }
      else if (buzzedArm === state.armId) { setButton('queued', 'BUZZED'); setInfo('Waiting for the host…'); }
      else if (penalty) { setButton('penalty', 'TOO SOON'); setInfo('False start: wait a moment'); setTimeout(render, penaltyUntil - performance.now() + 20); }
      else { setButton('armed', 'BUZZ!'); setInfo('<strong>GO!</strong>'); }
      return;
    }
    if (state.phase === 'buzzed') {
      if (state.winner === myId) { setButton('won', 'YOU!'); setInfo('<strong>You buzzed in first</strong>Answer now'); }
      else if (qpos >= 0 && !excluded) { setButton('queued', `#${qpos + 1}`); setInfo(`<strong>${esc(winner ? winner.name : '?')}</strong>buzzed first. You are #${qpos + 1} in line`); }
      else { setButton('out', 'WAIT'); setInfo(`<strong>${esc(winner ? winner.name : '?')}</strong>buzzed in`); }
      return;
    }
    // locked
    if (state.result) {
      const r = state.players.find((p) => p.id === state.result.id);
      const who = state.result.id === myId ? 'You' : esc(r ? r.name : '?');
      setInfo(`<strong>${who}: ${state.result.ok ? 'Correct!' : 'Wrong'}</strong>`);
    } else if (excluded) {
      setInfo('Locked out for this question');
    } else {
      setInfo('Get ready…');
    }
    if (penalty) setButton('penalty', 'TOO SOON');
    else setButton(excluded ? 'out' : 'locked', 'WAIT');
  }

  // ---------- misc ----------
  $('btnRename').onclick = showForm;
  $('btnLeave').onclick = () => {
    if (client) {
      client.publish(topic(room, 'hello'), JSON.stringify({ id: myId, bye: true }));
      client.end();
      client = null;
    }
    clearInterval(helloTimer);
    store.del('playRoom');
    room = '';
    showForm();
  };

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      hello();
    }
  });

  if (room && name) start();
  else showForm();
})();
