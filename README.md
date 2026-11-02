# YouTube Sort by Upload Date (Firefox add-on)

YouTube removed **Sort by → Upload date** from search results in January 2026.
The old `&sp=CAI%253D` URL trick stopped working soon after. This add-on puts
the option back:

```
Sort by [Relevance] [Upload date (newest)] | Uploaded [Any time] [Last hour] [Today] [This week]  [Load all results]  84 videos sorted
```

## How it works

YouTube's servers no longer return results in date order, so the add-on sorts them in your browser:

1. It reads each result's "5 hours ago" / "3 days ago" text. This works for
   English, German, Spanish, Portuguese, French, Italian and Dutch.
2. It reorders the results newest first. Live streams go on top, and results
   with no date go at the bottom. Results with the same age ("1 year ago")
   keep YouTube's relevance order. Elements are only reordered with CSS, never
   moved, so YouTube's infinite scroll keeps working.
3. It loads more results automatically:
   - **With a time filter on** (**Last hour**, or YouTube's own *Today / This
     week / This month / This year*), it loads **every** result, page by page,
     until YouTube has no more. Nothing gets missed just because YouTube ranked
     it low. The toolbar says *"all results loaded"* when it's done.
   - **Without a time filter**, it loads 3 extra pages (about 80 results).
     Click **Load all results** to keep going until the end. While it loads,
     the button becomes **Stop loading**.

### Uploaded: Any time / Last hour / Today / This week
- **Today** and **This week** switch on YouTube's own upload-date filter
  (it still works, only the sort was removed), then the add-on sorts and loads
  every result.
- **Last hour**: YouTube removed this from its menu, but its old filter code
  still works and returns genuinely fresh uploads. The add-on uses that code,
  sorts newest first, and hides anything that still says it's older than an
  hour. This is the best option for "what was just uploaded". YouTube's own
  **Today** list is much smaller and misses many recent uploads.

YouTube rounds ages down, so "1 hour ago" can mean up to 1 h 59 min. Those
videos are included in Last hour. Brand-new uploads can take a few minutes to
show up in YouTube search at all.

YouTube's own *Filters → Upload date* (This month / This year) works with
the add-on too.

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
- Load all results when a time filter is on. On by default.
- Number of extra pages to load automatically when no time filter is on
  (0–20, default 3).
- Show only videos while sorted. This hides Shorts shelves, "People also
  watched", channels and playlists. On by default.
