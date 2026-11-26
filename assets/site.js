/* Design prototype behaviour (SPEC.md "Behaviour list for site.js"). Classic script, no libraries. */
(function () {
  'use strict';

  var win = window;
  var doc = document;
  var html = doc.documentElement;
  var reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = win.matchMedia('(pointer: fine)');
  var hoverFine = win.matchMedia('(hover: hover) and (pointer: fine)');
  // Opacity of a word the reveal has not reached: about 3.1:1 on paper, above the 3:1 large-text minimum (QA-14).
  var WORD_FLOOR = 0.45;

  var PAGE_LABELS = {
    'index.html': 'Home',
    'projects.html': 'Projects',
    'blog.html': 'Writing',
    'blog-harpocrates.html': 'Draft post'
  };

  // Shared state. Lists are filled in init().
  var jobs = [];
  var queued = false;
  var pageJobs = [];
  var wordSets = [];
  var drifts = [];
  var magnetics = [];
  var fab = null;
  var panel = null;
  var main = null;
  var header = null;
  var pendingNav = 0;
  var preloadTimers = [];
  var progressEl = null;
  var article = null;
  var collideLetters = [];
  var curves = [];
  var footEl = null;
  var demoSyncs = [];
  var cursorEl = null;
  var cursorPreview = null;
  var cur = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, placed: false, last: 0 };
  var smooth = { on: false, running: false, target: 0, current: 0, last: 0 };

  function all(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function motionOK() { return html.dataset.motion !== 'off' && !reducedMotion.matches; }
  // Shows or hides an icon svg (or any element) by its hidden attribute.
  function setHidden(root, sel, hidden) {
    var el = root.querySelector(sel);
    if (el) el.toggleAttribute('hidden', hidden);
  }
  function safe(name, fn) {
    try {
      fn();
    } catch (err) {
      console.warn('site.js: ' + name + ' failed', err);
    }
  }

  // Shared rAF scheduler (item 18). A job returns true while it still needs frames.
  function schedule(job) {
    if (jobs.indexOf(job) < 0) jobs.push(job);
    kick();
  }
  function kick() {
    if (queued || doc.hidden) return;
    queued = true;
    win.requestAnimationFrame(tick);
  }
  function tick(now) {
    queued = false;
    if (doc.hidden) return;
    var list = jobs;
    jobs = [];
    list.forEach(function (job) {
      if (job(now) && jobs.indexOf(job) < 0) jobs.push(job);
    });
    if (jobs.length) kick();
  }
  function requestAll() {
    pageJobs.forEach(function (job) { schedule(job); });
  }

  // Motion (item 2)
  function paintToggles() {
    var running = motionOK();
    var locked = reducedMotion.matches;
    all('[data-motion-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(!running));
      btn.disabled = locked;
      setHidden(btn, '.icon-pause', !running);
      setHidden(btn, '.icon-play', running);
      var label = btn.querySelector('[data-motion-label]');
      if (label) label.textContent = locked ? 'Animations off by system setting' : (running ? 'Pause animations' : 'Resume animations');
    });
  }

  function resetMagnet(el) {
    var inner = el.querySelector('.magnetic-inner');
    var t = 'transform 1s var(--ease-elastic)';
    el.style.transition = t;
    el.style.transform = '';
    if (inner) {
      inner.style.transition = t;
      inner.style.transform = '';
    }
  }

  function showStill() {
    all('.reveal').forEach(function (el) { el.classList.add('is-in'); });
    wordSets.forEach(function (set) {
      set.spans.forEach(function (span) { span.style.opacity = '1'; });
    });
    drifts.forEach(function (d) { d.el.style.setProperty('--drift-x', '0px'); });
    collideLetters.forEach(function (l) { l.el.style.transform = ''; });
    magnetics.forEach(resetMagnet);
  }

  function syncMotion() {
    var on = motionOK();
    html.classList.toggle('fx', on);
    syncCursor();
    syncSmooth();
    paintToggles();
    if (!on) {
      endPreload();
      showStill();
    }
    demoSyncs.forEach(function (fn) { fn(); });
    requestAll();
  }

  function onMotionToggle() {
    var pausing = html.dataset.motion !== 'off';
    if (pausing) html.dataset.motion = 'off';
    else delete html.dataset.motion;
    try {
      if (pausing) localStorage.setItem('dp-motion', 'off');
      else localStorage.removeItem('dp-motion');
    } catch (e) { /* storage unavailable: keep the in-page setting */ }
    syncMotion();
  }

  // Reveal words (item 5)
  function wrapWords(root) {
    var spans = [];
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      if (!node.nodeValue.trim()) return;
      var frag = doc.createDocumentFragment();
      node.nodeValue.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(doc.createTextNode(part));
        } else {
          var s = doc.createElement('span');
          s.className = 'w';
          s.textContent = part;
          frag.appendChild(s);
          spans.push(s);
        }
      });
      node.parentNode.replaceChild(frag, node);
    });
    return spans;
  }

  function wordsJob() {
    if (!motionOK()) return false;
    var vh = win.innerHeight;
    wordSets.forEach(function (set) {
      // The words light up as the paragraph passes a line 85% down the viewport, so text above it is fully lit (QA-14).
      var r = set.el.getBoundingClientRect();
      var p = clamp01((vh * 0.85 - r.top) / Math.max(r.height, 1));
      var lit = p * set.spans.length;
      set.spans.forEach(function (span, i) {
        span.style.opacity = String(WORD_FLOOR + (1 - WORD_FLOOR) * clamp01(lit - i));
      });
    });
    return false;
  }

  // Count-up (item 6)
  function startCount(el) {
    var text = el.textContent;
    var target = parseFloat(text.replace(/,/g, '')) || 0;
    var dec = parseInt(el.dataset.decimals || '0', 10);
    var start = performance.now();
    schedule(function (now) {
      var t = motionOK() ? clamp01((now - start) / 1000) : 1;
      el.textContent = t < 1 ? (target * (1 - Math.pow(1 - t, 3))).toFixed(dec) : text;
      return t < 1;
    });
  }

  // Photo drift (item 8)
  function driftJob() {
    if (!motionOK()) return false;
    var vh = win.innerHeight;
    drifts.forEach(function (d) {
      var r = d.box.getBoundingClientRect();
      var p = clamp01((vh - r.top) / (vh + r.height));
      d.el.style.setProperty('--drift-x', d.dir * (p - 0.5) * 240 + 'px');
    });
    return false;
  }

  // Reading progress (item 17)
  function progressJob() {
    if (!progressEl || !article) return false;
    var r = article.getBoundingClientRect();
    var span = r.height - win.innerHeight;
    progressEl.style.setProperty('--read', span > 0 ? clamp01(-r.top / span) : 0);
    return false;
  }

  // Demo figures (item 12)
  function initDemo(demo) {
    var stage = demo.querySelector('.demo__stage');
    var terminal = demo.querySelector('.terminal');
    var error = demo.querySelector('.demo__error');
    if (!stage || !terminal || !error || !demo.dataset.src) return;
    var gif = null;

    // Remove the image, show the poster and set the given state.
    function stop(state) {
      if (gif) gif.remove();
      gif = null;
      terminal.hidden = false;
      demo.dataset.state = state;
    }

    function start() {
      var img = doc.createElement('img');
      gif = img;
      img.decoding = 'async';
      img.src = demo.dataset.src;
      img.alt = demo.dataset.alt || '';
      img.addEventListener('load', function () {
        if (gif === img) demo.dataset.state = 'playing';
      });
      img.addEventListener('error', function () {
        if (gif !== img) return;
        stop('error');
        error.hidden = false;
      });
      terminal.hidden = true;
      error.hidden = true;
      demo.dataset.state = 'loading';
      stage.appendChild(img);
    }

    // Demos play in view; the site-wide motion switch also stops and resumes them.
    var inView = false;
    function sync() {
      if (!motionOK()) {
        if (gif) stop('poster');
      } else if (inView && !gif && demo.dataset.state !== 'error') {
        start();
      }
    }
    demoSyncs.push(sync);
    if ('IntersectionObserver' in win) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.4 }).observe(demo);
    } else {
      inView = true;
      sync();
    }
  }

  // Media states (item 11)
  function watchMedia(media) {
    var img = media.querySelector('img');
    if (!img) return;
    media.dataset.state = 'loading';
    img.addEventListener('load', function () { media.dataset.state = 'loaded'; });
    img.addEventListener('error', function () { media.dataset.state = 'missing'; });
    if (img.complete) media.dataset.state = img.naturalWidth > 0 ? 'loaded' : 'missing';
  }

  // Clipboard (item 13)
  function copyValue(btn) {
    if (btn.classList.contains('is-copied')) return;
    var value = btn.getAttribute('data-copy');
    var label = btn.querySelector('[data-copy-label]');
    var status = btn.parentElement.querySelector('[data-copy-status]');
    var original = label ? label.textContent : '';
    function fallback() { location.href = 'mailto:' + value; }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return;
    }
    var write;
    try {
      write = navigator.clipboard.writeText(value);
    } catch (err) {
      write = Promise.reject(err);
    }
    write.then(function () {
      btn.classList.add('is-copied');
      if (label) label.textContent = 'Copied';
      setHidden(btn, '.icon-copy', true);
      setHidden(btn, '.icon-check', false);
      if (status) status.textContent = 'Email address copied';
      win.setTimeout(function () {
        btn.classList.remove('is-copied');
        if (label) label.textContent = original;
        setHidden(btn, '.icon-copy', false);
        setHidden(btn, '.icon-check', true);
        if (status) status.textContent = '';
      }, 1800);
    }, fallback);
  }

  // Menu (item 14). While open, the page is inert so focus stays in the panel.
  function setMenu(open, refocus) {
    html.classList.toggle('menu-open', open);
    if (main) main.inert = open;
    if (header) header.inert = open;
    if (footEl) footEl.inert = open;
    var skip = doc.querySelector('.skip-link');
    if (skip) skip.inert = open;
    if (panel) panel.inert = !open;
    if (fab) {
      fab.setAttribute('aria-expanded', String(open));
      var label = fab.querySelector('[data-menu-label]');
      if (label) label.textContent = open ? 'Close menu' : 'Open menu';
    }
    if (open) {
      var first = panel ? panel.querySelector('.menu-link') : null;
      if (first) first.focus();
    } else if (refocus && fab) {
      fab.focus();
    }
  }

  // Page transitions (item 15)
  function fileOf(path) {
    var name = path.slice(path.lastIndexOf('/') + 1) || 'index.html';
    return PAGE_LABELS[name + '.html'] ? name + '.html' : name;
  }
  function folderOf(path) { return path.slice(0, path.lastIndexOf('/') + 1); }

  function onLinkClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!html.classList.contains('fx')) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target || a.hasAttribute('download')) return;
    var url = new URL(a.href);
    var name = fileOf(url.pathname);
    var label = PAGE_LABELS[name];
    if (!label || url.origin !== location.origin) return;
    if (folderOf(url.pathname) !== folderOf(location.pathname)) return;
    if (name === fileOf(location.pathname)) return;
    if (html.classList.contains('is-leaving')) { e.preventDefault(); return; }
    e.preventDefault();
    try { sessionStorage.setItem('dp-curtain', label); } catch (err) { /* storage unavailable */ }
    var curtain = doc.createElement('div');
    curtain.className = 'curtain';
    curtain.setAttribute('aria-hidden', 'true');
    var span = doc.createElement('span');
    span.textContent = label;
    curtain.appendChild(span);
    doc.body.appendChild(curtain);
    void curtain.offsetWidth;
    html.classList.add('is-leaving');
    pendingNav = win.setTimeout(function () { location.href = url.href; }, 650);
  }

  function runEntering() {
    if (!html.classList.contains('entering')) return;
    win.requestAnimationFrame(function () {
      win.requestAnimationFrame(function () { html.classList.add('entered'); });
    });
    win.setTimeout(function () {
      html.classList.remove('entering', 'entered');
      html.removeAttribute('data-curtain');
    }, 850);
  }

  // Preloader (item 16). endPreload also runs when motion is switched off mid-preload.
  function removePreloadListeners() {
    doc.removeEventListener('keydown', skipPreload);
    doc.removeEventListener('pointerdown', skipPreload);
  }
  function skipPreload() {
    preloadTimers.forEach(function (t) { win.clearTimeout(t); });
    revealHero();
    removePreloadListeners();
    preloadTimers = [win.setTimeout(endPreload, 900)];
  }
  // The panel lifts and the hero rises in behind it. hero-enter is removed once its animations have finished.
  function revealHero() {
    html.classList.add('preloaded', 'hero-enter');
    win.setTimeout(function () { html.classList.remove('hero-enter'); }, 1600);
  }
  function endPreload() {
    preloadTimers.forEach(function (t) { win.clearTimeout(t); });
    preloadTimers = [];
    removePreloadListeners();
    html.classList.remove('preload', 'preloaded');
  }
  function runPreloader() {
    if (!html.classList.contains('preload')) return;
    if (!motionOK()) {
      endPreload();
      return;
    }
    // "Hi," then "I'm Josh" fade in (CSS), the panel lifts at 1.35s and is gone at 2.25s.
    preloadTimers = [
      win.setTimeout(revealHero, 1350),
      win.setTimeout(endPreload, 2250)
    ];
    doc.addEventListener('keydown', skipPreload, { passive: true });
    doc.addEventListener('pointerdown', skipPreload, { passive: true });
  }

  function onScroll() {
    var y = win.scrollY;
    html.classList.toggle('scrolled', y > win.innerHeight * 0.6);
    requestAll();
  }

  // Preview list (item 10). Each list has its own .preview and easing state.
  function initPreview(list) {
    var preview = list.querySelector('.preview');
    if (!preview) return;
    function placePreview() {
      var width = preview.offsetWidth;
      var height = preview.offsetHeight;
      var edge = 16;
      var gap = cursorEl.offsetWidth / 2 + edge;
      var vw = html.clientWidth;
      var vh = win.innerHeight;
      var x = Math.max(edge, Math.min(cur.x - width / 2, vw - width - edge));
      var y = Math.max(edge, Math.min(cur.y - height / 2, vh - height - edge));
      var positions = [
        [cur.x + gap, y], [cur.x - gap - width, y],
        [x, cur.y - gap - height], [x, cur.y + gap]
      ];
      var position = positions.find(function (p) {
        return p[0] >= edge && p[1] >= edge && p[0] + width <= vw - edge && p[1] + height <= vh - edge;
      });
      // On very small mouse viewports, keep the circle rather than cover text or clip the preview.
      preview.style.visibility = position ? '' : 'hidden';
      if (!position) return;
      preview.style.setProperty('--x', position[0] + 'px');
      preview.style.setProperty('--y', position[1] + 'px');
    }

    list.addEventListener('pointerover', function (e) {
      var row = e.target.closest('[data-preview-index]');
      if (!row || !cursorEl || !hoverFine.matches || !motionOK()) return;
      preview.style.setProperty('--i', row.dataset.previewIndex);
      preview.classList.add('is-on');
      cursorPreview = placePreview;
      placePreview();
    });
    list.addEventListener('pointerleave', function () {
      preview.classList.remove('is-on');
      if (cursorPreview === placePreview) cursorPreview = null;
    }, { passive: true });
  }

  // ---- v4: hero letters, curve, clock, logo ----

  // Letter collision: each letter of the hero name drifts at its own speed and turns as the first screen scrolls away.
  function splitCollide(root) {
    var text = root.textContent;
    root.textContent = '';
    Array.prototype.forEach.call(text, function (ch) {
      var s = doc.createElement('span');
      if (ch === ' ') {
        s.className = 'collide__sp';
        s.textContent = ' ';
        root.appendChild(s);
        return;
      }
      s.className = 'collide__l';
      s.textContent = ch;
      root.appendChild(s);
      // Letters keep drifting above their original box until they leave the viewport.
      collideLetters.push({ el: s, speed: 1 + Math.random() * 0.7, rot: Math.random() * 60 - 30 });
    });
  }

  function collideJob() {
    if (!collideLetters.length) return false;
    var vh = win.innerHeight;
    var p = motionOK() ? clamp01(win.scrollY / vh) : 0;
    // The lift scales with the name's own height, so the small phone name does not break up faster than the desktop one.
    var box = collideLetters[0].el.closest('.collide');
    var lift = box ? box.offsetHeight * 5 : vh * 0.9;
    collideLetters.forEach(function (l) {
      l.el.style.transform = p > 0 ? 'translate3d(0,' + ((1 - l.speed) * p * lift).toFixed(1) +
        'px,0) rotate(' + (l.rot * p).toFixed(2) + 'deg)' : '';
    });
    return false;
  }

  // A short curved reveal follows main's bottom edge; the footer stays in normal flow.
  function curveJob() {
    var vh = win.innerHeight;
    var on = motionOK();
    var edge = main ? main.getBoundingClientRect().bottom : vh;
    // The ink menu pill turns white once the dark footer reaches it.
    html.classList.toggle('pill-dark', edge < 70);
    curves.forEach(function (c) {
      c.style.setProperty('--curve-p', on ? clamp01((vh - edge) / vh).toFixed(4) : '1');
    });
    return false;
  }

  // Local time in San Diego for the footer.
  function startClock() {
    var els = all('[data-clock]');
    if (!els.length || !win.Intl) return;
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    function paint() {
      var t = fmt.format(new Date());
      els.forEach(function (el) { el.textContent = t; });
    }
    paint();
    win.setInterval(paint, 15000);
  }

  // Header logo: "Built by Josh" slides to "Joshua Do" on hover. CSS needs the width of "Built by ".
  function measureLogo() {
    var shift = doc.querySelector('[data-logo-shift]');
    var track = doc.querySelector('[data-logo-track]');
    if (shift && track) track.style.setProperty('--logo-shift', shift.getBoundingClientRect().width + 'px');
  }

  function onResize() {
    measureLogo();
    if (smooth.running) smooth.target = Math.min(smooth.target, maxScroll());
    requestAll();
  }

  // ---- v4: spring cursor (mouse only, motion on) ----
  function syncCursor() {
    var want = hoverFine.matches && motionOK();
    if (want && !cursorEl) {
      cursorEl = doc.createElement('div');
      cursorEl.className = 'cursor';
      cursorEl.setAttribute('aria-hidden', 'true');
      cursorEl.innerHTML = '<span class="cursor__label"></span>';
      doc.body.appendChild(cursorEl);
      cur.placed = false;
    } else if (!want && cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
  }

  // Spring: stiffness 500, damping 25, mass 1, two half steps per frame.
  function cursorJob(now) {
    if (!cursorEl) return false;
    var dt = cur.last ? Math.min((now - cur.last) / 1000, 1 / 30) : 1 / 60;
    cur.last = now;
    var h = dt / 2;
    for (var i = 0; i < 2; i++) {
      cur.vx += (500 * (cur.tx - cur.x) - 25 * cur.vx) * h;
      cur.vy += (500 * (cur.ty - cur.y) - 25 * cur.vy) * h;
      cur.x += cur.vx * h;
      cur.y += cur.vy * h;
    }
    cursorEl.style.translate = cur.x.toFixed(1) + 'px ' + cur.y.toFixed(1) + 'px';
    if (cursorPreview) cursorPreview();
    var moving = Math.abs(cur.tx - cur.x) > 0.1 || Math.abs(cur.ty - cur.y) > 0.1 ||
      Math.abs(cur.vx) > 1 || Math.abs(cur.vy) > 1;
    if (!moving) cur.last = 0;
    return moving;
  }

  function onCursorMove(e) {
    if (!cursorEl || e.pointerType !== 'mouse') return;
    cur.tx = e.clientX;
    cur.ty = e.clientY;
    if (!cur.placed) {
      cur.x = cur.tx;
      cur.y = cur.ty;
      cur.vx = 0;
      cur.vy = 0;
      cur.placed = true;
    }
    cursorEl.classList.add('is-on');
    schedule(cursorJob);
  }

  function onCursorOver(e) {
    if (!cursorEl || !e.target.closest) return;
    var labelled = e.target.closest('[data-cursor]');
    var hot = e.target.closest('a[href], button, [role="button"], label, summary, input, select, textarea');
    var label = cursorEl.querySelector('.cursor__label');
    cursorEl.classList.toggle('is-label', !!labelled);
    cursorEl.classList.toggle('is-hover', !labelled && !!hot);
    if (label) label.textContent = labelled ? labelled.getAttribute('data-cursor') : '';
  }

  // ---- v4: smooth wheel scrolling (mouse or trackpad, motion on). Keyboard, scrollbar and touch stay native. ----
  function syncSmooth() {
    smooth.on = hoverFine.matches && motionOK();
    html.classList.toggle('smooth', smooth.on);
    if (!smooth.on) smooth.running = false;
  }

  function maxScroll() { return Math.max(0, html.scrollHeight - win.innerHeight); }

  function scrollableParent(node) {
    for (var el = node; el && el !== doc.body && el !== html; el = el.parentElement) {
      var oy = win.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }

  function startSmooth() {
    if (!smooth.running) {
      smooth.running = true;
      smooth.last = 0;
    }
    schedule(smoothJob);
  }

  function onWheel(e) {
    if (!smooth.on || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    if (html.classList.contains('menu-open')) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (scrollableParent(e.target)) return;
    var d = e.deltaY * (e.deltaMode === 1 ? 100 / 6 : e.deltaMode === 2 ? win.innerHeight : 1);
    e.preventDefault();
    if (!smooth.running || Math.abs(win.scrollY - smooth.current) > 2) {
      smooth.current = win.scrollY;
      smooth.target = win.scrollY;
    }
    smooth.target = Math.min(Math.max(smooth.target + d, 0), maxScroll());
    startSmooth();
  }

  function smoothJob(now) {
    if (!smooth.running) return false;
    // Something else moved the page (scrollbar drag, keyboard, find): hand control back.
    if (Math.abs(win.scrollY - smooth.current) > 2) {
      smooth.running = false;
      return false;
    }
    var dt = smooth.last ? Math.min((now - smooth.last) / 1000, 0.1) : 1 / 60;
    smooth.last = now;
    smooth.current += (smooth.target - smooth.current) * (1 - Math.exp(-7 * dt));
    if (Math.abs(smooth.target - smooth.current) < 0.5) {
      smooth.current = smooth.target;
      smooth.running = false;
    }
    win.scrollTo(0, smooth.current);
    return smooth.running;
  }

  // The footer starts at its return cue; other anchors keep the shared header clearance.
  function hashTargetY(el) {
    var pad = parseFloat(win.getComputedStyle(html).scrollPaddingTop) || 0;
    var y = 0;
    for (var n = el; n; n = n.offsetParent) y += n.offsetTop;
    return Math.min(Math.max(y - (el === footEl ? 0 : pad), 0), maxScroll());
  }

  // With motion on, same-page hash links scroll here (wheel easing on fine pointers, CSS smooth scroll otherwise).
  function onHashClick(e) {
    if (!motionOK() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target) return;
    var url = new URL(a.href);
    if (!url.hash || url.origin !== location.origin || folderOf(url.pathname) !== folderOf(location.pathname) || fileOf(url.pathname) !== fileOf(location.pathname) || url.search !== location.search) return;
    var el = doc.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (!el) return;
    e.preventDefault();
    if (smooth.on) {
      if (!smooth.running) smooth.current = win.scrollY;
      smooth.target = hashTargetY(el);
      startSmooth();
    } else {
      win.scrollTo(0, hashTargetY(el));
    }
    try { history.pushState(null, '', url.hash); } catch (err) { /* history unavailable */ }
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }

  // Keep the header/menu entry available while the PDF is pending; other résumé actions hide until it exists.
  var resumeReady = Promise.resolve(true);
  function checkResume() {
    var links = all('a[data-resume]');
    if (links.length && /^https?:$/.test(location.protocol) && win.fetch) {
      resumeReady = win.fetch(links[0].href, { method: 'HEAD' }).then(function (res) {
        var available = res.status !== 404 && res.status !== 410;
        if (!available) {
          links.forEach(function (a) { a.hidden = !a.hasAttribute('data-resume-nav'); });
          all('[data-resume-fallback]').forEach(function (el) { el.classList.add('btn--pop'); });
        }
        return available;
      }).catch(function () { return true; }); // Offline: keep the direct PDF actions available.
    }
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !doc.createElement('dialog').showModal) return;
        e.preventDefault();
        var trigger = a.closest('#menu') ? fab : a;
        resumeReady.then(function (available) {
          if (html.classList.contains('menu-open')) setMenu(false, false);
          openResume(a.href, trigger, available);
        });
      });
    });
  }

  // Résumé dialog: the PDF in a modal, with Download and Open links. Touch screens and browsers without a
  // built-in PDF viewer get the two links and a short note instead, because phones do not show PDFs in frames.
  var resumeDialog = null;
  var resumeTrigger = null;
  function openResume(href, trigger, available) {
    if (!resumeDialog) {
      resumeDialog = doc.createElement('dialog');
      resumeDialog.className = 'resume-dialog';
      resumeDialog.setAttribute('aria-labelledby', 'resume-title');
      resumeDialog.innerHTML = '<div class="resume-dialog__bar"><h2 class="resume-dialog__title" id="resume-title">Résumé</h2>' +
        '<a class="btn btn--pop" data-resume-download download="Joshua-Do-Resume.pdf"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Download</a>' +
        '<a class="btn resume-dialog__open" data-resume-open target="_blank" rel="noopener">Open in new tab <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 17 17 7M8 7h9v9"/></svg></a>' +
        '<button class="btn resume-dialog__close" type="button" aria-label="Close résumé"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
        '<div class="resume-dialog__body"></div>';
      doc.body.appendChild(resumeDialog);
      resumeDialog.querySelector('.resume-dialog__close').addEventListener('click', function () { resumeDialog.close(); });
      resumeDialog.addEventListener('close', function () {
        if (resumeTrigger && resumeTrigger.isConnected) resumeTrigger.focus({ preventScroll: true });
      });
      // A click on the dimmed backdrop lands on the dialog element itself.
      resumeDialog.addEventListener('click', function (e) { if (e.target === resumeDialog) resumeDialog.close(); });
    }
    resumeTrigger = trigger;
    resumeDialog.querySelector('[data-resume-download]').href = href;
    resumeDialog.querySelector('[data-resume-open]').href = href;
    var body = resumeDialog.querySelector('.resume-dialog__body');
    var noViewer = navigator.pdfViewerEnabled === false || !finePointer.matches;
    if (body.dataset.href !== href) body.innerHTML = '';
    body.dataset.href = href;
    resumeDialog.classList.toggle('is-note', noViewer || !available);
    if (!available) {
      body.innerHTML = '<p class="resume-dialog__note">Résumé coming soon.</p>';
      if (!resumeDialog.open) resumeDialog.showModal();
      return;
    }
    if (noViewer && !body.querySelector('.resume-dialog__note')) {
      body.innerHTML = '<p class="resume-dialog__note">Download the PDF, or open it in a new tab.</p><div class="cta-row resume-dialog__actions">' +
        '<a class="btn btn--pop" download="Joshua-Do-Resume.pdf"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Download</a>' +
        '<a class="btn" target="_blank" rel="noopener">Open in new tab <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 17 17 7M8 7h9v9"/></svg></a></div>';
      body.querySelectorAll('a').forEach(function (a) { a.href = href; });
    } else if (!noViewer && !body.querySelector('iframe')) {
      body.innerHTML = '<iframe title="Résumé (PDF)"></iframe>';
      body.firstChild.src = href;
    }
    if (!resumeDialog.open) resumeDialog.showModal();
  }

  function init() {
    html.classList.add('js');

    fab = doc.querySelector('[data-menu-toggle]');
    panel = doc.getElementById('menu');
    main = doc.getElementById('main');
    header = doc.querySelector('[data-head]');
    footEl = doc.querySelector('[data-foot]');
    curves = all('[data-curve]');
    progressEl = doc.querySelector('.progress');
    article = doc.querySelector('[data-article]');
    magnetics = all('[data-magnetic]');
    pageJobs = [wordsJob, driftJob, progressJob, collideJob, curveJob];

    safe('reveal words', function () {
      all('[data-reveal-words]').forEach(function (el) {
        wordSets.push({ el: el, spans: wrapWords(el) });
      });
    });

    safe('photo drift', function () {
      all('[data-drift]').forEach(function (el) {
        drifts.push({
          el: el,
          box: el.closest('.photo-rows') || el.parentElement,
          dir: parseFloat(el.dataset.drift) || 1
        });
      });
    });

    safe('media states', function () { all('.media').forEach(watchMedia); });
    safe('demo', function () { all('[data-demo]').forEach(initDemo); });

    safe('copy', function () {
      all('[data-copy]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          copyValue(btn);
        });
      });
    });

    safe('motion toggle', function () {
      all('[data-motion-toggle]').forEach(function (btn) {
        btn.addEventListener('click', onMotionToggle);
      });
    });

    // Magnetic (item 9)
    safe('magnetic', function () {
      magnetics.forEach(function (el) {
        el.addEventListener('pointermove', function (e) {
          if (!finePointer.matches || !motionOK()) return;
          var r = el.getBoundingClientRect();
          var dx = e.clientX - (r.left + r.width / 2);
          var dy = e.clientY - (r.top + r.height / 2);
          var inner = el.querySelector('.magnetic-inner');
          el.style.transition = '';
          el.style.transform = 'translate(' + dx * 0.4 + 'px,' + dy * 0.4 + 'px)';
          if (inner) {
            inner.style.transition = '';
            inner.style.transform = 'translate(' + dx * 0.15 + 'px,' + dy * 0.15 + 'px)';
          }
        }, { passive: true });
        el.addEventListener('pointerleave', function () { resetMagnet(el); }, { passive: true });
      });
    });

    safe('preview list', function () {
      all('[data-preview-list]').forEach(initPreview);
    });

    // Reveal (item 4) and counts (item 6)
    safe('reveal', function () {
      var revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          en.target.classList.add('is-in');
          revealIO.unobserve(en.target);
        });
      }, { rootMargin: '0px 0px -10% 0px' });
      all('.reveal').forEach(function (el) { revealIO.observe(el); });
    });

    safe('counts', function () {
      all('[data-count]').forEach(function (el) {
        var io = new IntersectionObserver(function (entries) {
          if (!entries[0].isIntersecting) return;
          io.disconnect();
          if (motionOK()) startCount(el);
        }, { rootMargin: '0px 0px -10% 0px' });
        io.observe(el);
      });
    });

    // Menu wiring (item 14)
    safe('menu', function () {
      if (fab) fab.addEventListener('click', function () {
        setMenu(!html.classList.contains('menu-open'), true);
      });
      var scrim = doc.querySelector('[data-menu-close]');
      if (scrim) scrim.addEventListener('click', function () { setMenu(false, true); });
      if (panel) panel.addEventListener('click', function (e) {
        var a = e.target.closest('a');
        if (!a) return;
        setMenu(false, false);
        var u = new URL(a.href);
        if (u.pathname !== location.pathname || !u.hash) return;
        var target = doc.getElementById(decodeURIComponent(u.hash.slice(1)));
        if (!target) return;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });
      doc.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && html.classList.contains('menu-open')) setMenu(false, true);
      }, { passive: true });
      setMenu(false, false);
    });

    // Page transitions and bfcache (item 15)
    safe('transitions', function () {
      doc.addEventListener('click', onLinkClick);
      win.addEventListener('pageshow', function (e) {
        if (!e.persisted) return;
        win.clearTimeout(pendingNav);
        html.classList.remove('is-leaving');
        all('.curtain').forEach(function (c) { c.remove(); });
        try { sessionStorage.removeItem('dp-curtain'); } catch (err) { /* storage unavailable */ }
        setMenu(false, false);
        syncMotion();
      });
    });

    safe('scroll and resize', function () {
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('resize', onResize, { passive: true });
      doc.addEventListener('visibilitychange', function () {
        if (!doc.hidden && jobs.length) kick();
      });
    });

    safe('reduced motion', function () {
      var onReduce = function () { syncMotion(); };
      if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', onReduce);
      else if (reducedMotion.addListener) reducedMotion.addListener(onReduce);
    });

    safe('collide', function () { all('[data-collide]').forEach(splitCollide); });
    safe('logo', function () { measureLogo(); win.addEventListener('load', measureLogo); });
    safe('clock', startClock);
    safe('cursor', function () {
      win.addEventListener('pointermove', onCursorMove, { passive: true });
      doc.addEventListener('pointerover', onCursorOver, { passive: true });
      doc.addEventListener('pointerdown', function () { if (cursorEl) cursorEl.classList.add('is-down'); }, { passive: true });
      doc.addEventListener('pointerup', function () { if (cursorEl) cursorEl.classList.remove('is-down'); }, { passive: true });
      doc.addEventListener('mouseout', function (e) {
        if (cursorEl && !e.relatedTarget) {
          cursorEl.classList.remove('is-on');
          cur.placed = false;
        }
      }, { passive: true });
    });
    safe('smooth scroll', function () {
      win.addEventListener('wheel', onWheel, { passive: false });
      doc.addEventListener('click', onHashClick);
    });
    safe('fine pointer', function () {
      var onFine = function () { syncCursor(); syncSmooth(); };
      if (hoverFine.addEventListener) hoverFine.addEventListener('change', onFine);
      else if (hoverFine.addListener) hoverFine.addListener(onFine);
    });

    safe('motion sync', syncMotion);
    safe('scroll state', onScroll);
    safe('entering', runEntering);
    safe('preloader', runPreloader);
    safe('resume', checkResume);
    html.classList.add('js-ready');
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
