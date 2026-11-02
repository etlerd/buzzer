// Admin console: the single source of truth for the game.
// Players send hello/buzz messages; the admin decides the winner and publishes
// the retained game state that phones and the studio display render.
// It also uploads name recordings, which the display page plays.
(function () {
  const { store, topic, esc, sounds } = BZ;
  const MAX_PLAYERS = 16;
  const OFFLINE_AFTER_MS = 12000;
  const PALETTE = ['#ff3b30', '#0a84ff', '#34c759', '#ffcc00', '#af52de', '#ff9500', '#5ac8fa', '#ff2d92',
    '#a2845e', '#30d158', '#64d2ff', '#bf5af2', '#ffd60a', '#ff6961', '#8e8e93', '#ffffff'];

  // ---------- room ----------
  let room = BZ.cleanRoom(BZ.params.get('room')) || store.get('hostRoom', '') || BZ.newRoomCode();
  store.set('hostRoom', room);
  const url = new URL(location.href);
  if (url.searchParams.get('room') !== room) {
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
  }

  // ---------- state ----------
  const blank = () => ({
    phase: 'locked',      // locked | armed | buzzed
    armId: 0,
    winner: null,         // player id
    queue: [],            // [{id, rt, at}] buzz order for this opening
    excluded: [],         // ids locked out for the current question (answered wrong)
    kicked: [],
    question: '',
    result: null,         // {id, ok, n}
    resultSeq: 0,
    players: {},          // id -> {id, name, slot, color, score, lastSeen}
  });
  let game = Object.assign(blank(), store.get('game.' + room, {}));
  if (game.phase === 'armed') game.phase = 'locked'; // never resume mid-collection after reload
  const settings = Object.assign({ points: 10, penalty: 0, mode: 'fair', window: 400 }, store.get('hostSettings', {}));

  let client = null;
  let collectTimer = null;
  const onlineCache = {};
  // Name recordings, read back from the broker: proves the upload arrived and lets ▶ preview here.
  const voices = BZ.voiceStore(room, (slug, ready) => onVoiceReady(slug, ready));
  let awaitingVoice = null;  // {slug, name, timer} while an upload is unconfirmed
  const $ = (id) => document.getElementById(id);

  function isOnline(p) { return Date.now() - (p.lastSeen || 0) < OFFLINE_AFTER_MS; }
  function playerList() { return Object.values(game.players).sort((a, b) => a.slot - b.slot); }
  function nameOf(id) { return (game.players[id] && game.players[id].name) || '?'; }

  // ---------- publishing ----------
  function save() { store.set('game.' + room, game); }

  function wireState() {
    return {
      v: 1,
      room,
      phase: game.phase,
      armId: game.armId,
      winner: game.winner,
      queue: game.queue.map((q) => ({ id: q.id, rt: q.rt })),
      excluded: game.excluded,
      kicked: game.kicked,
      question: game.question,
      result: game.result,
      players: playerList().map((p) => ({ id: p.id, name: p.name, slot: p.slot, color: p.color, score: p.score, online: isOnline(p) })),
      ts: Date.now(),
    };
  }

  function publish() {
    save();
    render();
    if (!client || !client.connected) return;
    client.publish(topic(room, 'state'), JSON.stringify(wireState()), { qos: 1, retain: true });
  }

  // ---------- game actions ----------
  function arm() {
    if (game.phase === 'armed') return;
    clearTimeout(collectTimer);
    game.armId += 1;
    game.phase = 'armed';
    game.winner = null;
    game.queue = [];
    game.result = null;
    sounds.armed();
    publish();
  }

  function lockClear() {
    clearTimeout(collectTimer);
    game.phase = 'locked';
    game.winner = null;
    game.queue = [];
    game.result = null;
    publish();
  }

  function newQuestion() {
    game.excluded = [];
    game.question = '';
    $('question').value = '';
    lockClear();
  }

  function setResult(id, ok) {
    game.resultSeq += 1;
    game.result = { id, ok, n: game.resultSeq };
  }

  function correct() {
    if (game.phase !== 'buzzed' || !game.winner) return;
    const p = game.players[game.winner];
    if (p) p.score += Number(settings.points) || 0;
    setResult(game.winner, true);
    game.phase = 'locked';
    game.excluded = [];
    sounds.correct();
    publish();
  }

  function wrong(then) {
    if (game.phase !== 'buzzed' || !game.winner) return;
    const id = game.winner;
    const p = game.players[id];
    if (p) p.score -= Number(settings.penalty) || 0;
    if (!game.excluded.includes(id)) game.excluded.push(id);
    setResult(id, false);
    sounds.wrong();

    if (then === 'next') {
      const next = game.queue.find((q) => !game.excluded.includes(q.id));
      if (next) {
        game.winner = next.id;
        game.phase = 'buzzed';
      } else {
        game.winner = null;
        game.phase = 'locked';
      }
      publish();
      return;
    }
    // reopen: everyone not locked out may buzz again
    game.phase = 'locked';
    game.winner = null;
    publish();
    setTimeout(() => {
      game.phase = 'locked'; // ensure arm() runs
      arm();
    }, 900); // leave time for the "wrong" flash on screens and lights
  }

  function decide() {
    collectTimer = null;
    if (game.phase !== 'armed' || game.queue.length === 0) return;
    if (settings.mode === 'fair') game.queue.sort((a, b) => a.rt - b.rt);
    game.winner = game.queue[0].id;
    game.phase = 'buzzed';
    sounds.buzz();
    publish();
  }

  // ---------- incoming ----------
  function onHello(msg) {
    if (!msg || typeof msg.id !== 'string' || msg.id.length > 40) return;
    const id = msg.id;
    if (game.kicked.includes(id)) return;
    let p = game.players[id];
    if (msg.bye) {
      if (p) { p.lastSeen = 0; publish(); }
      return;
    }
    const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return;
    let changed = false;
    if (!p) {
      if (Object.keys(game.players).length >= MAX_PLAYERS) return;
      const used = new Set(Object.values(game.players).map((x) => x.slot));
      let slot = 1;
      while (used.has(slot)) slot++;
      p = game.players[id] = { id, name, slot, color: PALETTE[(slot - 1) % PALETTE.length], score: 0, lastSeen: 0 };
      changed = true;
    }
    if (p.name !== name) { p.name = name; changed = true; }
    const wasOnline = isOnline(p);
    p.lastSeen = Date.now();
    if (!wasOnline) changed = true;
    onlineCache[id] = true;
    if (changed) publish();
  }

  function onBuzz(msg) {
    if (!msg || !game.players[msg.id] || game.kicked.includes(msg.id)) return;
    if (msg.armId !== game.armId) return;
    if (game.excluded.includes(msg.id)) return;
    if (game.queue.some((q) => q.id === msg.id)) return;
    if (game.phase !== 'armed' && game.phase !== 'buzzed') return;

    game.players[msg.id].lastSeen = Date.now();
    const rt = Math.max(0, Math.min(60000, Number(msg.rt) || 0));
    const entry = { id: msg.id, rt, at: Date.now() };

    if (game.phase === 'buzzed') {
      // late buzz: keep it in line for "next in line"
      if (settings.mode === 'fair') {
        const rest = game.queue.slice(1).concat(entry).sort((a, b) => a.rt - b.rt);
        game.queue = [game.queue[0]].concat(rest);
      } else {
        game.queue.push(entry);
      }
      publish();
      return;
    }

    game.queue.push(entry);
    if (settings.mode === 'arrival') {
      decide();
    } else if (!collectTimer) {
      const wait = Math.max(0, Number(settings.window) || 0);
      if (wait === 0) decide();
      else collectTimer = setTimeout(decide, wait);
    }
  }

  // ---------- name recordings ----------
  // A clip is sent as retained binary chunks plus a manifest, so a display
  // opened later still receives it:
  //   voice/<slug>               {id, n, bytes}
  //   voice/<slug>/<id>/<i>      WAV bytes, chunk i of n
  const CHUNK = 32 * 1024;

  function clearVoice(slug) {
    const m = voices.manifests[slug];
    if (!m || !client || !client.connected) return;
    for (let i = 0; i < m.n; i++) client.publish(topic(room, `voice/${slug}/${m.id}/${i}`), '', { qos: 1, retain: true });
    client.publish(topic(room, `voice/${slug}`), '', { qos: 1, retain: true });
  }

  async function uploadVoice(name, file) {
    const slug = BZ.voiceSlug(name);
    if (!slug) throw new Error('The name needs at least one letter A–Z or digit.');
    if (!client || !client.connected) throw new Error('Not connected.');
    const wav = new Uint8Array(await (await Voice.convert(file)).arrayBuffer());
    clearVoice(slug);
    const id = BZ.newId().slice(0, 8);
    const n = Math.ceil(wav.length / CHUNK);
    for (let i = 0; i < n; i++) {
      client.publish(topic(room, `voice/${slug}/${id}/${i}`), wav.subarray(i * CHUNK, (i + 1) * CHUNK), { qos: 1, retain: true });
    }
    const manifest = { id, n, bytes: wav.length };
    client.publish(topic(room, `voice/${slug}`), JSON.stringify(manifest), { qos: 1, retain: true });
    return wav.length;
  }

  function previewName(name) {
    if (!voices.play(name)) $('voiceStatus').textContent = `No playable recording for ${name} yet.`;
  }

  function onVoiceReady(slug, ready) {
    if (ready && awaitingVoice && awaitingVoice.slug === slug) {
      clearTimeout(awaitingVoice.timer);
      $('voiceStatus').textContent = `Saved voice for ${awaitingVoice.name}. Playing a preview here; the display plays it when they buzz in.`;
      voices.play(awaitingVoice.name);
      awaitingVoice = null;
    }
    render();
  }

  let voiceFor = null;
  function pickVoice(p) {
    voiceFor = p;
    $('voiceFile').value = '';
    $('voiceFile').click();
  }

  // ---------- rendering ----------
  function render() {
    $('roomCode').textContent = room;
    const big = $('bigState');
    big.className = 'big-state' + (game.phase === 'armed' ? ' armed' : '');
    const w = game.winner && game.players[game.winner];
    if (game.phase === 'armed') {
      $('phaseLabel').textContent = 'Buzzers open';
      $('phaseValue').textContent = game.queue.length ? 'Deciding…' : 'Waiting for buzz';
    } else if (game.phase === 'buzzed' && w) {
      $('phaseLabel').textContent = 'Buzzed in';
      $('phaseValue').innerHTML = `<span style="color:${esc(w.color)}">${esc(w.name)}</span>`;
    } else if (game.result) {
      $('phaseLabel').textContent = game.result.ok ? 'Correct' : 'Wrong';
      $('phaseValue').innerHTML = `<span style="color:${game.result.ok ? 'var(--ok)' : 'var(--bad)'}">${esc(nameOf(game.result.id))}</span>`;
    } else {
      $('phaseLabel').textContent = 'Locked';
      $('phaseValue').textContent = 'Ready';
    }

    const buzzed = game.phase === 'buzzed' && !!game.winner;
    $('btnArm').disabled = game.phase === 'armed';
    $('btnCorrect').disabled = !buzzed;
    $('btnWrongReopen').disabled = !buzzed;
    $('btnWrongNext').disabled = !buzzed;

    $('queue').innerHTML = game.queue.map((q, i) => {
      const p = game.players[q.id];
      const out = game.excluded.includes(q.id);
      return `<li style="${out ? 'opacity:.45;text-decoration:line-through' : ''}"><span>${i + 1}. <span class="dot" style="background:${esc(p ? p.color : '#888')}"></span> ${esc(nameOf(q.id))}</span><span class="muted">${Math.round(q.rt)} ms</span></li>`;
    }).join('');

    const list = playerList();
    $('playerCount').textContent = `${list.filter(isOnline).length} online / ${list.length}`;
    $('players').innerHTML = list.map((p) => `
      <tr>
        <td><span class="dot" style="background:${esc(p.color)}"></span> <span class="slot">#${p.slot}</span></td>
        <td class="${isOnline(p) ? '' : 'offline-name'}">${esc(p.name)}${game.excluded.includes(p.id) ? ' <span class="muted">(out)</span>' : ''}</td>
        <td class="score">${p.score}</td>
        <td><div class="acts">
          <button class="small" data-act="voice" data-id="${esc(p.id)}" title="Upload a WAV or MP3 of this name">${voices.has(p.name) ? 'Voice ✓' : voices.pending(p.name) ? 'Voice…' : 'Add voice'}</button>
          <button class="small" data-act="say" data-id="${esc(p.id)}" aria-label="Preview name"${voices.has(p.name) ? '' : ' disabled'}>▶</button>
          <button class="small" data-act="minus" data-id="${esc(p.id)}" aria-label="Subtract points">−</button>
          <button class="small" data-act="plus" data-id="${esc(p.id)}" aria-label="Add points">+</button>
          <button class="small" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove player">✕</button>
        </div></td>
      </tr>`).join('') || '<tr><td class="muted">Nobody yet. Scan the code to join.</td></tr>';
  }

  // ---------- wiring ----------
  function initUi() {
    $('voiceFile').addEventListener('change', async () => {
      const file = $('voiceFile').files[0];
      const p = voiceFor;
      if (!file || !p) return;
      $('voiceStatus').textContent = `Converting ${file.name}…`;
      try {
        const slug = BZ.voiceSlug(p.name);
        if (awaitingVoice) clearTimeout(awaitingVoice.timer);
        awaitingVoice = {
          slug,
          name: p.name,
          timer: setTimeout(() => {
            awaitingVoice = null;
            $('voiceStatus').textContent = `Upload for ${p.name} was not confirmed by the server. The network may be blocking it; try again or switch networks.`;
          }, 15000),
        };
        const bytes = await uploadVoice(p.name, file);
        $('voiceStatus').textContent = `Uploading voice for ${p.name} (${Math.round(bytes / 1024)} KB)…`;
        render();
      } catch (err) {
        if (awaitingVoice) { clearTimeout(awaitingVoice.timer); awaitingVoice = null; }
        $('voiceStatus').textContent = err.message;
      }
    });

    const joinUrl = BZ.pageUrl('play.html', room);
    $('joinLink').href = joinUrl;
    $('joinLink').textContent = joinUrl;
    BZ.renderQr($('qr'), joinUrl);
    $('displayLink').href = BZ.pageUrl('display.html', room);
    $('roomInput').value = room;
    $('brokerInput').value = BZ.brokerUrl();
    $('question').value = game.question;
    $('points').value = settings.points;
    $('penalty').value = settings.penalty;
    $('mode').value = settings.mode;
    $('window').value = settings.window;

    $('btnArm').onclick = arm;
    $('btnCorrect').onclick = correct;
    $('btnWrongReopen').onclick = () => wrong('reopen');
    $('btnWrongNext').onclick = () => wrong('next');
    $('btnLock').onclick = lockClear;
    $('btnNewQuestion').onclick = newQuestion;

    for (const key of ['points', 'penalty', 'mode', 'window']) {
      $(key).onchange = () => {
        settings[key] = key === 'mode' ? $(key).value : Number($(key).value);
        store.set('hostSettings', settings);
      };
    }
    $('window').parentElement.classList.toggle('hidden', settings.mode !== 'fair');
    $('mode').addEventListener('change', () => $('window').parentElement.classList.toggle('hidden', settings.mode !== 'fair'));

    const pushQuestion = () => { game.question = $('question').value.trim().slice(0, 300); publish(); };
    $('question').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pushQuestion(); $('question').blur(); }
    });
    $('question').addEventListener('blur', pushQuestion);

    $('players').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const p = game.players[b.dataset.id];
      if (!p) return;
      const pts = Number(settings.points) || 1;
      if (b.dataset.act === 'voice') { pickVoice(p); return; }
      if (b.dataset.act === 'say') { previewName(p.name); return; }
      if (b.dataset.act === 'plus') p.score += pts;
      if (b.dataset.act === 'minus') p.score -= pts;
      if (b.dataset.act === 'kick') {
        if (!confirm(`Remove ${p.name}? They will not be able to rejoin from that phone this game.`)) return;
        delete game.players[p.id];
        game.kicked.push(p.id);
        game.queue = game.queue.filter((q) => q.id !== p.id);
        if (game.winner === p.id) { game.winner = null; game.phase = 'locked'; }
      }
      publish();
    };
    $('btnResetScores').onclick = () => {
      if (!confirm('Set every score to 0?')) return;
      Object.values(game.players).forEach((p) => { p.score = 0; });
      publish();
    };
    $('btnRemoveOffline').onclick = () => {
      Object.values(game.players).filter((p) => !isOnline(p)).forEach((p) => delete game.players[p.id]);
      publish();
    };

    const switchRoom = (code) => {
      code = BZ.cleanRoom(code);
      if (!code || code === room) return;
      if (!confirm(`Switch to room ${code}? Players in ${room} will need the new code.`)) return;
      // remove retained messages so the old room does not linger on the broker
      if (client && client.connected) {
        client.publish(topic(room, 'state'), '', { qos: 1, retain: true });
        for (const slug of Object.keys(voices.manifests)) clearVoice(slug);
      }
      store.set('hostRoom', code);
      setTimeout(() => { location.search = '?room=' + code; }, 300);
    };
    $('btnSetRoom').onclick = () => switchRoom($('roomInput').value);
    $('btnNewRoom').onclick = () => switchRoom(BZ.newRoomCode());
    $('btnSaveBroker').onclick = () => {
      const v = $('brokerInput').value.trim();
      store.set('broker', v === BZ.DEFAULT_BROKER ? '' : v);
      const u = new URL(location.href);
      u.searchParams.delete('broker');
      location.href = u.toString();
    };

    document.addEventListener('pointerdown', sounds.unlock, { once: true });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); arm(); }
      else if (k === 'c') correct();
      else if (k === 'w') wrong('reopen');
      else if (k === 'n') wrong('next');
      else if (k === 'l') lockClear();
      else if (k === 'q') newQuestion();
    });
  }

  function connect() {
    client = BZ.connect({
      role: 'host',
      onStatus: (s) => BZ.setStatusBadge($('status'), s),
      onConnect: () => {
        client.subscribe([topic(room, 'hello'), topic(room, 'buzz'), topic(room, 'voice/#')], { qos: 1 });
        publish();
      },
    });
    client.on('message', (t, payload) => {
      const msg = BZ.parse(payload);
      if (t.endsWith('/hello')) onHello(msg);
      else if (t.endsWith('/buzz')) onBuzz(msg);
      else if (t.includes('/voice/')) {
        voices.handle(t, payload);
        render();
      }
    });
  }

  // Re-publish when someone's online status flips.
  setInterval(() => {
    let changed = false;
    for (const p of Object.values(game.players)) {
      const on = isOnline(p);
      if (onlineCache[p.id] !== on) { onlineCache[p.id] = on; changed = true; }
    }
    if (changed) publish();
  }, 3000);

  initUi();
  render();
  connect();
})();
