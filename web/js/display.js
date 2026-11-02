// Studio display: read-only big screen. Sound comes from the hub's aux jack, not here.
(function () {
  const $ = (id) => document.getElementById(id);
  let prev = null;

  $('btnFull').onclick = () => {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  };
  document.addEventListener('fullscreenchange', () => $('btnFull').classList.toggle('hidden', !!document.fullscreenElement));

  function render(s) {
    const byS = Object.fromEntries(s.seats.map((x) => [x.s, x]));
    const name = (n) => (byS[n] && byS[n].name) || `Seat ${n}`;

    if (prev && s.result && (!prev.result || prev.result.n !== s.result.n)) {
      const r = $('result');
      r.className = 'result';
      void r.offsetWidth;  // restart the flash animation
      r.className = 'result ' + (s.result.ok ? 'ok' : 'bad');
    }
    prev = s;

    $('stage').className = 'stage' + (s.phase === 'armed' ? ' armed' : '');
    const w = byS[s.winner];
    if (s.phase === 'armed') {
      $('phase').textContent = 'Buzzers open';
      $('winner').textContent = '';
    } else if (s.phase === 'buzzed' && w) {
      $('phase').textContent = 'Buzzed in';
      $('winner').textContent = name(w.s);
      $('winner').style.color = w.color;
    } else if (s.result) {
      $('phase').textContent = s.result.ok ? 'Correct!' : 'Wrong';
      $('winner').textContent = name(s.result.s);
      $('winner').style.color = s.result.ok ? 'var(--ok)' : 'var(--bad)';
    } else {
      $('phase').textContent = 'Get ready';
      $('winner').textContent = '';
    }
    $('question').textContent = s.question || '';

    const ranked = s.seats.filter((x) => x.name || x.pod !== 'none')
      .sort((a, b) => b.score - a.score || a.s - b.s);
    $('board').innerHTML = ranked.map((x) => `
      <li class="${x.out ? 'out' : ''}">
        <span class="dot" style="background:${esc(x.color)}"></span>
        <span class="n">${esc(name(x.s))}</span>
        <span class="score">${x.score}</span>
      </li>`).join('');
  }

  Link.start({
    role: 'display',
    onStatus: (s) => setStatusBadge($('status'), s),
    onState: render,
  });
})();
