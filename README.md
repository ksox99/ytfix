# YouTube Sort by Upload Date (Firefox add-on)

YouTube removed **Sort by → Upload date** from search results in January 2026.
The old `&sp=CAI%253D` URL trick stopped working soon after. This add-on puts
the option back:

```
Sort by [Relevance] [Upload date (newest)] | Uploaded [Any time] [Last hour]  [Load more results]  84 videos sorted
```

## How it works

YouTube's servers no longer return results in date order, so the add-on sorts them in your browser:

1. It reads each result's "5 hours ago" / "3 days ago" text. This works for
   English, German, Spanish, Portuguese, French, Italian and Dutch.
2. It reorders the results newest first. Live streams go on top, and results
   with no date go at the bottom. Results with the same age ("1 year ago")
   keep YouTube's relevance order. Elements are only reordered with CSS, never
   moved, so YouTube's infinite scroll keeps working.
3. It quietly loads 3 more pages of results (about 80 in total), so the sort
   covers more than the first screen. Click **Load more results** to go
   further back.

### Last hour
YouTube removed its "Last hour" filter too. Click **Last hour** to get it back:

1. It first tries YouTube's old "last hour" filter code.
2. If YouTube ignores it (old videos show up), it switches to YouTube's
   **Today** filter, which still works. If that is ignored too, it keeps the
   unfiltered results.
3. It hides everything older than an hour, sorts the rest newest first, and
   keeps loading pages (up to 20) until YouTube runs out of results.

YouTube rounds ages down, so "1 hour ago" can mean up to 1 h 59 min. Those
videos are included. Brand-new uploads can take a few minutes before YouTube
puts them in search at all. The add-on can't speed that up.
Click **Any time** to turn it off.

**Tip:** for a really fresh list, combine it with YouTube's own
*Filters → Upload date → Today / This week / This month*. YouTube still
supports that filter. The add-on then puts everything inside that window in
order.

### Limitations
- Only results that have loaded can be sorted. This is a reordering of
  YouTube's relevance results, not a server-side "newest" search, so a very new
  video that YouTube ranks very low may only show up after you load more pages.
  Use the Upload date filter to narrow things down.
- YouTube only shows coarse ages ("2 years ago"), so older videos are only
  roughly in order.

## Install

**Try it now (temporary, removed when Firefox restarts):**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.

**Install permanently:** Firefox only installs signed add-ons. Signing is free:
1. `npx web-ext build -s extension` creates a `.zip`.
2. Upload it at <https://addons.mozilla.org/developers/addon/submit/> and choose
   **"On your own"** (unlisted). You get a signed `.xpi` back, usually within
   minutes. Open it in Firefox to install.

   (Or, in Firefox Developer Edition / Nightly, set
   `xpinstall.signatures.required` to `false` and install the unsigned zip.)

## Settings
Go to `about:addons` → *YouTube Sort by Upload Date* → *Preferences*:
- Turn sorting on or off by default. The toolbar remembers your last choice.
- Number of extra pages to load automatically (0–20, default 3).
- Show only videos while sorted. This hides Shorts shelves, "People also
  watched", channels and playlists. On by default.
