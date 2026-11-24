# Khat — an interactive constellation music experience

Each lyric word is a star. The stars form an organic constellation as the song plays, and at the end the whole constellation spirals inward and becomes one star.

Built with plain HTML, CSS, vanilla JavaScript and Canvas 2D. There are no frameworks and no animation libraries.

## 1. Add your files

```
khat-experience/
  index.html
  style.css
  app.js            audio, UI, render loop, loop system
  constellation.js  layout, adjacency graph, rendering
  lyrics.js         ← lyrics + timestamps (edit this)
  assets/
    khat-audio.mp3     ← your song
    khat-artwork.jpg   ← your artwork
```

If you use different file names, change `audio` / `artwork` in `lyrics.js`.

## 2. Run it

Open `index.html` directly, or (recommended) serve the folder locally:

- **VS Code:** right-click `index.html` → *Open with Live Server*
- **Terminal:** `cd khat-experience && python3 -m http.server 8000` → open http://localhost:8000

## 3. Lyrics & timing (`lyrics.js`)

The file holds the full Khat lyrics with line-level timestamps. For exact per-word timing, switch lines to word-level entries or use the sync helper below.

Word-level, the most precise format:

```js
{ word: "तेरी", time: 12.40 },
{ word: "बातें", time: 13.05 },
```

Segment-level (one timestamp per line). Word times inside a line are estimated: longer words get more time, at most about 1 s per word, between `time` and `end`:

```js
{ text: "तेरी बातें ना समझ सी", time: 12.40, end: 15.10 },
```

- Times are in seconds from the start of the audio file. Entries are sorted automatically.
- Optional `line: 3` on word entries groups words of the same line, so they sit near each other. Without it, a gap of more than 1.6 s starts a new line.
- Entries with a missing word or time are skipped, with a warning in the browser console.

### Sync helper

Open `index.html?sync`. Play the song and press **S** on each word as it is sung (Backspace undoes). Then click **Export** to get a ready-to-paste `lyrics` array, which is also copied to your clipboard. To prepare, put the words in `lyrics.js` with `time: null`.

### Finale settings

```js
finale: {
  start: null,    // when convergence begins (null = 1.5 s after the last word)
  converge: 10,   // seconds for the constellation to become one star
  loopAt: null    // start the loop early, e.g. to skip trailing silence
}
```

The single star holds and pulses until the audio ends (or `loopAt`). Then it fades, the constellation rebuilds, and the song restarts.

`seed` changes the constellation's arrangement. The same seed always gives the same sky.

## Controls

- Play / pause button, seek bar, volume and mute. Volume is remembered between visits.
- **Space / K** play-pause · **← / →** seek 5 s · **M** mute
- Hover a star to light its connections. Click a star or word to jump to that moment.
- During the loop transition, pressing play/pause stops the loop at the beginning.

## How it works

- **Sync:** every frame is drawn from `audio.currentTime` inside `requestAnimationFrame`. No timers are used for lyrics, so pause, seek and replay are always correct.
- **Layout:** seeded placement. Words of a line drift near each other in organic curves, and new lines start in open space. Density attractors keep the field balanced but asymmetric. Labels never overlap. If a very long lyric fills the field, an older word fades out before a newer one takes its space.
- **Graph:** a real adjacency graph. Each star links to 0–2 nearby words that are not neighbours in the lyric, with a maximum of 3 links per star, plus a few long arcs. Links between words 1–2 positions apart never exist. Every link is a curved quadratic Bézier that grows outward from the newly lit star, breathes, and in some cases fades away again.
- **Finale:** connections stop and fade, words fade one by one, and every star spirals into the centre in the same direction. Outer stars set off first. Their light is handed over to one central star with a soft atmosphere, a faint flare and a single ring at the moment of union.
- **Cleanup:** one rAF loop, one ResizeObserver, and all listeners are bound to one AbortController. `KHAT.destroy()` tears everything down. Canvas sizing is DPR-aware (capped at 2×).

## Notes

- Fonts (Inter, Noto Serif Devanagari) load from Google Fonts. Offline, it falls back to system fonts.
- On phones the volume slider is hidden, because the hardware buttons control volume.
