// Host console. The hub runs the game; this page sends commands and shows state.
(function () {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let cardsFor = 0;     // seat count the cards were built for
  let voiceSeat = 0;    // seat whose voice file picker is open
  let noticeTimer = null;

  const send = (c, extra) => {
    if (!Link.send(Object.assign({ c }, extra || {}))) notice('Not connected to the hub.', true);
  };

  function notice(text, isError, ms = 5000) {
    const n = $('notice');
    n.textContent = text;
    n.dataset.kind = '';
    n.classList.toggle('error', !!isError);
    n.classList.remove('hidden');
    clearTimeout(noticeTimer);
    if (ms) noticeTimer = setTimeout(() => { n.classList.add('hidden'); render(); }, ms);
  }

  function seat(s) { return state && state.seats.find((x) => x.s === s); }
  function label(s) { const x = seat(s); return x && x.name ? x.name : `Seat ${s}`; }

  // ---------- seat cards ----------
  function buildCards(n) {
    const box = $('seats');
    box.innerHTML = '';
    for (let s = 1; s <= n; s++) {
      const el = document.createElement('div');
      el.className = 'seat';
      el.dataset.s = s;
      el.innerHTML = `
        <div class="seat-head"><span class="dot"></span><strong>Seat ${s}</strong><span class="pod"></span></div>
        <input class="name" maxlength="20" placeholder="Contestant name" aria-label="Seat ${s} name">
        <div class="seat-score">
          <button class="small" data-a="minus" aria-label="Subtract points">−</button>
          <span class="score">0</span>
          <button class="small" data-a="plus" aria-label="Add points">+</button>
        </div>
        <div class="seat-actions">
          <button class="small" data-a="pair">Pair pod</button>
          <button class="small" data-a="find">Find</button>
          <button class="small" data-a="unpair">Unpair</button>
          <button class="small" data-a="voice">Add voice</button>
          <button class="small" data-a="play" aria-label="Play name">▶ Name</button>
        </div>`;
      const input = el.querySelector('.name');
      input.addEventListener('change', () => {
        const old = seat(s);
        send('name', { s, name: input.value });
        if (old && old.voice && voiceSlug(old.name) !== voiceSlug(input.value)) {
          notice(`${input.value || `Seat ${s}`} needs a new voice clip: clips are matched by name.`, false, 7000);
        }
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      box.appendChild(el);
    }
    cardsFor = n;
  }

  function renderCards() {
    if (cardsFor !== state.seatCount) buildCards(state.seatCount);
    for (const x of state.seats) {
      const el = $('seats').querySelector(`.seat[data-s="${x.s}"]`);
      if (!el) continue;
      el.querySelector('.dot').style.background = x.color;
      const pod = el.querySelector('.pod');
      pod.dataset.pod = x.pod;
      pod.textContent = { online: 'pod ready', offline: 'pod offline', none: 'no pod' }[x.pod];
      const input = el.querySelector('.name');
      if (document.activeElement !== input) input.value = x.name;
      el.querySelector('.score').textContent = x.score;
      el.classList.toggle('winner', state.phase === 'buzzed' && state.winner === x.s);
      el.classList.toggle('out', x.out);
      const pairing = state.assigning === x.s;
      el.classList.toggle('pairing', pairing);
      const pair = el.querySelector('[data-a="pair"]');
      pair.textContent = pairing ? 'Cancel pairing' : x.pod === 'none' ? 'Pair pod' : 'Re-pair';
      el.querySelector('[data-a="find"]').disabled = x.pod === 'none';
      el.querySelector('[data-a="unpair"]').classList.toggle('hidden', x.pod === 'none');
      const voice = el.querySelector('[data-a="voice"]');
      voice.textContent = x.voice ? 'Replace voice' : 'Add voice';
      voice.disabled = !Link.canUpload || !x.name;
      voice.title = !Link.canUpload ? 'Voice upload needs the Wi-Fi connection' : !x.name ? 'Enter a name first' : '';
      el.querySelector('[data-a="play"]').disabled = !x.voice;
    }
  }

  $('seats').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const card = e.target.closest('.seat');
    if (!b || !card || !state) return;
    const s = Number(card.dataset.s);
    switch (b.dataset.a) {
      case 'minus': send('score', { s, delta: -(state.points || 1) }); break;
      case 'plus': send('score', { s, delta: state.points || 1 }); break;
      case 'pair': send('assign', { s: state.assigning === s ? 0 : s }); break;
      case 'find': send('identify', { s }); break;
      case 'unpair': if (confirm(`Unpair the pod from ${label(s)}?`)) send('unassign', { s }); break;
      case 'play': send('saysname', { s }); break;
      case 'voice':
        voiceSeat = s;
        $('voiceFile').value = '';
        $('voiceFile').click();
        break;
    }
  });

  $('voiceFile').addEventListener('change', async () => {
    const file = $('voiceFile').files[0];
    const x = seat(voiceSeat);
    if (!file || !x) return;
    notice(`Converting and uploading voice for ${x.name}…`, false, 0);
    try {
      await Voice.upload(x.name, file);
      send('voices');
      send('saysname', { s: x.s });
      notice(`Voice saved for ${x.name}. Playing it on the aux output.`);
    } catch (err) {
      notice(err.message, true, 8000);
    }
  });

  // ---------- main state ----------
  function render() {
    if (!state) return;
    const big = $('bigState');
    big.className = 'big-state' + (state.phase === 'armed' ? ' armed' : '');
    const w = seat(state.winner);
    if (state.phase === 'armed') {
      $('phaseLabel').textContent = 'Buzzers open';
      $('phaseValue').textContent = state.queue.length ? 'Deciding…' : 'Waiting for a buzz';
    } else if (state.phase === 'buzzed' && w) {
      $('phaseLabel').textContent = 'Buzzed in';
      $('phaseValue').innerHTML = `<span style="color:${esc(w.color)}">${esc(label(w.s))}</span>`;
    } else if (state.result) {
      $('phaseLabel').textContent = state.result.ok ? 'Correct' : 'Wrong';
      $('phaseValue').innerHTML = `<span style="color:${state.result.ok ? 'var(--ok)' : 'var(--bad)'}">${esc(label(state.result.s))}</span>`;
    } else {
      $('phaseLabel').textContent = 'Locked';
      $('phaseValue').textContent = 'Ready';
    }

    const buzzed = state.phase === 'buzzed' && !!state.winner;
    $('btnArm').disabled = state.phase === 'armed';
    $('btnCorrect').disabled = !buzzed;
    $('btnWrong').disabled = !buzzed;
    $('btnWrongNext').disabled = !buzzed;

    $('queue').innerHTML = state.queue.map((q, i) => {
      const x = seat(q.s);
      const out = x && x.out;
      return `<li class="${out ? 'struck' : ''}"><span>${i + 1}. <span class="dot" style="background:${esc(x ? x.color : '#888')}"></span> ${esc(label(q.s))}</span><span class="muted">${i === 0 ? 'first' : '+' + q.ms + ' ms'}</span></li>`;
    }).join('');

    renderCards();

    const paired = state.seats.filter((x) => x.pod !== 'none').length;
    const online = state.seats.filter((x) => x.pod === 'online').length;
    $('podSummary').textContent = `${online}/${paired} pods online` + (state.unpaired ? ` · ${state.unpaired} unpaired (blinking blue)` : '');

    const n = $('notice');
    if (state.assigning) {
      n.textContent = `Pairing: press the button on the pod for ${label(state.assigning)}. Unpaired pods blink blue.`;
      n.classList.remove('hidden', 'error');
      n.dataset.kind = 'pair';
    } else if (n.dataset.kind === 'pair') {
      n.classList.add('hidden');
      n.dataset.kind = '';
    }

    for (const id of ['seatCount', 'points', 'penalty', 'volume']) {
      if (document.activeElement !== $(id)) $(id).value = state[id];
    }
    $('volumeVal').textContent = state.volume;
    if (document.activeElement !== $('question')) $('question').value = state.question || '';
  }

  // ---------- controls ----------
  const actions = {
    arm: () => send('arm'),
    correct: () => send('correct'),
    wrong: () => send('wrong', { then: 'reopen' }),
    next: () => send('wrong', { then: 'next' }),
    lock: () => send('lock'),
    newq: () => send('newq'),
  };
  $('btnArm').onclick = actions.arm;
  $('btnCorrect').onclick = actions.correct;
  $('btnWrong').onclick = actions.wrong;
  $('btnWrongNext').onclick = actions.next;
  $('btnLock').onclick = actions.lock;
  $('btnNewQ').onclick = actions.newq;
  $('btnResetScores').onclick = () => { if (confirm('Set every score to 0?')) send('resetscores'); };
  document.querySelectorAll('[data-sound]').forEach((b) => { b.onclick = () => send('sound', { name: b.dataset.sound }); });

  const setting = (id) => () => send('settings', { [id === 'seatCount' ? 'seats' : id]: Number($(id).value) });
  for (const id of ['seatCount', 'points', 'penalty', 'volume']) $(id).addEventListener('change', setting(id));
  $('volume').addEventListener('input', () => { $('volumeVal').textContent = $('volume').value; });

  const pushQuestion = () => send('question', { text: $('question').value.trim() });
  $('question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('question').blur(); }
  });
  $('question').addEventListener('change', pushQuestion);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { ' ': 'arm', c: 'correct', w: 'wrong', n: 'next', l: 'lock', q: 'newq' };
    const a = map[e.key.toLowerCase()];
    if (a) { e.preventDefault(); actions[a](); }
  });

  // ---------- connection ----------
  if (Link.local) {
    $('adminLink').classList.add('hidden');
    $('btnUsb').classList.remove('hidden');
    $('btnUsb').onclick = () => {
      Link.connectUsb().catch((err) => notice(err.message, true, 8000));
    };
    notice('Opened from a file: plug the hub into this computer and click "Connect hub by USB". Voice uploads need the hub\'s Wi-Fi.', false, 0);
  }

  Link.start({
    role: 'host',
    onStatus: (s) => {
      setStatusBadge($('status'), s);
      $('btnUsb').classList.toggle('hidden', !Link.local || s === 'online');
    },
    onState: (s) => { state = s; render(); },
    onError: (msg) => notice('Hub: ' + msg, true),
  });
})();
