// Version and release date, shown behind a small (i) button in a page corner.
// Both come from this script's own cache tag in the HTML (?v=VERSION_DATE),
// so that tag is the only thing to change on a release.
(function () {
  const src = document.currentScript && document.currentScript.src;
  const tag = src ? new URL(src).searchParams.get('v') || '' : '';
  const [version, date] = tag.split('_');
  window.BZ_VERSION = { version: version || 'dev', date: date || '' };

  function mount() {
    const wrap = document.createElement('div');
    wrap.className = 'ver';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ver-btn';
    btn.textContent = 'i';
    btn.setAttribute('aria-label', 'Version information');
    btn.setAttribute('aria-expanded', 'false');
    const pop = document.createElement('div');
    pop.className = 'ver-pop';
    pop.setAttribute('role', 'status');
    pop.textContent = `Version ${window.BZ_VERSION.version}` + (window.BZ_VERSION.date ? ` · ${window.BZ_VERSION.date}` : '');
    wrap.append(btn, pop);
    // a page can reserve a spot in its content ([data-version-slot]); otherwise it floats in a corner
    (document.querySelector('[data-version-slot]') || document.body).appendChild(wrap);

    // hover shows it on computers (CSS); tap toggles it on phones
    const set = (open) => { wrap.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); set(!wrap.classList.contains('open')); btn.blur(); });
    document.addEventListener('click', () => set(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
