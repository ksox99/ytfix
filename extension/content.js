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

  // ---------------------------------------------------------------------------
  // "Last hour" mode
  // ---------------------------------------------------------------------------
  // YouTube dropped the "Last hour" filter in Jan 2026. We first try the old
  // URL code for it. If YouTube ignores it (old videos show up), we switch to
  // the "Today" filter, which YouTube still supports. If that is ignored too,
  // we keep the unfiltered results. In every case, results older than an
  // hour are hidden in the browser, so the end result is the same; only the
  // number of results YouTube sends to choose from changes.

  const HOUR_KEY = 'ytfix-last-hour';
  const SP_LAST_HOUR = 'EgIIAQ==';
  const SP_TODAY = 'EgIIAg==';
  const ONE_HOUR = 3600;
  const ALL_PAGES = 60; // "load everything" safety cap (~1200 results)

  const getQuery = () => new URLSearchParams(location.search).get('search_query') || '';

  // State lives in sessionStorage: { q: query, stage: 'hour' | 'today' | 'client' }.
  function hourState() {
    try {
      const s = JSON.parse(sessionStorage.getItem(HOUR_KEY));
      return s && s.q === getQuery() ? s : null;
    } catch (_) { return null; }
  }
  function setHourState(s) {
    try {
      if (s) sessionStorage.setItem(HOUR_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(HOUR_KEY);
    } catch (_) { /* ignore */ }
  }
  const hourMode = () => isResultsPage() && !!hourState();

  function goSearch(sp) {
    const u = new URL('/results', location.origin);
    u.searchParams.set('search_query', getQuery());
    if (sp) u.searchParams.set('sp', sp);
    location.assign(u.href);
  }

  function setLastHour(on) {
    if (on === hourMode()) return;
    cancelPreload();
    if (on) {
      setHourState({ q: getQuery(), stage: 'hour' });
      goSearch(SP_LAST_HOUR);
    } else {
      setHourState(null);
      goSearch(null);
    }
  }

  // Detect whether YouTube honoured the time filter; step down if not.
  let filterChecked = false;
  function checkServerFilter(videos) {
    if (filterChecked || videos.length < 5) return false;
    filterChecked = true;
    const st = hourState();
    if (!st || st.stage === 'client') return false;
    const tooOld = st.stage === 'hour' ? 2 * 86400 : 3 * 86400;
    const old = videos.filter(v => v.age !== AGE_UNKNOWN && v.age > tooOld).length;
    if (old < 3) return false; // filter works
    if (st.stage === 'hour') {
      setHourState({ ...st, stage: 'today' });
      goSearch(SP_TODAY);
      return true;
    }
    setHourState({ ...st, stage: 'client' });
    return false;
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

  let lastStats = { total: 0, dated: 0, shown: 0 };

  function applySort() {
    const root = getSearchRoot();
    if (!root) return;
    const results = isResultsPage();
    const sort = settings.sortEnabled && results;
    const hour = hourMode();
    root.classList.toggle('ytfix-sorted', sort);
    root.classList.toggle('ytfix-hide-shelves', (sort || hour) && settings.hideShelves);

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

    if (hour && checkServerFilter(videos)) return; // reloading with another filter

    for (const v of videos) {
      const tooOld = hour && !(v.age >= 0 && v.age <= ONE_HOUR);
      v.el.classList.toggle('ytfix-too-old', tooOld);
    }

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
      shown: hour ? videos.filter(v => v.age >= 0 && v.age <= ONE_HOUR).length : videos.length,
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
    const anyTime = mk('anytime', 'Any time');
    const lastHour = mk('lasthour', 'Last hour');
    const more = mk('more', 'Load all results');
    more.classList.add('ytfix-more');

    const status = document.createElement('span');
    status.className = 'ytfix-status';

    relevance.addEventListener('click', () => setSortEnabled(false));
    newest.addEventListener('click', () => setSortEnabled(true));
    anyTime.addEventListener('click', () => setLastHour(false));
    lastHour.addEventListener('click', () => setLastHour(true));
    more.addEventListener('click', () => {
      if (preloading) { cancelPreload(); scheduleUpdate(); }
      else preload(ALL_PAGES);
    });

    const sep = document.createElement('span');
    sep.className = 'ytfix-sep';

    bar.append(mkLabel('Sort by'), relevance, newest, sep,
      mkLabel('Uploaded'), anyTime, lastHour, more, status);
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
    bar.querySelector('[data-key="anytime"]').classList.toggle('ytfix-active', !hour);
    bar.querySelector('[data-key="lasthour"]').classList.toggle('ytfix-active', hour);
    const more = bar.querySelector('[data-key="more"]');
    more.hidden = (!on && !hour) || (exhausted && !preloading);
    more.textContent = preloading ? 'Stop loading' : 'Load all results';
    const status = bar.querySelector('.ytfix-status');
    const { total, dated, shown } = lastStats;
    const done = exhausted && !preloading ? ' · all results loaded' : '';
    if (hour) {
      const local = hourState()?.stage === 'client'
        ? ' · YouTube ignored the time filter, so this was filtered here' : '';
      if (preloading) {
        status.textContent = `${shown} from the last hour so far · searching (${total} checked)…`;
      } else if (shown === 0) {
        status.textContent = `Nothing from the last hour among ${total} results${local}`;
      } else {
        status.textContent = `${shown} videos from the last hour (${total} checked)${done}${local}`;
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
    filterChecked = false;
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
