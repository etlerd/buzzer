// Admin console: the single source of truth for the game.
// Players send hello/buzz messages; the admin decides the winner and publishes
// the retained game state that phones and the studio display render.
// It also uploads each player's buzzer sound, which the display page plays.
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
    result: null,         // {id, ok, n}
    resultSeq: 0,
    players: {},          // id -> {id, name, slot, color, lastSeen, voice}
  });
  let game = Object.assign(blank(), store.get('game.' + room, {}));
  if (game.phase === 'armed') game.phase = 'locked'; // never resume mid-collection after reload
  const settings = Object.assign({ mode: 'fair', window: 400 }, store.get('hostSettings', {}));

  let client = null;
  let collectTimer = null;
  const onlineCache = {};
  // Buzzer sounds, read back from the broker: proves the upload arrived and lets ▶ preview here.
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
      result: game.result,
      players: playerList().map((p) => ({ id: p.id, name: p.name, slot: p.slot, color: p.color, online: isOnline(p), voice: voiceOf(p) })),
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
    lockClear();
  }

  function setResult(id, ok) {
    game.resultSeq += 1;
    game.result = { id, ok, n: game.resultSeq };
  }

  function correct() {
    if (game.phase !== 'buzzed' || !game.winner) return;
    const p = game.players[game.winner];
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
      p = game.players[id] = { id, name, slot, color: PALETTE[(slot - 1) % PALETTE.length], lastSeen: 0 };
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

  // ---------- buzzer sounds ----------
  // A clip is sent as retained binary chunks plus a manifest, so a display
  // opened later still receives it:
  //   voice/<slug>               {id, n, bytes, name}
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
    const manifest = { id, n, bytes: wav.length, name: String(name).trim().slice(0, 40) };
    client.publish(topic(room, `voice/${slug}`), JSON.stringify(manifest), { qos: 1, retain: true });
    return wav.length;
  }

  // Sound used for a player: one assigned by hand, else the one matching their name.
  function voiceOf(p) {
    return p.voice && voices.manifests[p.voice] ? p.voice : BZ.voiceSlug(p.name);
  }

  function preview(slug, label, statusEl = 'voiceStatus') {
    sounds.unlock();
    voices.playSlug(slug).then((ok) => {
      if (!ok) $(statusEl).textContent = `No playable sound for ${label} yet.`;
    }, (err) => {
      $(statusEl).textContent = `The browser blocked playback (${err && err.name || 'error'}). Tap ▶ again; on iPhone check the volume.`;
    });
  }

  // Many files at once: each file's name (without extension) is the player name.
  async function addRecordings(files) {
    const list = [...files];
    let done = 0;
    const failed = [];
    for (const f of list) {
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
      $('libraryStatus').textContent = `Uploading ${done + 1} of ${list.length}: ${name}…`;
      try { await uploadVoice(name, f); done++; } catch (err) { failed.push(`${f.name} (${err.message})`); }
    }
    $('libraryStatus').textContent = `Uploaded ${done} of ${list.length}.` + (failed.length ? ` Failed: ${failed.join('; ')}` : ' Each shows ▶ once the server confirms it.');
  }

  function deleteRecording(slug) {
    const item = voices.list().find((v) => v.slug === slug);
    if (!confirm(`Delete the sound "${item ? item.name : slug}"?`)) return;
    clearVoice(slug);
    for (const p of Object.values(game.players)) if (p.voice === slug) p.voice = null;
    publish();
  }

  function renderLibrary() {
    const players = playerList();
    const items = voices.list();
    $('library').innerHTML = items.map((v) => {
      const users = players.filter((p) => voiceOf(p) === v.slug).map((p) => esc(p.name));
      const options = players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      return `<li>
        <span class="lname">${esc(v.name)}</span>
        <span class="match">${users.length ? '→ ' + users.join(', ') : 'not joined yet'}</span>
        ${players.length ? `<select data-slug="${esc(v.slug)}" aria-label="Assign ${esc(v.name)} to a player"><option value="">Assign to…</option>${options}</select>` : ''}
        <button class="small" data-lact="play" data-slug="${esc(v.slug)}"${v.ready ? '' : ' disabled'} aria-label="Play ${esc(v.name)}">${v.ready ? '▶' : '…'}</button>
        <button class="small" data-lact="delete" data-slug="${esc(v.slug)}" aria-label="Delete ${esc(v.name)}">✕</button>
      </li>`;
    }).join('') || '<li class="muted">No sounds yet.</li>';
  }

  // re-send state when sounds change, so the display knows which one each player uses
  let voicePublishTimer = null;
  function publishSoon() {
    clearTimeout(voicePublishTimer);
    voicePublishTimer = setTimeout(publish, 300);
  }

  function onVoiceReady(slug, ready) {
    if (ready && awaitingVoice && awaitingVoice.slug === slug) {
      clearTimeout(awaitingVoice.timer);
      $('voiceStatus').textContent = `Saved sound for ${awaitingVoice.name}. Playing a preview here; the display plays it when they buzz in.`;
      voices.playSlug(slug).catch(() => {
        $('voiceStatus').textContent += ' (Preview blocked by the browser: tap ▶ to hear it.)';
      });
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

    renderLibrary();
    const list = playerList();
    $('playerCount').textContent = `${list.filter(isOnline).length} online / ${list.length}`;
    $('players').innerHTML = list.map((p) => `
      <tr>
        <td><span class="dot" style="background:${esc(p.color)}"></span> <span class="slot">#${p.slot}</span></td>
        <td class="${isOnline(p) ? '' : 'offline-name'}">${esc(p.name)}${game.excluded.includes(p.id) ? ' <span class="muted">(out)</span>' : ''}</td>
        <td><div class="acts">
          <button class="small" data-act="voice" data-id="${esc(p.id)}" title="Upload a WAV or MP3 buzzer sound for this player">${voices.hasSlug(voiceOf(p)) ? 'Sound ✓' : voices.pendingSlug(voiceOf(p)) ? 'Sound…' : 'Add sound'}</button>
          <button class="small" data-act="say" data-id="${esc(p.id)}" aria-label="Preview name"${voices.hasSlug(voiceOf(p)) ? '' : ' disabled'}>▶</button>
          <button class="small" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove player">✕</button>
        </div></td>
      </tr>`).join('') || '<tr><td class="muted">Nobody yet. Scan the code to join.</td></tr>';
  }

  // ---------- wiring ----------
  function initUi() {
    $('btnAddRecordings').onclick = () => { $('libraryFiles').value = ''; $('libraryFiles').click(); };
    $('libraryFiles').addEventListener('change', () => {
      if ($('libraryFiles').files.length) addRecordings($('libraryFiles').files);
    });
    $('library').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const item = voices.list().find((v) => v.slug === b.dataset.slug);
      if (b.dataset.lact === 'play') preview(b.dataset.slug, item ? item.name : b.dataset.slug, 'libraryStatus');
      if (b.dataset.lact === 'delete') deleteRecording(b.dataset.slug);
    });
    $('library').addEventListener('change', (e) => {
      const sel = e.target.closest('select');
      if (!sel || !sel.value) return;
      const p = game.players[sel.value];
      if (p) { p.voice = sel.dataset.slug; publish(); }
    });

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
        p.voice = null;  // a sound uploaded for this player replaces any assigned one
        const bytes = await uploadVoice(p.name, file);
        $('voiceStatus').textContent = `Uploading sound for ${p.name} (${Math.round(bytes / 1024)} KB)…`;
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
    $('mode').value = settings.mode;
    $('window').value = settings.window;

    $('btnArm').onclick = arm;
    $('btnCorrect').onclick = correct;
    $('btnWrongReopen').onclick = () => wrong('reopen');
    $('btnWrongNext').onclick = () => wrong('next');
    $('btnLock').onclick = lockClear;
    $('btnNewQuestion').onclick = newQuestion;

    for (const key of ['mode', 'window']) {
      $(key).onchange = () => {
        settings[key] = key === 'mode' ? $(key).value : Number($(key).value);
        store.set('hostSettings', settings);
      };
    }
    $('window').parentElement.classList.toggle('hidden', settings.mode !== 'fair');
    $('mode').addEventListener('change', () => $('window').parentElement.classList.toggle('hidden', settings.mode !== 'fair'));


    $('players').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const p = game.players[b.dataset.id];
      if (!p) return;
      if (b.dataset.act === 'voice') { pickVoice(p); return; }
      if (b.dataset.act === 'say') { preview(voiceOf(p), p.name); return; }
      if (b.dataset.act === 'kick') {
        if (!confirm(`Remove ${p.name}? They will not be able to rejoin from that phone this game.`)) return;
        delete game.players[p.id];
        game.kicked.push(p.id);
        game.queue = game.queue.filter((q) => q.id !== p.id);
        if (game.winner === p.id) { game.winner = null; game.phase = 'locked'; }
      }
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

    document.addEventListener('pointerdown', sounds.unlock);
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
        if (t.split('/').length === 5) publishSoon();  // a manifest (not a chunk) changed
        else render();
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
