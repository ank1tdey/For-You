/* ==========================================================================
   KHAT — app: audio, UI, render loop, loop system
   audio.currentTime is the single source of truth for lyric sync.
   ========================================================================== */
(function () {
  'use strict';

  const KHAT = window.KHAT || {};
  const song = Object.assign({ title: 'Khat', artist: '', seed: 1729 }, KHAT.song || {});
  const finaleCfg = Object.assign({ start: null, converge: 10, loopAt: null }, song.finale || {});

  const OUTRO_MS = 2600;   // final star fades
  const REBUILD_MS = 1900; // constellation atmosphere returns before audio restarts

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'),
    audio: $('audio'),
    art: $('art'),
    artwork: $('artwork'),
    title: $('title'),
    artist: $('artist'),
    play: $('play'),
    progress: $('progress'),
    current: $('current'),
    duration: $('duration'),
    mute: $('mute'),
    volume: $('volume'),
    status: $('status'),
    stage: $('stage'),
    canvas: $('sky')
  };

  /* ---------------------------------------------------------------- lyrics */

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /** Accepts word-level and segment-level entries → flat, sorted word list. */
  function normaliseLyrics(raw) {
    const entries = (Array.isArray(raw) ? raw : []).filter(Boolean);
    const out = [];
    entries.forEach((e, k) => {
      if (typeof e.text === 'string' && e.word == null) {
        const parts = e.text.trim().split(/\s+/).filter(Boolean);
        if (!parts.length || !isNum(e.time)) return warn('segment skipped (missing text or time)', k, e);
        let end = isNum(e.end) ? e.end : NaN;
        if (!isNum(end)) {
          const next = entries.slice(k + 1).find((x) => isNum(x.time));
          end = next ? next.time - 0.15 : e.time + parts.length * 0.45;
        }
        // Longer words get more time; cap ~1 s per word so a held final note doesn't stretch the line.
        const weights = parts.map((w) => w.length + 1);
        const total = weights.reduce((s, x) => s + x, 0);
        const span = Math.min(Math.max(0.05, end - e.time), parts.length * 1.0);
        let acc = 0;
        parts.forEach((w, i) => {
          out.push({ text: w, time: e.time + (span * acc) / total, group: 'seg' + k });
          acc += weights[i];
        });
      } else {
        const text = String(e.word == null ? '' : e.word).trim();
        if (!text || !isNum(e.time)) return warn('word skipped (missing word or time)', k, e);
        out.push({ text, time: e.time, group: e.line != null ? 'line' + e.line : null });
      }
    });
    out.sort((a, b) => a.time - b.time);

    // Phrase grouping drives layout: words of a phrase drift near each other.
    let phrase = 0;
    out.forEach((w, i) => {
      if (i > 0) {
        const p = out[i - 1];
        const newPhrase = w.group != null && p.group != null ? w.group !== p.group : w.time - p.time > 1.6;
        if (newPhrase) phrase++;
      }
      w.phrase = phrase;
    });
    return out;
  }

  function warn(msg, k, e) {
    console.warn(`[khat] lyrics.js entry #${k}: ${msg}`, e);
  }

  const words = normaliseLyrics(KHAT.lyrics);

  /* ---------------------------------------------------------------- engine */

  const sky = new window.KhatConstellation(el.canvas, words, { seed: song.seed });

  let finale = { start: Infinity, dur: finaleCfg.converge };
  function computeFinale() {
    const duration = el.audio.duration;
    const last = words.length ? words[words.length - 1].time : NaN;
    let start = isNum(finaleCfg.start) ? finaleCfg.start : isNum(last) ? last + 1.5 : Infinity;
    let dur = isNum(finaleCfg.converge) ? finaleCfg.converge : 10;
    if (isNum(duration) && duration > 0 && Number.isFinite(start)) {
      const room = duration - start - 2;
      if (room < dur) dur = Math.max(3, room);
    }
    finale = { start, dur };
    sky.setFinale(start, dur);
  }
  computeFinale();

  /* ---------------------------------------------------------------- state */

  const state = {
    started: false,     // false until first play → constellation idles in its dim state
    phase: 'live',      // 'live' | 'outro' | 'rebuild'
    phaseStart: 0,
    lastT: 0,
    scrubbing: false,
    uiT: -1,
    uiDur: -1
  };

  /* ---------------------------------------------------------------- audio */

  const audio = el.audio;
  if (song.audio && audio.getAttribute('src') !== song.audio) audio.src = song.audio;
  audio.loop = false; // the loop is choreographed manually

  function play() {
    state.started = true;
    el.app.classList.add('has-started');
    const p = audio.play();
    if (p && p.catch) p.catch((err) => {
      if (err && err.name === 'NotSupportedError') {
        showStatus(`Can't load the song. Check that this file exists: ${song.audio || 'assets/khat-audio.mp3'}`);
      } else if (err && err.name !== 'AbortError') {
        showStatus('Playback was blocked — press play again.');
      }
      syncPlayingClass();
    });
  }

  function togglePlay() {
    if (state.phase !== 'live') {
      // During the loop transition, play/pause stops the loop at the beginning.
      state.phase = 'live';
      state.started = false;
      el.app.classList.remove('has-started');
      audio.currentTime = 0;
      syncPlayingClass();
      return;
    }
    if (audio.paused || audio.ended) {
      if (audio.ended) audio.currentTime = 0;
      play();
    } else {
      audio.pause();
    }
  }

  function seekTo(seconds) {
    if (!isNum(audio.duration)) return;
    if (state.phase !== 'live') state.phase = 'live';
    state.started = true;
    el.app.classList.add('has-started');
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, seconds));
  }

  function beginOutro(now) {
    if (state.phase !== 'live') return;
    state.phase = 'outro';
    state.phaseStart = now;
    if (!audio.paused) audio.pause();
    syncPlayingClass();
  }

  function beginRebuild(now) {
    state.phase = 'rebuild';
    state.phaseStart = now;
    audio.currentTime = 0;
  }

  function restartFromLoop() {
    state.phase = 'live';
    audio.currentTime = 0;
    play();
  }

  function syncPlayingClass() {
    const playing = state.phase !== 'live' || (!audio.paused && !audio.ended);
    el.app.classList.toggle('is-playing', playing);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function showStatus(msg) {
    el.status.textContent = msg;
    el.status.hidden = !msg;
  }

  const fmt = (s) => {
    if (!isNum(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  };

  /* ---------------------------------------------------------------- render loop */

  const smooth = (x) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };

  let rafId = 0;
  function frame(now) {
    rafId = requestAnimationFrame(frame);

    let t;
    let intro = 1;
    let outro = 1;

    if (state.phase === 'outro') {
      const e = (now - state.phaseStart) / OUTRO_MS;
      t = state.lastT;
      outro = 1 - smooth(e);
      if (e >= 1) beginRebuild(now);
    } else if (state.phase === 'rebuild') {
      const e = (now - state.phaseStart) / REBUILD_MS;
      t = -1;
      intro = smooth(e);
      if (e >= 1) restartFromLoop();
    } else if (!state.started) {
      t = -1;
    } else {
      t = audio.currentTime;
      state.lastT = t;
      if (isNum(finaleCfg.loopAt) && t >= finaleCfg.loopAt && !audio.paused) beginOutro(now);
    }

    sky.render(t, now, { intro, outro });
    updateTimeline(t);
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function updateTimeline(t) {
    const dur = audio.duration;
    const shown = state.phase === 'outro' ? dur : state.phase === 'rebuild' ? 0 : Math.max(0, t);
    if (!state.scrubbing && isNum(dur) && dur > 0) {
      const v = Math.round((shown / dur) * 1000);
      if (v !== state.uiT) {
        state.uiT = v;
        el.progress.value = v;
        el.progress.style.setProperty('--p', v / 10 + '%');
      }
    }
    const cur = Math.floor(shown || 0);
    if (cur !== state.uiCur) {
      state.uiCur = cur;
      el.current.textContent = fmt(cur);
    }
    if (dur !== state.uiDur && isNum(dur)) {
      state.uiDur = dur;
      el.duration.textContent = fmt(dur);
    }
  }

  /* ---------------------------------------------------------------- events */

  // One AbortController owns every listener → a single call tears everything down.
  const ac = new AbortController();
  const on = (target, type, fn, opts) => target.addEventListener(type, fn, Object.assign({ signal: ac.signal }, opts));

  on(el.play, 'click', togglePlay);

  on(audio, 'play', syncPlayingClass);
  on(audio, 'pause', syncPlayingClass);
  on(audio, 'ended', () => beginOutro(performance.now()));
  on(audio, 'loadedmetadata', () => {
    computeFinale();
    showStatus('');
  });
  on(audio, 'durationchange', computeFinale);
  on(audio, 'error', () => {
    showStatus(`Audio not found — add your song as ${song.audio || 'assets/khat-audio.mp3'}`);
    syncPlayingClass();
  });

  // Seek bar
  on(el.progress, 'input', () => {
    state.scrubbing = true;
    const v = Number(el.progress.value);
    el.progress.style.setProperty('--p', v / 10 + '%');
    if (isNum(audio.duration)) {
      seekTo((v / 1000) * audio.duration);
      el.current.textContent = fmt((v / 1000) * audio.duration);
    }
  });
  on(el.progress, 'change', () => {
    state.scrubbing = false;
    state.uiT = -1;
  });

  // Volume (remembered per browser)
  const VOL_KEY = 'khat.volume';
  try {
    const saved = parseFloat(localStorage.getItem(VOL_KEY));
    if (isNum(saved)) el.volume.value = saved;
  } catch (_) {}
  function applyVolume() {
    const v = Number(el.volume.value);
    audio.volume = v;
    el.volume.style.setProperty('--p', v * 100 + '%');
    el.app.classList.toggle('is-muted', audio.muted || v === 0);
  }
  applyVolume();
  on(el.volume, 'input', () => {
    audio.muted = false;
    applyVolume();
    try { localStorage.setItem(VOL_KEY, el.volume.value); } catch (_) {}
  });
  on(el.mute, 'click', () => {
    audio.muted = !audio.muted;
    applyVolume();
  });

  // Keyboard: Space/K play-pause, ←/→ seek 5 s, M mute
  on(window, 'keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
      if (e.target === el.play) return; // native button handles Space
      e.preventDefault();
      togglePlay();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && tag !== 'INPUT') {
      e.preventDefault();
      seekTo(audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5));
    } else if (e.key === 'm' || e.key === 'M') {
      audio.muted = !audio.muted;
      applyVolume();
    }
  });

  // Constellation interaction: hover a star to light its connections, click to jump to that word.
  const pointerPos = (e) => {
    const r = el.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const currentT = () => (state.started && state.phase === 'live' ? audio.currentTime : -1);
  on(el.canvas, 'pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const [x, y] = pointerPos(e);
    const i = state.phase === 'live' ? sky.pick(x, y, currentT()) : -1;
    sky.hover = i;
    el.canvas.style.cursor = i >= 0 ? 'pointer' : '';
  });
  on(el.canvas, 'pointerleave', () => {
    sky.hover = -1;
    el.canvas.style.cursor = '';
  });
  on(el.canvas, 'click', (e) => {
    if (state.phase !== 'live') return;
    const [x, y] = pointerPos(e);
    const i = sky.pick(x, y, currentT());
    if (i < 0) return;
    seekTo(words[i].time - 0.05);
    if (audio.paused) play();
  });

  // Artwork
  const markArtMissing = () => el.art.classList.add('is-missing');
  if (song.artwork && el.artwork.getAttribute('src') !== song.artwork) el.artwork.src = song.artwork;
  on(el.artwork, 'error', markArtMissing);
  if (el.artwork.complete && el.artwork.naturalWidth === 0) markArtMissing();

  // Meta
  el.title.textContent = song.title || 'Khat';
  el.artist.textContent = song.artist || '';
  document.title = song.artist ? `${song.title} — ${song.artist}` : song.title || 'Khat';

  /* ---------------------------------------------------------------- sizing */

  let pendingSize = null;
  let sizeRaf = 0;
  const ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    pendingSize = [r.width, r.height];
    if (!sizeRaf) {
      sizeRaf = requestAnimationFrame(() => {
        sizeRaf = 0;
        if (pendingSize) sky.resize(pendingSize[0], pendingSize[1], window.devicePixelRatio || 1);
      });
    }
  });

  // Re-layout once the lyric font is ready, so measurements are exact.
  function relayout() {
    const r = el.stage.getBoundingClientRect();
    sky.w = 0; // force
    sky.resize(r.width, r.height, window.devicePixelRatio || 1);
  }

  // DPR changes (moving between displays / zoom)
  let dprQuery = null;
  function watchDpr() {
    if (dprQuery) dprQuery.removeEventListener('change', onDpr);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener('change', onDpr, { signal: ac.signal });
  }
  function onDpr() {
    relayout();
    watchDpr();
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    ro.observe(el.stage);
    relayout();
    watchDpr();
    startLoop();
    requestAnimationFrame(() => el.app.classList.add('is-ready'));
    if (!words.length) showStatus('lyrics.js has no timed words yet.');
    if (new URLSearchParams(location.search).has('sync')) initSyncTool();
  }

  const fontsReady = document.fonts && document.fonts.load
    ? Promise.race([
        document.fonts.load(`300 16px "Noto Serif Devanagari"`, 'तेरी बातें abc'),
        new Promise((r) => setTimeout(r, 1800))
      ])
    : Promise.resolve();
  fontsReady.catch(() => {}).then(boot);
  if (document.fonts) on(document.fonts, 'loadingdone', relayout);

  /** Full teardown — useful if this experience is ever mounted inside another page. */
  function destroy() {
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(sizeRaf);
    rafId = 0;
    ro.disconnect();
    ac.abort();
    audio.pause();
  }
  window.KHAT.destroy = destroy;

  /* ---------------------------------------------------------------- sync tool */
  /* Open index.html?sync — press S (or "Mark") on every word while the song
     plays; Backspace undoes. "Export" writes a ready-to-paste lyrics array. */

  function initSyncTool() {
    const raw = (KHAT.lyrics || []).flatMap((e) =>
      e && typeof e.text === 'string' && e.word == null
        ? e.text.trim().split(/\s+/).filter(Boolean)
        : e && e.word != null ? [String(e.word).trim()] : []
    ).filter(Boolean);
    const stamps = [];
    const box = document.createElement('div');
    box.className = 'sync';
    box.innerHTML = `
      <p>Sync mode · press <b>S</b> on each word as it is sung · Backspace to undo</p>
      <div class="next"></div>
      <div class="row">
        <button type="button" data-a="mark">Mark (S)</button>
        <button type="button" data-a="undo">Undo</button>
        <button type="button" data-a="export">Export</button>
      </div>
      <textarea readonly hidden></textarea>`;
    el.stage.appendChild(box);
    const nextEl = box.querySelector('.next');
    const out = box.querySelector('textarea');
    const render = () => {
      const i = stamps.length;
      nextEl.textContent = i < raw.length ? `${i + 1}/${raw.length} · ${raw[i]}` : 'All words marked — Export';
    };
    const mark = () => {
      if (stamps.length < raw.length) stamps.push(Math.round(audio.currentTime * 100) / 100);
      render();
    };
    const undo = () => {
      stamps.pop();
      render();
    };
    const exp = () => {
      const lines = raw.map((w, i) =>
        `  { word: ${JSON.stringify(w)}, time: ${stamps[i] != null ? stamps[i].toFixed(2) : 'null'} }`
      );
      out.value = `window.KHAT.lyrics = [\n${lines.join(',\n')}\n];\n`;
      out.hidden = false;
      out.select();
      if (navigator.clipboard) navigator.clipboard.writeText(out.value).catch(() => {});
    };
    on(box, 'click', (e) => {
      const a = e.target.closest('button') && e.target.closest('button').dataset.a;
      if (a === 'mark') mark();
      if (a === 'undo') undo();
      if (a === 'export') exp();
    });
    on(window, 'keydown', (e) => {
      if (e.target === out) return;
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); mark(); }
      if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    });
    render();
  }
})();
