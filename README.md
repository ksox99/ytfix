# YouTube Sort by Upload Date (Firefox add-on)

YouTube removed **Sort by → Upload date** from search in January 2026, and its
remaining time filters return poor, randomly ordered lists. This add-on puts
proper newest-first sorting back:

```
Sort by [Relevance] [Upload date (newest)] | Uploaded [Any time] [Last hour] [Today] [This week]
```

## How it works

### Last hour / Today / This week
YouTube's own *Today* filter misses most fresh uploads and comes in random
order. So for these buttons the add-on runs the searches itself, using the
same internal search API the YouTube page uses:

| Button    | Searches merged                              | Shows uploads up to |
|-----------|----------------------------------------------|---------------------|
| Last hour | YouTube's (hidden) last-hour filter          | 59 minutes ago      |
| Today     | last-hour + Today filters                    | 23 hours ago        |
| This week | last-hour + Today + This week filters        | 6 days ago          |

It loads every page of each search, removes duplicates, drops anything
outside the timeframe, and shows one newest-first list in place of YouTube's.
So all three buttons have the same freshest videos at the top, and the longer
timeframes extend the list further back.

The timeframe you pick stays selected for new searches until you choose
**Any time** (or **Relevance**).

YouTube rounds ages down ("1 hour ago" means 60–119 minutes), which is why
the cut-offs are 59 minutes, 23 hours and 6 days.

### Any time
YouTube's normal results, reordered newest first in the page. Live streams go
on top and undated items go at the end. Results with the same age ("1 year
ago") keep YouTube's relevance order. The add-on loads 3 extra pages
automatically. **Load all results** keeps going until YouTube runs out. If
you use YouTube's own *Filters → Upload date* menu, every result is loaded.

Dates are read in English, German, Spanish, Portuguese, French, Italian and
Dutch.

### Limitations
- The add-on can only show what YouTube's search returns. Brand-new uploads
  can take a few minutes to show up in YouTube search at all.
- In Any time mode, YouTube only shows rough ages ("2 years ago"), so older
  videos are only roughly in order.

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
- Load all results when YouTube's own Upload date filter is used in Any time
  mode. On by default.
- Number of extra pages to load automatically when no time filter is on
  (0–20, default 3).
- Show only videos while sorted. This hides Shorts shelves, "People also
  watched", channels and playlists. On by default.
