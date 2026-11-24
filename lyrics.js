/* ==========================================================================
   KHAT — lyrics & timing data
   --------------------------------------------------------------------------
   This is the only file you need to edit to sync the song.

   Two entry formats are accepted (you can mix them):

   1. Word-level (most precise — one star per entry):
        { word: "तेरी", time: 12.40 }
        { word: "बातें", time: 13.05, line: 3 }     // optional `line` groups words

   2. Segment-level (a whole line with one timestamp):
        { text: "तेरी बातें ना समझ सी", time: 12.40, end: 15.10 }
      Each word still becomes its own star; word times inside the segment are
      estimated (longer words get more time, max ~1 s per word) between `time`
      and `end` (or the next entry's time).
      Use word-level entries wherever you want exact per-word timing.

   `time` / `end` are in seconds from the start of assets/khat-audio.mp3.
   Entries are sorted by time automatically.

   Tip: open index.html?sync to tap out word timings while the song plays.
   ========================================================================== */

window.KHAT = window.KHAT || {};

window.KHAT.song = {
  title: "Khat",
  artist: "",                         // ← add the artist name
  audio: "assets/khat-audio.mp3",
  artwork: "assets/khat-artwork.jpg",

  // Deterministic seed — same seed = same constellation on every replay.
  // Change it to explore a different (but still stable) arrangement.
  seed: 1729,

  finale: {
    start: 285.5,     // 04:45.5 — during the held "liye" of the last line. null = 1.5 s after the last word
    converge: 7,      // → one star at ~04:52.5, exactly as the music fades to silence
    loopAt: null      // seconds — begin the loop early (e.g. to skip trailing silence). null = when audio ends
  }
};

window.KHAT.lyrics = [
  // Line timestamps supplied by the artist/LRC. `end` = where the vocal stops before a break.
  { text: "Kaagaz ke phool laau tere liye", time: 20.01 }, // 00:20.01
  { text: "Khat likhu tere liye", time: 26.61 }, // 00:26.61
  { text: "Mai Khuda me maanu nahi", time: 32.02 }, // 00:32.02
  { text: "Par maangu dua tere liye", time: 36.97, end: 43.15 }, // 00:36.97
  { text: "Tere liye ghar banaau", time: 44.14 }, // 00:44.14
  { text: "Deewaarein neele rang se sajaau", time: 49.47 }, // 00:49.47
  { text: "Pasand hai tumhe, maloom hai", time: 54.59 }, // 00:54.59
  { text: "Tumne bataya tha ek dafe", time: 60.00 }, // 01:00.00
  { text: "Neele phool laau tere liye", time: 65.38 }, // 01:05.38
  { text: "Khat likhu tere liye", time: 72.05 }, // 01:12.05
  { text: "Mai Khuda me maanu nahi", time: 77.50 }, // 01:17.50
  { text: "Par maangu dua tere liye", time: 82.48, end: 88.10 }, // 01:22.48
  { text: "Teri baatein nasamajh si phir bhi jaayaz lag rahi hain", time: 108.88 }, // 01:48.88
  { text: "Tu pareshan kar rahi hai phir bhi masoom lag rahi hai", time: 119.42 }, // 01:59.42
  { text: "Tere liye mandir jaaun", time: 129.48 }, // 02:09.48
  { text: "Tere naam ka diya jalaaun", time: 134.82 }, // 02:14.82
  { text: "Hasta rahe tu chaahe jo ho", time: 139.98 }, // 02:19.98
  { text: "Teri hasi ko nazar na lage", time: 145.47, end: 150.29 }, // 02:25.47
  { text: "Kaagaz ke phool laau tere liye", time: 150.81 }, // 02:30.81
  { text: "Khat likhu tere liye", time: 157.37 }, // 02:37.37
  { text: "Mai Khuda me maanu nahi", time: 162.79 }, // 02:42.79
  { text: "Par maangu dua tere liye", time: 167.68, end: 177.13 }, // 02:47.68
  { text: "Tere liye hum bane hain", time: 214.84 }, // 03:34.84
  { text: "Tere liye badal rahe hain", time: 220.20 }, // 03:40.20
  { text: "Kya mohabbat ho gayi hai", time: 225.50 }, // 03:45.50
  { text: "Teri hi teri baatein kare", time: 230.88 }, // 03:50.88
  { text: "Tere liye ghar banaau", time: 236.19 }, // 03:56.19
  { text: "Deewaarein neele rang se sajaau", time: 241.51 }, // 04:01.51
  { text: "Pasand hai tumhe, maloom hai", time: 246.67 }, // 04:06.67
  { text: "Tumne bataya tha ek dafe", time: 252.19, end: 259.66 }, // 04:12.19
  { text: "Dekh shayar bana tere liye", time: 265.45 }, // 04:25.45
  { text: "Nagma likha tere liye", time: 271.93 }, // 04:31.93
  { text: "Mai Khuda me maanu kyun", time: 277.57 }, // 04:37.57
  { text: "Tu Khuda mere liye", time: 282.78, end: 292.12 } // 04:42.78
];
