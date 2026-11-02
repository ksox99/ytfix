/*
 * YouTube Sort by Upload Date
 *
 * YouTube removed "Sort by: Upload date" from search in January 2026, and the
 * old `&sp=CAI%253D` URL trick no longer forces chronological order. So this
 * script sorts the results itself:
 *
 *  1. It reads each result's "3 days ago" style timestamp.
 *  2. It reorders results with CSS `order`. The result list becomes one flex
 *     column (wrappers get `display: contents`). DOM nodes are never moved,
 *     so YouTube's own rendering and infinite scroll keep working.
 *  3. It can preload a few extra pages of results, so the sort covers more
 *     than the first ~20 results.
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULTS = { sortEnabled: true, preloadPages: 3, hideShelves: true };
  let settings = { ...DEFAULTS };

  // ---------------------------------------------------------------------------
  // Parsing "N <unit> ago" timestamps (several languages)
  // ---------------------------------------------------------------------------

  const S = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };

  // Word stems mapped to unit length. Longer stems are checked first.
  const UNIT_STEMS = [
    // English
    ['second', S.second], ['minute', S.minute], ['hour', S.hour], ['day', S.day],
    ['week', S.week], ['month', S.month], ['year', S.year],
    // German
    ['sekunde', S.second], ['stunde', S.hour], ['tag', S.day], ['woche', S.week],
    ['monat', S.month], ['jahr', S.year],
    // Spanish / Portuguese / Italian
    ['segundo', S.second], ['minuto', S.minute], ['hora', S.hour], ['día', S.day],
    ['dia', S.day], ['semana', S.week], ['mes', S.month], ['mês', S.month],
    ['año', S.year], ['ano', S.year], ['secondo', S.second], ['ora', S.hour], ['ore', S.hour],
    ['giorn', S.day], ['settiman', S.week], ['mese', S.month], ['mesi', S.month], ['ann', S.year],
    // French
    ['seconde', S.second], ['heure', S.hour], ['jour', S.day], ['semaine', S.week],
    ['mois', S.month], ['an', S.year],
    // Dutch
    ['minuut', S.minute], ['minuten', S.minute], ['uur', S.hour],
    ['dag', S.day], ['weken', S.week], ['maand', S.month], ['jaar', S.year],
  ].sort((a, b) => b[0].length - a[0].length);

  const NUM_WORD_RE = /(\d+)\s*([^\s\d.,:;·•()]+)/gu;
  const LIVE_RE = /\b(watching|live now)\b|zuschauer|espectadores|spectateurs/i;

  /** Returns age in seconds for a short metadata string, or null. */
  function parseAge(text) {
    if (!text || text.length > 60) return null;
    const lower = text.toLowerCase();
    NUM_WORD_RE.lastIndex = 0;
    let m;
    while ((m = NUM_WORD_RE.exec(lower))) {
      const n = parseInt(m[1], 10);
      const word = m[2];
      for (const [stem, secs] of UNIT_STEMS) {
        if (word.startsWith(stem)) {
          // "an" (French year) must be the whole word ("an"/"ans").
          if (stem === 'an' && !/^ans?$/.test(word)) continue;
          return n * secs;
        }
      }
    }
    return null;
  }

  const META_SEL = [
    '#metadata-line span',                       // classic ytd-video-renderer
    'yt-content-metadata-view-model span',       // new "lockup" layout
    '.yt-content-metadata-view-model-wiz__metadata-text',
    '.yt-content-metadata-view-model__metadata-text',
  ].join(',');

  const AGE_LIVE = -1;      // live streams first
  const AGE_UNKNOWN = Infinity;

  function getAge(el) {
    const spans = el.querySelectorAll(META_SEL);
    for (const span of spans) {
      const t = span.textContent.trim();
      if (!t) continue;
      const age = parseAge(t);
      if (age !== null) return age;
      if (LIVE_RE.test(t)) return AGE_LIVE;
    }
    if (el.querySelector('.badge-style-type-live-now-alternate, .badge-style-type-live-now, [aria-label="LIVE"]')) {
      return AGE_LIVE;
    }
    return AGE_UNKNOWN; // upcoming premieres, playlists, etc.
  }

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  const ITEM_SEL = 'ytd-item-section-renderer > #contents > *';
  const VIDEO_TAGS = new Set(['YTD-VIDEO-RENDERER', 'YT-LOCKUP-VIEW-MODEL']);

  const isResultsPage = () => location.pathname === '/results';
  const getSearchRoot = () => document.querySelector('ytd-search');

  let lastStats = { sorted: 0, dated: 0 };

  function applySort() {
    const root = getSearchRoot();
    if (!root) return;
    const on = settings.sortEnabled && isResultsPage();
    root.classList.toggle('ytfix-sorted', on);
    root.classList.toggle('ytfix-hide-shelves', on && settings.hideShelves);

    const children = root.querySelectorAll(ITEM_SEL);
    if (!on) {
      for (const el of children) el.style.removeProperty('order');
      lastStats = { sorted: 0, dated: 0 };
      return;
    }

    const videos = [];
    let index = 0;
    for (const el of children) {
      index++;
      if (VIDEO_TAGS.has(el.tagName) && !el.hidden) {
        videos.push({ el, index, age: getAge(el) });
      } else {
        el.style.removeProperty('order'); // falls back to CSS default (bottom)
      }
    }
    // Newest first; ties keep YouTube's relevance order.
    videos.sort((a, b) => (a.age - b.age) || (a.index - b.index));
    videos.forEach((v, rank) => {
      const order = String(rank + 1);
      if (v.el.style.order !== order) v.el.style.order = order;
    });
    lastStats = {
      sorted: videos.length,
      dated: videos.filter(v => v.age !== AGE_UNKNOWN).length,
    };
  }

  // ---------------------------------------------------------------------------
  // Preloading more result pages
  // ---------------------------------------------------------------------------
  // YouTube loads the next page when its continuation spinner scrolls into
  // view (IntersectionObserver). We pin the spinner invisibly inside the
  // viewport for a moment, which loads the next page without scrolling.

  let preloadRun = 0;
  let preloading = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  }

  const findContinuation = () =>
    getSearchRoot()?.querySelector('ytd-continuation-item-renderer') || null;

  async function preload(pages) {
    const run = ++preloadRun;
    const url = location.href;
    preloading = true;
    renderBar();
    try {
      for (let p = 0; p < pages; p++) {
        const cont = await waitFor(findContinuation, 6000);
        if (!cont || run !== preloadRun || location.href !== url) break;
        cont.classList.add('ytfix-trigger');
        const loaded = await waitFor(() => !cont.isConnected || findContinuation() !== cont, 10000);
        cont.classList.remove('ytfix-trigger');
        if (!loaded || run !== preloadRun) break;
        scheduleUpdate();
      }
    } finally {
      if (run === preloadRun) {
        preloading = false;
        scheduleUpdate();
      }
    }
  }

  function cancelPreload() {
    preloadRun++;
    preloading = false;
    document.querySelectorAll('.ytfix-trigger').forEach(el => el.classList.remove('ytfix-trigger'));
  }

  // ---------------------------------------------------------------------------
  // Toolbar UI
  // ---------------------------------------------------------------------------

  let bar = null;

  function buildBar() {
    bar = document.createElement('div');
    bar.id = 'ytfix-bar';

    const label = document.createElement('span');
    label.className = 'ytfix-label';
    label.textContent = 'Sort by';

    const mk = (key, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ytfix-chip';
      b.dataset.key = key;
      b.textContent = text;
      return b;
    };
    const relevance = mk('relevance', 'Relevance');
    const newest = mk('newest', 'Upload date (newest)');
    const more = mk('more', 'Load more results');
    more.classList.add('ytfix-more');

    const status = document.createElement('span');
    status.className = 'ytfix-status';

    relevance.addEventListener('click', () => setSortEnabled(false));
    newest.addEventListener('click', () => setSortEnabled(true));
    more.addEventListener('click', () => preload(Math.max(1, settings.preloadPages)));

    bar.append(label, relevance, newest, more, status);
  }

  function ensureBar() {
    if (!isResultsPage()) {
      bar?.remove();
      return;
    }
    const primary = getSearchRoot()?.querySelector('#primary');
    if (!primary) return;
    if (!bar) buildBar();
    if (bar.parentNode !== primary || primary.firstElementChild !== bar) primary.prepend(bar);
    renderBar();
  }

  function renderBar() {
    if (!bar) return;
    const on = settings.sortEnabled;
    bar.querySelector('[data-key="relevance"]').classList.toggle('ytfix-active', !on);
    bar.querySelector('[data-key="newest"]').classList.toggle('ytfix-active', on);
    const more = bar.querySelector('[data-key="more"]');
    more.hidden = !on;
    more.disabled = preloading;
    const status = bar.querySelector('.ytfix-status');
    if (!on) {
      status.textContent = '';
    } else if (preloading) {
      status.textContent = `Loading more results… (${lastStats.sorted} so far)`;
    } else {
      const undated = lastStats.sorted - lastStats.dated;
      status.textContent = `${lastStats.sorted} videos sorted` +
        (undated > 0 ? ` (${undated} without a date at the end)` : '');
    }
  }

  function setSortEnabled(on) {
    if (settings.sortEnabled === on) return;
    settings.sortEnabled = on;
    try { api.storage.local.set({ sortEnabled: on }); } catch (_) { /* ignore */ }
    if (!on) cancelPreload();
    update();
    if (on && settings.preloadPages > 0) preload(settings.preloadPages);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function update() {
    ensureBar();
    applySort();
    renderBar();
  }

  let pending = false;
  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; update(); }, 120);
  }

  function onNavigate() {
    cancelPreload();
    scheduleUpdate();
    if (isResultsPage() && settings.sortEnabled && settings.preloadPages > 0) {
      preload(settings.preloadPages);
    }
  }

  async function init() {
    try {
      const stored = await api.storage.local.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
    } catch (_) { /* use defaults */ }

    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const k of Object.keys(DEFAULTS)) {
          if (k in changes) settings[k] = changes[k].newValue;
        }
        scheduleUpdate();
      });
    } catch (_) { /* ignore */ }

    new MutationObserver(() => {
      if (isResultsPage() || bar?.isConnected) scheduleUpdate();
    }).observe(document.documentElement, { childList: true, subtree: true });

    // YouTube is a single-page app; this fires after each in-app navigation.
    document.addEventListener('yt-navigate-finish', onNavigate);
    onNavigate();
  }

  // Exposed for tests only.
  if (typeof window !== 'undefined') window.__ytfixParseAge = parseAge;

  init();
})();
