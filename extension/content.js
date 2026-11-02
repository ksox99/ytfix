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

  const DEFAULTS = { sortEnabled: true, preloadPages: 3, hideShelves: true, loadAllWhenFiltered: true };
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

  // Short forms YouTube uses ("33 min ago", "3mo ago", "1y ago"). They must
  // match the whole word. "m" on its own is left out because "6.5M views" uses it.
  const UNIT_ABBREVIATIONS = new Map([
    ['s', S.second], ['sec', S.second], ['secs', S.second],
    ['min', S.minute], ['mins', S.minute],
    ['h', S.hour], ['hr', S.hour], ['hrs', S.hour], ['std', S.hour],
    ['d', S.day],
    ['w', S.week], ['wk', S.week], ['wks', S.week],
    ['mo', S.month], ['mos', S.month],
    ['y', S.year], ['yr', S.year], ['yrs', S.year],
  ]);

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
      if (UNIT_ABBREVIATIONS.has(word)) return n * UNIT_ABBREVIATIONS.get(word);
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

  // Places a date never comes from: titles and description snippets.
  const NOT_META = 'h3, #video-title, [class*="title"], .metadata-snippet-container, ' +
    '#description-text, [class*="description"], [class*="snippet"]';

  function ageFromTexts(nodes, skipNonMeta) {
    for (const node of nodes) {
      if (skipNonMeta && node.closest(NOT_META)) continue;
      const t = node.textContent.trim();
      if (!t || t.length > 60) continue;
      const age = parseAge(t);
      if (age !== null) return age;
      if (LIVE_RE.test(t)) return AGE_LIVE;
    }
    return null;
  }

  function getAge(el) {
    // Known metadata containers first, then any short text in the card as a
    // fallback, in case YouTube changes its layout again.
    const age = ageFromTexts(el.querySelectorAll(META_SEL), false) ??
      ageFromTexts(el.querySelectorAll('span, yt-formatted-string'), true);
    if (age !== null) return age;
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

  // ---------------------------------------------------------------------------
  // Upload-time buttons: Any time / Last hour / Today / This week
  // ---------------------------------------------------------------------------
  // "Today" and "This week" just apply YouTube's own upload-date filter, which
  // still works. YouTube has no "Last hour" filter any more (the old code is
  // unreliable), so "Last hour" applies "Today" and then hides anything older
  // than an hour in the browser.

  const SP_TODAY = 'EgIIAg==';
  const SP_WEEK = 'EgIIAw==';
  const DATE_TODAY = 2, DATE_WEEK = 3;
  const HOUR_KEY = 'ytfix-last-hour';
  const ONE_HOUR = 3600;
  const ALL_PAGES = 60; // "load everything" safety cap (~1200 results)
  let navigating = false;

  const getQuery = () => new URLSearchParams(location.search).get('search_query') || '';

  // Last hour mode is remembered per tab and per search query.
  function hourMode() {
    if (!isResultsPage()) return false;
    try { return sessionStorage.getItem(HOUR_KEY) === getQuery(); } catch (_) { return false; }
  }
  function setHourMode(on) {
    try {
      if (on) sessionStorage.setItem(HOUR_KEY, getQuery());
      else sessionStorage.removeItem(HOUR_KEY);
    } catch (_) { /* ignore */ }
  }

  /** Which upload-time button is active: 'any', 'hour', 'today', 'week' or '' (YouTube's month/year). */
  function timeMode() {
    if (hourMode()) return 'hour';
    switch (uploadDateFilter()) {
      case 0: return 'any';
      case DATE_TODAY: return 'today';
      case DATE_WEEK: return 'week';
      default: return '';
    }
  }

  function goSearch(sp) {
    // The old results stay on screen until the new page loads, so hide them.
    getSearchRoot()?.classList.add('ytfix-navigating');
    navigating = true;
    renderBar();
    const u = new URL('/results', location.origin);
    u.searchParams.set('search_query', getQuery());
    if (sp) u.searchParams.set('sp', sp);
    location.assign(u.href);
  }

  function setTimeMode(mode) {
    if (mode === timeMode()) return;
    setHourMode(mode === 'hour');
    const sp = { hour: SP_TODAY, today: SP_TODAY, week: SP_WEEK }[mode] || null;
    // Going between Last hour and Today keeps the same YouTube results, so
    // no reload is needed.
    if (sp === SP_TODAY && uploadDateFilter() === DATE_TODAY) {
      update();
      return;
    }
    cancelPreload();
    goSearch(sp);
  }

  // ---------------------------------------------------------------------------
  // Detecting YouTube's own upload-date filter
  // ---------------------------------------------------------------------------
  // The `sp` URL parameter is a base64 protobuf. Field 2 holds the filters,
  // and its field 1 is the upload date (1 = last hour, 2 = today, 3 = week,
  // 4 = month, 5 = year).

  function readVarint(b, i) {
    let v = 0, shift = 0, x;
    do {
      x = b[i++];
      v += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80 && i < b.length);
    return [v, i];
  }

  function protoFields(b) {
    const out = [];
    let i = 0;
    while (i < b.length) {
      let key;
      [key, i] = readVarint(b, i);
      const field = Math.floor(key / 8), type = key & 7;
      if (type === 0) { let v; [v, i] = readVarint(b, i); out.push({ field, v }); }
      else if (type === 2) { let len; [len, i] = readVarint(b, i); out.push({ field, bytes: b.subarray(i, i + len) }); i += len; }
      else if (type === 1) i += 8;
      else if (type === 5) i += 4;
      else break;
    }
    return out;
  }

  function uploadDateFilter() {
    let sp = new URLSearchParams(location.search).get('sp');
    if (!sp) return 0;
    try {
      for (let n = 0; n < 3 && sp.includes('%'); n++) sp = decodeURIComponent(sp);
      const bin = atob(sp.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const filters = protoFields(bytes).find(f => f.field === 2 && f.bytes);
      if (!filters) return 0;
      const date = protoFields(filters.bytes).find(f => f.field === 1 && 'v' in f);
      return date ? date.v : 0;
    } catch (_) {
      return 0;
    }
  }

  /** True when results are limited in time, so loading all of them is cheap and useful. */
  const timeFiltered = () => isResultsPage() && (hourMode() || uploadDateFilter() > 0);

  // ---------------------------------------------------------------------------
  // Applying sort + filter
  // ---------------------------------------------------------------------------

  let lastStats = { total: 0, dated: 0, shown: 0, unreadable: false };

  function applySort() {
    const root = getSearchRoot();
    if (!root) return;
    const results = isResultsPage();
    const sort = settings.sortEnabled && results;
    const hour = hourMode();
    root.classList.toggle('ytfix-sorted', sort);
    root.classList.toggle('ytfix-hide-shelves', (sort || hour) && settings.hideShelves);
    // In Last hour mode, CSS hides every video until it's marked .ytfix-ok
    // below. Videos that are too old never appear, not even briefly.
    root.classList.toggle('ytfix-hour', hour);

    const children = root.querySelectorAll(ITEM_SEL);
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

    // If no dates can be read at all, YouTube's layout probably changed. Show
    // everything rather than an empty page.
    const anyDated = videos.some(v => v.age !== AGE_UNKNOWN);
    const isRecent = v => (v.age >= 0 && v.age <= ONE_HOUR) || (v.age === AGE_UNKNOWN && !anyDated);
    for (const v of videos) v.el.classList.toggle('ytfix-ok', hour && isRecent(v));

    if (sort) {
      // Newest first; ties keep YouTube's relevance order.
      const sorted = [...videos].sort((a, b) => (a.age - b.age) || (a.index - b.index));
      sorted.forEach((v, rank) => {
        const order = String(rank + 1);
        if (v.el.style.order !== order) v.el.style.order = order;
      });
    } else {
      for (const v of videos) v.el.style.removeProperty('order');
    }

    lastStats = {
      total: videos.length,
      dated: videos.filter(v => v.age !== AGE_UNKNOWN).length,
      shown: hour ? videos.filter(isRecent).length : videos.length,
      unreadable: !anyDated && videos.length > 0,
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
  let exhausted = false; // YouTube has no more results for this search

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
        if (run !== preloadRun || location.href !== url) break;
        if (!cont) { exhausted = true; break; }
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

    const mkLabel = text => {
      const s = document.createElement('span');
      s.className = 'ytfix-label';
      s.textContent = text;
      return s;
    };

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
    const times = [['any', 'Any time'], ['hour', 'Last hour'], ['today', 'Today'], ['week', 'This week']]
      .map(([key, text]) => {
        const b = mk('time-' + key, text);
        b.addEventListener('click', () => setTimeMode(key));
        return b;
      });
    const more = mk('more', 'Load all results');
    more.classList.add('ytfix-more');

    const status = document.createElement('span');
    status.className = 'ytfix-status';

    relevance.addEventListener('click', () => setSortEnabled(false));
    newest.addEventListener('click', () => setSortEnabled(true));
    more.addEventListener('click', () => {
      if (preloading) { cancelPreload(); scheduleUpdate(); }
      else preload(ALL_PAGES);
    });

    const sep = document.createElement('span');
    sep.className = 'ytfix-sep';

    bar.append(mkLabel('Sort by'), relevance, newest, sep,
      mkLabel('Uploaded'), ...times, more, status);
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
    const hour = hourMode();
    bar.querySelector('[data-key="relevance"]').classList.toggle('ytfix-active', !on);
    bar.querySelector('[data-key="newest"]').classList.toggle('ytfix-active', on);
    const time = timeMode();
    for (const key of ['any', 'hour', 'today', 'week']) {
      bar.querySelector(`[data-key="time-${key}"]`).classList.toggle('ytfix-active', time === key);
    }
    const more = bar.querySelector('[data-key="more"]');
    more.hidden = (!on && !hour) || (exhausted && !preloading);
    more.textContent = preloading ? 'Stop loading' : 'Load all results';
    const status = bar.querySelector('.ytfix-status');
    if (navigating) {
      more.hidden = true;
      status.textContent = 'Loading…';
      return;
    }
    const { total, dated, shown, unreadable } = lastStats;
    const done = exhausted && !preloading ? ' · all results loaded' : '';
    if (hour) {
      const source = uploadDateFilter() === DATE_TODAY ? '' : ' (tip: no Today filter on, so fewer results to pick from)';
      if (unreadable) {
        status.textContent = `Couldn't read upload dates, showing all ${total} results`;
      } else if (preloading) {
        status.textContent = `${shown} from the last hour so far · checked ${total} of YouTube's results…${source}`;
      } else if (shown === 0) {
        status.textContent = `Nothing from the last hour among ${total} results${done}${source}`;
      } else {
        status.textContent = `${shown} from the last hour (checked ${total})${done}${source}`;
      }
    } else if (!on) {
      status.textContent = '';
    } else if (preloading) {
      status.textContent = `Loading results… (${total} so far)`;
    } else {
      const undated = total - dated;
      status.textContent = `${total} videos sorted` +
        (undated > 0 ? ` (${undated} without a date at the end)` : '') + done;
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
    exhausted = false;
    scheduleUpdate();
    if (timeFiltered() && settings.loadAllWhenFiltered) {
      preload(ALL_PAGES); // time-limited search: dig until YouTube runs out
    } else if (hourMode()) {
      preload(ALL_PAGES); // dig until YouTube runs out of results
    } else if (isResultsPage() && settings.sortEnabled && settings.preloadPages > 0) {
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
  if (typeof window !== 'undefined') {
    window.__ytfixParseAge = parseAge;
    window.__ytfixDateFilter = uploadDateFilter;
  }

  init();
})();
