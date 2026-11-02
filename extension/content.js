/*
 * YouTube Sort by Upload Date
 *
 * YouTube removed "Sort by: Upload date" from search in January 2026. This
 * add-on brings it back in two ways:
 *
 * Any time: YouTube's own result list is reordered newest first in the page
 *   (CSS `order`, nodes are never moved), and a few more pages are preloaded.
 *
 * Last hour / Today / This week: YouTube's time filters return poor lists.
 *   "Today" misses most fresh uploads, while the old (hidden) "last hour"
 *   filter returns them. So the add-on runs the relevant filtered searches
 *   itself, via the same internal API the YouTube page uses, merges them
 *   (last hour + today + this week), removes duplicates, drops anything
 *   outside the timeframe, and shows its own newest-first list.
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULTS = {
    sortEnabled: true,
    timeframe: 'any', // 'any' | 'hour' | 'today' | 'week'
    preloadPages: 3,
    hideShelves: true,
    loadAllWhenFiltered: true,
    backoffUntil: 0, // set when YouTube says "too many requests"; shared by all tabs
  };
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

  const AGE_LIVE = -1;      // live streams first
  const AGE_UNKNOWN = Infinity;

  // ---------------------------------------------------------------------------
  // Any time: reorder YouTube's own result list
  // ---------------------------------------------------------------------------

  const META_SEL = [
    '#metadata-line span',                       // classic ytd-video-renderer
    'yt-content-metadata-view-model span',       // new "lockup" layout
    '.yt-content-metadata-view-model-wiz__metadata-text',
    '.yt-content-metadata-view-model__metadata-text',
  ].join(',');

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

  const ITEM_SEL = 'ytd-item-section-renderer > #contents > *';
  const VIDEO_TAGS = new Set(['YTD-VIDEO-RENDERER', 'YT-LOCKUP-VIEW-MODEL']);
  // Groups of several items that should never be sorted as one video.
  const GROUP_TAGS = new Set([
    'YTD-SHELF-RENDERER', 'YTD-REEL-SHELF-RENDERER', 'YTD-RICH-SHELF-RENDERER',
    'YTD-HORIZONTAL-CARD-LIST-RENDERER', 'YTD-VERTICAL-LIST-RENDERER', 'GRID-SHELF-VIEW-MODEL',
    'YTD-AD-SLOT-RENDERER', 'YTD-CHANNEL-RENDERER', 'YTD-PLAYLIST-RENDERER', 'YTD-RADIO-RENDERER',
    'YTD-CONTINUATION-ITEM-RENDERER',
  ]);

  /** The video inside a result-list item: the item itself, or the one video
   *  inside a wrapper (for example YouTube's blur wrapper for sensitive results). */
  function videoOf(child) {
    if (VIDEO_TAGS.has(child.tagName)) return child;
    if (GROUP_TAGS.has(child.tagName)) return null;
    const inner = child.querySelectorAll('ytd-video-renderer, yt-lockup-view-model');
    return inner.length === 1 ? inner[0] : null;
  }

  const isResultsPage = () => location.pathname === '/results';
  const getSearchRoot = () => document.querySelector('ytd-search');
  const getQuery = () => new URLSearchParams(location.search).get('search_query') || '';
  const ownListActive = () => isResultsPage() && settings.timeframe !== 'any' && !isBackedOff();

  let lastStats = { total: 0, dated: 0 };

  function applySort() {
    const root = getSearchRoot();
    if (!root) return;
    const own = ownListActive();
    const sort = settings.sortEnabled && isResultsPage() && !own;
    root.classList.toggle('ytfix-own-list', own);
    root.classList.toggle('ytfix-sorted', sort);
    root.classList.toggle('ytfix-hide-shelves', sort && settings.hideShelves);

    const children = root.querySelectorAll(ITEM_SEL);
    if (!sort) {
      for (const el of children) el.style.removeProperty('order');
      return;
    }
    const videos = [];
    let index = 0;
    for (const el of children) {
      index++;
      const video = el.hidden ? null : videoOf(el);
      el.classList.toggle('ytfix-item', !!video);
      if (video) {
        videos.push({ el, index, age: getAge(video) });
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
    lastStats = { total: videos.length, dated: videos.filter(v => v.age !== AGE_UNKNOWN).length };
  }

  // ---------------------------------------------------------------------------
  // Detecting YouTube's own upload-date filter in the URL (Any time mode)
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

  // ---------------------------------------------------------------------------
  // Any time: preloading more pages of YouTube's own list
  // ---------------------------------------------------------------------------
  // YouTube loads the next page when its continuation spinner scrolls into
  // view (IntersectionObserver). We pin the spinner invisibly inside the
  // viewport for a moment, which loads the next page without scrolling.

  const ALL_PAGES = 60; // "load everything" safety cap (~1200 results)
  let preloadRun = 0;
  let preloading = false;
  let exhausted = false;
  let navigating = false;

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
        if (isBackedOff()) break;
        await sleep(PAGE_DELAY);
        if (run !== preloadRun) break;
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
  // Timeframes: fetching and merging filtered searches
  // ---------------------------------------------------------------------------

  const SP = { hour: 'EgIIAQ==', today: 'EgIIAg==', week: 'EgIIAw==' };
  // Which filtered searches feed each timeframe (freshest first).
  const SOURCES = { hour: ['hour'], today: ['hour', 'today'], week: ['hour', 'today', 'week'] };
  // Ages must be below these. YouTube rounds down ("1 hour ago" means 60-119
  // minutes), so the last hour shows up to "59 minutes ago", today up to
  // "23 hours ago" and this week up to "6 days ago".
  const MAX_AGE = { hour: S.hour, today: S.day, week: S.week };
  // Keep the request count close to a person scrolling: a few pages per
  // search, a pause between requests, results reused for a while, and a full
  // stop if YouTube complains.
  const PAGES_PER_STEP = 5;          // pages per search, and per "Load more results" click
  const PAGE_DELAY = 500;            // ms between background requests
  const CACHE_TTL = 10 * 60 * 1000;  // reuse a search's results for 10 minutes
  const BACKOFF = 15 * 60 * 1000;    // pause background searches this long after a 429

  class ThrottledError extends Error {}

  const isBackedOff = () => settings.backoffUntil > Date.now();

  function noteThrottled() {
    const until = Date.now() + BACKOFF;
    settings.backoffUntil = until;
    try { api.storage.local.set({ backoffUntil: until }); } catch (_) { /* ignore */ }
    setTimeout(scheduleUpdate, BACKOFF + 1000);
    throw new ThrottledError('YouTube asked to slow down');
  }

  function checkThrottle(res) {
    if (res.status === 429 || /\/sorry\//.test(res.url || '')) noteThrottled();
  }

  // Use the page's own fetch, so requests look exactly like YouTube's (Firefox).
  // eslint-disable-next-line no-undef
  const pageFetch = (typeof content !== 'undefined' && content && content.fetch)
    // eslint-disable-next-line no-undef
    ? content.fetch.bind(content) : window.fetch.bind(window);

  function scriptText() {
    let all = '';
    for (const s of document.querySelectorAll('script:not([src])')) {
      const t = s.textContent;
      if (t.includes('INNERTUBE')) all += t;
    }
    return all;
  }

  function innertubeConfig() {
    let context = null, apiKey = null, clientVersion = null;
    const extra = {};
    try {
      const ytcfg = (window.wrappedJSObject || window).ytcfg;
      if (ytcfg && ytcfg.get) {
        const c = ytcfg.get('INNERTUBE_CONTEXT');
        if (c) context = JSON.parse(JSON.stringify(c));
        apiKey = ytcfg.get('INNERTUBE_API_KEY') || null;
        clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION') || null;
        for (const k of ['VISITOR_DATA', 'SESSION_INDEX', 'DELEGATED_SESSION_ID', 'LOGGED_IN']) {
          const v = ytcfg.get(k);
          if (v !== undefined && v !== null) extra[k] = String(v);
        }
      }
    } catch (_) { /* fall back to parsing the page */ }
    const text = scriptText();
    const pick = re => (text.match(re) || [])[1] || null;
    extra.VISITOR_DATA ??= pick(/"VISITOR_DATA":"([^"]+)"/);
    extra.SESSION_INDEX ??= pick(/"SESSION_INDEX":"?(\d+)"?/);
    extra.DELEGATED_SESSION_ID ??= pick(/"DELEGATED_SESSION_ID":"([^"]+)"/);
    extra.LOGGED_IN ??= pick(/"LOGGED_IN":(true|false)/);
    if (!context || !clientVersion) {
      clientVersion = clientVersion || pick(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || '2.20260101.00.00';
      apiKey = apiKey || pick(/"INNERTUBE_API_KEY":"([^"]+)"/);
      context = context || {
        client: {
          clientName: 'WEB',
          clientVersion,
          hl: pick(/"HL":"([^"]+)"/) || document.documentElement.lang || 'en',
          gl: pick(/"GL":"([^"]+)"/) || 'US',
        },
      };
    }
    return { context, apiKey, clientVersion: clientVersion || context.client?.clientVersion, extra };
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Signed-in requests: YouTube's page proves the sign-in with a
  // "SAPISIDHASH" header made from the SAPISID cookie. Without it the request
  // counts as signed out, and age-restricted / mature results are withheld.
  async function authHeaders(cfg) {
    const h = {};
    const e = cfg.extra || {};
    if (e.VISITOR_DATA) h['X-Goog-Visitor-Id'] = e.VISITOR_DATA;
    const cookie = name => (document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')) || [])[1];
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (!sapisid) return h;
    const ts = Math.floor(Date.now() / 1000);
    const origin = location.origin;
    const sig = `${ts}_${await sha1Hex(`${ts} ${sapisid} ${origin}`)}`;
    h.Authorization = `SAPISIDHASH ${sig} SAPISID1PHASH ${sig} SAPISID3PHASH ${sig}`;
    h['X-Origin'] = origin;
    h['X-Goog-AuthUser'] = e.SESSION_INDEX || '0';
    if (e.DELEGATED_SESSION_ID) h['X-Goog-PageId'] = e.DELEGATED_SESSION_ID;
    if (e.LOGGED_IN) h['X-Youtube-Bootstrap-Logged-In'] = e.LOGGED_IN;
    return h;
  }

  /** Backup: load the ordinary results page (normal cookie sign-in) and read its data. */
  async function resultsPageData(query, params) {
    const url = location.origin + '/results?search_query=' + encodeURIComponent(query) +
      '&sp=' + encodeURIComponent(params);
    if (isBackedOff()) throw new ThrottledError('paused');
    const res = await pageFetch(url, { credentials: 'include' });
    checkThrottle(res);
    if (!res.ok) throw new Error('YouTube results page returned ' + res.status);
    const html = await res.text();
    const m = html.match(/ytInitialData"?\]?\s*=\s*(\{.+?\});\s*<\/script>/s);
    return m ? JSON.parse(m[1]) : null;
  }

  async function innertubeSearch(cfg, body) {
    if (isBackedOff()) throw new ThrottledError('paused');
    const url = location.origin + '/youtubei/v1/search?prettyPrint=false' +
      (cfg.apiKey ? '&key=' + encodeURIComponent(cfg.apiKey) : '');
    const res = await pageFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': cfg.clientVersion,
        ...(await authHeaders(cfg).catch(() => ({}))),
      },
      body: JSON.stringify({ context: cfg.context, ...body }),
    });
    checkThrottle(res);
    if (!res.ok) throw new Error('YouTube search returned ' + res.status);
    return JSON.parse(await res.text());
  }

  const txt = t => {
    if (!t) return '';
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map(r => r.text).join('');
    return typeof t.content === 'string' ? t.content : '';
  };

  function fromVideoRenderer(r) {
    if (!r.videoId) return null;
    const badges = JSON.stringify(r.badges || []) + JSON.stringify(r.thumbnailOverlays || []);
    const published = txt(r.publishedTimeText);
    const views = txt(r.shortViewCountText) || txt(r.viewCountText);
    const live = /LIVE_NOW|"LIVE"/.test(badges) || (!published && LIVE_RE.test(views));
    return {
      id: r.videoId,
      title: txt(r.title),
      channel: txt(r.ownerText) || txt(r.longBylineText),
      views,
      published,
      length: txt(r.lengthText),
      age: live ? AGE_LIVE : (parseAge(published) ?? AGE_UNKNOWN),
    };
  }

  function stringsIn(obj, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && (k === 'content' || k === 'text' || k === 'simpleText')) out.push(v);
      else if (typeof v === 'object') stringsIn(v, out);
    }
    return out;
  }

  function fromLockup(l) {
    if (!l.contentId || l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const meta = l.metadata?.lockupMetadataViewModel;
    const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
    const parts = rows.flatMap(r => (r.metadataParts || []).map(p => p.text?.content || '')).filter(Boolean);
    let age = AGE_UNKNOWN, published = '', views = '';
    for (const p of parts) {
      const a = parseAge(p);
      if (a !== null && age === AGE_UNKNOWN) { age = a; published = p; }
      else if (LIVE_RE.test(p)) { age = AGE_LIVE; views = p; }
      else if (/view|aufruf|vista|vue|visualiza/i.test(p)) views = p;
    }
    const imageStrings = stringsIn(l.contentImage);
    return {
      id: l.contentId,
      title: meta?.title?.content || '',
      channel: parts[0] || '',
      views,
      published,
      length: imageStrings.find(s => /^\d+(:\d\d){1,2}$/.test(s)) || '',
      age,
    };
  }

  // Response parts that hold groups or non-videos: never taken apart.
  const SKIP_KEYS = new Set([
    'shelfRenderer', 'reelShelfRenderer', 'richShelfRenderer', 'horizontalCardListRenderer',
    'gridShelfViewModel', 'verticalListRenderer', 'shortsLockupViewModel', 'reelItemRenderer',
    'adSlotRenderer', 'promotedSparklesWebRenderer', 'searchPyvRenderer', 'channelRenderer',
    'playlistRenderer', 'radioRenderer', 'didYouMeanRenderer', 'showingResultsForRenderer',
    'backgroundPromoRenderer', 'messageRenderer', 'continuationItemRenderer',
  ]);
  const SENSITIVE_RE = /blur|sensitive|warning|mature|interstitial/i;

  /** True if any field *name* (not text such as a title) marks the item as blurred or sensitive. */
  function hasSensitiveKey(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return false;
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_RE.test(k) && v !== false && v !== null) return true;
      if (typeof v === 'object' && hasSensitiveKey(v, depth + 1)) return true;
    }
    return false;
  }

  /** Finds videos anywhere inside `obj` (they may sit in wrappers such as YouTube's blur wrapper). */
  function findVideos(obj, sensitive, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 15) return;
    if (Array.isArray(obj)) {
      for (const x of obj) findVideos(x, sensitive, out, depth + 1);
      return;
    }
    if (obj.videoRenderer || obj.lockupViewModel) {
      const raw = obj.videoRenderer || obj.lockupViewModel;
      const v = obj.videoRenderer ? fromVideoRenderer(raw) : fromLockup(raw);
      if (v) {
        v.sensitive = sensitive || hasSensitiveKey(raw);
        out.push(v);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP_KEYS.has(k) || typeof v !== 'object') continue;
      findVideos(v, sensitive || SENSITIVE_RE.test(k), out, depth + 1);
    }
  }

  /** Pulls video items and the next-page token out of a list of section items. */
  function collect(items, out) {
    let token = null;
    for (const it of items || []) {
      if (it.continuationItemRenderer) {
        token = it.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || token;
        continue;
      }
      const contents = it.itemSectionRenderer ? it.itemSectionRenderer.contents || [] : [it];
      for (const c of contents) {
        const before = out.length;
        findVideos(c, false, out);
        // Remember formats that held no videos, to explain an empty list.
        if (out.length === before && own) {
          for (const k of Object.keys(c)) if (!SKIP_KEYS.has(k)) own.unknownKinds.add(k);
        }
      }
    }
    return token;
  }

  function parseFirstPage(json) {
    const items = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    const out = [];
    const token = collect(items, out);
    return { videos: out, token };
  }

  function parseNextPage(json) {
    const out = [];
    let token = null;
    for (const cmd of json?.onResponseReceivedCommands || []) {
      const items = cmd.appendContinuationItemsAction?.continuationItems;
      if (items) token = collect(items, out) || token;
    }
    return { videos: out, token };
  }

  // ---- Search cache: one entry per (query, filter), shared by all timeframes ----
  const searchCache = new Map();

  function cacheEntry(query, params) {
    const key = query + '\n' + params;
    let e = searchCache.get(key);
    if (!e || Date.now() - e.time > CACHE_TTL) {
      e = { time: Date.now(), videos: [], token: null, started: false, done: false, pages: 0, busy: null };
      searchCache.set(key, e);
    }
    return e;
  }

  let lastRequest = 0;
  async function pace() {
    const wait = lastRequest + PAGE_DELAY - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
  }

  /** Loads pages for one search until it has `targetPages` pages or YouTube has no more. */
  async function fillEntry(e, cfg, query, params, targetPages, isCurrent, onPage) {
    while (e.busy) await e.busy.catch(() => {});
    if (e.done || e.pages >= targetPages || !isCurrent()) return;
    e.busy = (async () => {
      while (!e.done && e.pages < targetPages && isCurrent()) {
        await pace();
        if (!isCurrent()) break;
        let page;
        if (!e.started) page = await firstPage(cfg, query, params);
        else page = parseNextPage(await innertubeSearch(cfg, { continuation: e.token }));
        e.started = true;
        e.pages++;
        e.token = page.token;
        if (!page.token) e.done = true;
        e.videos.push(...page.videos);
        onPage(page.videos);
      }
    })();
    try { await e.busy; } finally { e.busy = null; }
  }

  async function firstPage(cfg, query, params) {
    let page = { videos: [], token: null };
    let apiError = null;
    try {
      page = parseFirstPage(await innertubeSearch(cfg, { query, params }));
    } catch (err) {
      if (err instanceof ThrottledError) throw err;
      apiError = err;
    }
    if (page.videos.length === 0) {
      // Nothing from the API (for example, sign-in-only results): try the normal results page.
      try {
        await pace();
        const data = await resultsPageData(query, params);
        if (data) {
          const fromPage = parseFirstPage(data);
          if (fromPage.videos.length || fromPage.token) page = fromPage;
        }
      } catch (err) {
        if (err instanceof ThrottledError || apiError) throw err instanceof ThrottledError ? err : apiError;
      }
      if (apiError && page.videos.length === 0 && !page.token) throw apiError;
    }
    return page;
  }

  // ---- The own list for the current query + timeframe ----
  let own = null;
  let ownRun = 0;

  function startOwnList() {
    const key = getQuery() + '|' + settings.timeframe;
    if (own && own.key === key) return;
    own = {
      key, run: ++ownRun, timeframe: settings.timeframe, query: getQuery(),
      videos: new Map(), seq: 0, targetPages: PAGES_PER_STEP,
      loading: false, done: false, moreAvailable: false, error: null, unknownKinds: new Set(),
    };
    renderOwnList();
    loadOwn();
  }

  /** Fills each search (freshest filter first, one at a time) up to the target page count. */
  async function loadOwn() {
    const o = own;
    if (!o || o.loading) return;
    o.loading = true;
    o.done = false;
    renderBar();
    const isCurrent = () => own === o;
    const cfg = innertubeConfig();
    for (const src of SOURCES[o.timeframe]) {
      if (!isCurrent()) return;
      const e = cacheEntry(o.query, SP[src]);
      addVideos(e.videos); // whatever is cached already
      try {
        await fillEntry(e, cfg, o.query, SP[src], o.targetPages, isCurrent, vids => {
          if (isCurrent()) addVideos(vids);
        });
        // Pages another timeframe loaded into this search while we waited.
        if (isCurrent()) addVideos(e.videos);
      } catch (err) {
        if (isCurrent()) o.error = err;
        if (err instanceof ThrottledError) break;
      }
    }
    if (!isCurrent()) return;
    o.loading = false;
    o.done = true;
    o.moreAvailable = !(o.error instanceof ThrottledError) &&
      SOURCES[o.timeframe].some(src => !cacheEntry(o.query, SP[src]).done);
    if (o.error instanceof ThrottledError) scheduleUpdate(); // fall back to YouTube's list
    renderOwnList();
    renderBar();
  }

  function loadMoreOwn() {
    if (!own || own.loading) return;
    own.targetPages += PAGES_PER_STEP;
    loadOwn();
  }

  function addVideos(list) {
    const maxAge = MAX_AGE[own.timeframe];
    for (const v of list) {
      if (own.videos.has(v.id)) continue;
      // Only uploads inside the timeframe. Live streams and undated items are left out.
      if (!(v.age >= 0 && v.age < maxAge)) continue;
      v.seq = own.seq++;
      own.videos.set(v.id, v);
    }
    scheduleOwnRender();
  }

  let ownRenderPending = false;
  function scheduleOwnRender() {
    if (ownRenderPending) return;
    ownRenderPending = true;
    setTimeout(() => { ownRenderPending = false; renderOwnList(); renderBar(); }, 100);
  }

  // ---------------------------------------------------------------------------
  // Timeframes: rendering the own list
  // ---------------------------------------------------------------------------

  let listEl = null;
  const cards = new Map(); // video id -> element

  function buildCard(v) {
    const a = document.createElement('a');
    a.className = 'ytfix-card' + (v.sensitive ? ' ytfix-sensitive' : '');
    a.href = '/watch?v=' + encodeURIComponent(v.id);

    const thumb = document.createElement('div');
    thumb.className = 'ytfix-thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(v.id) + '/mqdefault.jpg';
    thumb.append(img);
    if (v.length) {
      const len = document.createElement('span');
      len.className = 'ytfix-len';
      len.textContent = v.length;
      thumb.append(len);
    }

    const info = document.createElement('div');
    info.className = 'ytfix-info';
    const title = document.createElement('div');
    title.className = 'ytfix-title';
    title.textContent = v.title;
    const meta = document.createElement('div');
    meta.className = 'ytfix-meta';
    meta.textContent = [v.views, v.published].filter(Boolean).join(' • ');
    const channel = document.createElement('div');
    channel.className = 'ytfix-channel';
    channel.textContent = v.channel;
    info.append(title, meta, channel);

    a.append(thumb, info);
    return a;
  }

  function ensureListEl() {
    const primary = getSearchRoot()?.querySelector('#primary');
    if (!primary) return null;
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.id = 'ytfix-results';
    }
    if (bar && bar.isConnected && bar.nextSibling !== listEl) bar.after(listEl);
    else if (!listEl.isConnected) primary.prepend(listEl);
    return listEl;
  }

  function renderOwnList() {
    if (!ownListActive() || !own) {
      listEl?.remove();
      return;
    }
    const el = ensureListEl();
    if (!el) return;
    el.classList.toggle('ytfix-unblur', unblurred);
    if (el.dataset.key !== own.key) {
      el.textContent = '';
      cards.clear();
      el.dataset.key = own.key;
    }
    const sorted = [...own.videos.values()].sort((a, b) => (a.age - b.age) || (a.seq - b.seq));
    let prev = null;
    for (const v of sorted) {
      let card = cards.get(v.id);
      if (!card) { card = buildCard(v); cards.set(v.id, card); }
      const want = prev ? prev.nextSibling : el.firstChild;
      if (want !== card) el.insertBefore(card, want);
      prev = card;
    }
    let empty = el.querySelector('.ytfix-empty');
    if (own.done && sorted.length === 0) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'ytfix-empty';
        el.append(empty);
      }
      empty.textContent = own.error instanceof ThrottledError
        ? 'YouTube asked for fewer requests. Background searches are paused for 15 minutes.'
        : own.error
        ? `Couldn't load results from YouTube (${own.error.message}). Choose "Any time" to see YouTube's normal list.`
        : `No videos uploaded in the ${TIMEFRAME_LABEL[own.timeframe]} for this search.` +
          (own.unknownKinds.size ? ` (YouTube also sent results in formats the add-on doesn't read yet: ${[...own.unknownKinds].join(', ')}.)` : '');
    } else {
      empty?.remove();
    }
  }

  let unblurred = false;

  const TIMEFRAME_LABEL = { hour: 'last hour', today: 'last 24 hours', week: 'last week' };

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
    const mk = (key, text, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ytfix-chip';
      b.dataset.key = key;
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };

    const relevance = mk('relevance', 'Relevance', () => {
      setSettings({ sortEnabled: false, timeframe: 'any' });
    });
    const newest = mk('newest', 'Upload date (newest)', () => setSettings({ sortEnabled: true }));
    const times = [['any', 'Any time'], ['hour', 'Last hour'], ['today', 'Today'], ['week', 'This week']]
      .map(([key, text]) => mk('time-' + key, text, () => {
        setSettings(key === 'any' ? { timeframe: 'any' } : { timeframe: key, sortEnabled: true });
      }));
    const unblur = mk('unblur', 'Unblur thumbnails', () => {
      unblurred = !unblurred;
      renderOwnList();
      renderBar();
    });
    unblur.classList.add('ytfix-more');
    const more = mk('more', 'Load all results', () => {
      if (ownListActive()) loadMoreOwn();
      else if (preloading) { cancelPreload(); scheduleUpdate(); } else preload(ALL_PAGES);
    });
    more.classList.add('ytfix-more');

    const status = document.createElement('span');
    status.className = 'ytfix-status';
    const sep = document.createElement('span');
    sep.className = 'ytfix-sep';

    bar.append(mkLabel('Sort by'), relevance, newest, sep, mkLabel('Uploaded'), ...times, more, unblur, status);
  }

  function ensureBar() {
    if (!isResultsPage()) {
      bar?.remove();
      listEl?.remove();
      return;
    }
    const primary = getSearchRoot()?.querySelector('#primary');
    if (!primary) return;
    if (!bar) buildBar();
    if (bar.parentNode !== primary || primary.firstElementChild !== bar) primary.prepend(bar);
  }

  function renderBar() {
    if (!bar) return;
    const tf = settings.timeframe;
    const ownMode = tf !== 'any';
    bar.querySelector('[data-key="relevance"]').classList.toggle('ytfix-active', !settings.sortEnabled && !ownMode);
    bar.querySelector('[data-key="newest"]').classList.toggle('ytfix-active', settings.sortEnabled || ownMode);
    for (const key of ['any', 'hour', 'today', 'week']) {
      bar.querySelector(`[data-key="time-${key}"]`).classList.toggle('ytfix-active', tf === key);
    }
    const more = bar.querySelector('[data-key="more"]');
    const status = bar.querySelector('.ytfix-status');
    const unblur = bar.querySelector('[data-key="unblur"]');
    const anySensitive = ownMode && own && [...own.videos.values()].some(v => v.sensitive);
    unblur.hidden = !anySensitive;
    unblur.textContent = unblurred ? 'Blur thumbnails' : 'Unblur thumbnails';
    if (navigating) {
      more.hidden = true;
      status.textContent = 'Loading…';
      return;
    }
    if (ownMode && isBackedOff()) {
      more.hidden = true;
      const t = new Date(settings.backoffUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      status.textContent = `YouTube asked for fewer requests, so background searches are paused until ${t}. ` +
        "Showing YouTube's normal list, sorted.";
      return;
    }
    if (ownMode) {
      const n = own ? own.videos.size : 0;
      const label = TIMEFRAME_LABEL[tf];
      more.textContent = 'Load more results';
      more.hidden = !own || !own.done || !own.moreAvailable;
      if (!own || !own.done) status.textContent = `${n} from the ${label} so far · searching…`;
      else status.textContent = `${n} videos from the ${label}, newest first` +
        (own.moreAvailable ? ' · more available' : ' · all results loaded') +
        (own.error && n ? ' (some searches failed)' : '');
      return;
    }
    if (isBackedOff()) {
      more.hidden = true;
      status.textContent = `${lastStats.total} videos sorted · extra loading paused (YouTube asked for fewer requests)`;
      return;
    }
    more.hidden = !settings.sortEnabled || (exhausted && !preloading);
    more.textContent = preloading ? 'Stop loading' : 'Load all results';
    const { total, dated } = lastStats;
    const done = exhausted && !preloading ? ' · all results loaded' : '';
    if (!settings.sortEnabled) {
      status.textContent = '';
    } else if (preloading) {
      status.textContent = `Loading results… (${total} so far)`;
    } else {
      const undated = total - dated;
      status.textContent = `${total} videos sorted` +
        (undated > 0 ? ` (${undated} without a date at the end)` : '') + done;
    }
  }

  function setSettings(changes) {
    const before = { ...settings };
    Object.assign(settings, changes);
    try { api.storage.local.set(changes); } catch (_) { /* ignore */ }
    applyModeChange(before);
  }

  function applyModeChange(before) {
    if (settings.timeframe !== 'any') {
      cancelPreload();
      if (!isBackedOff()) startOwnList();
    } else {
      own = null;
      ownRun++;
      const wasOwn = before.timeframe !== 'any';
      const sortTurnedOn = settings.sortEnabled && !before.sortEnabled;
      if (!settings.sortEnabled) cancelPreload();
      else if ((wasOwn || sortTurnedOn) && settings.preloadPages > 0 && !preloading) {
        exhausted = false;
        preload(settings.preloadPages);
      }
    }
    update();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function update() {
    ensureBar();
    applySort();
    if (ownListActive()) startOwnList();
    renderOwnList();
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
    if (!isResultsPage() || ownListActive() || isBackedOff()) return; // own list starts in update()
    if (uploadDateFilter() > 0 && settings.loadAllWhenFiltered) {
      preload(ALL_PAGES); // YouTube's own time filter is on: load everything
    } else if (settings.sortEnabled && settings.preloadPages > 0) {
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
        const before = { ...settings };
        let modeChanged = false;
        for (const k of Object.keys(DEFAULTS)) {
          if (k in changes && settings[k] !== changes[k].newValue) {
            settings[k] = changes[k].newValue;
            if (k === 'timeframe' || k === 'sortEnabled') modeChanged = true;
          }
        }
        if (modeChanged) applyModeChange(before);
        else scheduleUpdate();
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
