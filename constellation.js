/* ==========================================================================
   KHAT — constellation engine
   --------------------------------------------------------------------------
   Pure rendering: every frame is a function of the song time `t`
   (audio.currentTime) plus a wall-clock `now` used only for ambient
   twinkle. Because nothing is accumulated between frames, pause, resume,
   seek and replay are always in sync.

   Pipeline (on every resize):
     layout()      seeded placement of stars + non-overlapping word labels
     buildGraph()  organic adjacency graph (no sequential i → i+1 links)
   ========================================================================== */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  /** Small, fast, deterministic PRNG. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Uniform grid for fast rectangle / point collision queries. */
  class SpatialGrid {
    constructor(cell) {
      this.cell = Math.max(8, cell);
      this.cells = new Map();
    }
    _key(cx, cy) {
      return (cx + 4096) * 16384 + (cy + 4096);
    }
    insert(item, x0, y0, x1, y1) {
      const c = this.cell;
      for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
        for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) {
          const k = this._key(cx, cy);
          let bucket = this.cells.get(k);
          if (!bucket) this.cells.set(k, (bucket = []));
          bucket.push(item);
        }
      }
    }
    /** Returns true as soon as `fn(item)` returns true. */
    some(x0, y0, x1, y1, fn) {
      const c = this.cell;
      for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
        for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) {
          const bucket = this.cells.get(this._key(cx, cy));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) if (fn(bucket[i])) return true;
        }
      }
      return false;
    }
  }

  const overlaps = (a, b, pad = 0) =>
    a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;

  function makeSprite(size, stops) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    stops.forEach(([o, col]) => grad.addColorStop(o, col));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  const ANCHORS = ['right', 'left', 'top', 'bottom'];

  class Constellation {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{text:string,time:number,phrase:number}[]} words  sorted by time
     * @param {{seed?:number,fontFamily?:string}} options
     */
    constructor(canvas, words, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.words = words;
      this.times = words.map((w) => w.time);
      this.seed = (options.seed >>> 0) || 1729;
      this.fontFamily = options.fontFamily || '"Noto Serif Devanagari", "Noto Sans Devanagari", serif';

      this.finaleStart = Infinity;
      this.finaleDuration = 10;

      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.fontSize = 15;
      this.nodes = [];
      this.edges = [];
      this.dust = [];
      this.hover = -1;

      this.sprites = {
        halo: makeSprite(128, [
          [0, 'rgba(245,250,255,1)'],
          [0.07, 'rgba(220,238,255,0.8)'],
          [0.22, 'rgba(168,213,255,0.26)'],
          [0.5, 'rgba(25,56,91,0.08)'],
          [1, 'rgba(7,17,31,0)']
        ]),
        core: makeSprite(32, [
          [0, 'rgba(255,255,255,1)'],
          [0.3, 'rgba(245,250,255,0.85)'],
          [1, 'rgba(245,250,255,0)']
        ])
      };
    }

    setFinale(start, duration) {
      this.finaleStart = Number.isFinite(start) ? start : Infinity;
      this.finaleDuration = Math.max(1, duration || 10);
    }

    /** Resize the backing store (DPR-aware) and rebuild the deterministic layout. */
    resize(cssW, cssH, dpr) {
      cssW = Math.max(1, Math.round(cssW));
      cssH = Math.max(1, Math.round(cssH));
      dpr = Math.min(2, dpr || 1);
      if (cssW === this.w && cssH === this.h && dpr === this.dpr) return false;
      this.w = cssW;
      this.h = cssH;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.layout();
      return true;
    }

    font(size) {
      return `300 ${size}px ${this.fontFamily}`;
    }

    /* ------------------------------------------------------------------ */
    /*  Layout                                                             */
    /* ------------------------------------------------------------------ */

    layout() {
      const N = this.words.length;
      const W = this.w;
      const H = this.h;

      // Ambient dust (non-lyric background stars).
      const drng = mulberry32(this.seed ^ 0x51ed27);
      const dustCount = Math.min(240, Math.round((W * H) / 7000));
      this.dust = [];
      for (let i = 0; i < dustCount; i++) {
        this.dust.push({
          x: drng() * W,
          y: drng() * H,
          r: 0.25 + drng() * 0.65,
          a: 0.04 + drng() * 0.16,
          ph: drng() * TAU,
          sp: 0.4 + drng()
        });
      }

      if (!N) {
        this.nodes = [];
        this.edges = [];
        return;
      }

      // Pick a font size, then shrink until (almost) everything fits without overlap.
      let fs = Math.round(clamp(Math.min(W, H * 1.15) * 0.021, 12, 19));
      const area = W * H;
      // Coarse capacity estimate so very long lyrics start smaller.
      while (fs > 11 && N * fs * fs * 9 > area * 0.55) fs--;

      let result = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        result = this._place(fs);
        if (result.fails <= Math.max(1, Math.floor(N * 0.03)) || fs <= 11) break;
        fs--;
      }
      this.fontSize = fs;
      this.nodes = result.nodes;
      this._computeOcclusion();
      this._decorateNodes();
      this.buildGraph();
    }

    _place(fs) {
      const rng = mulberry32(this.seed);
      const ctx = this.ctx;
      ctx.font = this.font(fs);
      const W = this.w;
      const H = this.h;
      const N = this.words.length;

      const margin = Math.max(18, Math.min(W, H) * 0.06);
      const bx0 = margin;
      const by0 = margin;
      const bx1 = W - margin;
      const by1 = H - margin;
      const edgeSafe = 8;

      const lh = fs * 1.35;
      const gap = fs * 0.62;
      const pad = fs * 0.34;
      const minStar = fs * 1.6;

      const labels = new SpatialGrid(fs * 5);
      const stars = new SpatialGrid(fs * 4);
      const nodes = [];

      // A few seeded density attractors → balanced but asymmetric distribution.
      const attractors = [];
      for (let k = 0; k < 3; k++) {
        attractors.push({
          x: bx0 + (0.15 + rng() * 0.7) * (bx1 - bx0),
          y: by0 + (0.15 + rng() * 0.7) * (by1 - by0),
          r: Math.min(W, H) * (0.18 + rng() * 0.22),
          w: 0.45 + rng() * 0.55
        });
      }
      const density = (x, y) => {
        let d = 0.3;
        for (const a of attractors) {
          const dx = x - a.x;
          const dy = y - a.y;
          d += a.w * Math.exp(-(dx * dx + dy * dy) / (2 * a.r * a.r));
        }
        return Math.min(1.2, d);
      };

      const nearestStar = (x, y, R) => {
        let best = R * R;
        stars.some(x - R, y - R, x + R, y + R, (n) => {
          const dx = n.x - x;
          const dy = n.y - y;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
          return false;
        });
        return Math.sqrt(best);
      };

      const labelRect = (x, y, anchor, tw) => {
        switch (anchor) {
          case 'right':
            return { x0: x + gap, y0: y - lh / 2, x1: x + gap + tw, y1: y + lh / 2 };
          case 'left':
            return { x0: x - gap - tw, y0: y - lh / 2, x1: x - gap, y1: y + lh / 2 };
          case 'top':
            return { x0: x - tw / 2, y0: y - gap * 0.6 - lh, x1: x + tw / 2, y1: y - gap * 0.6 };
          default:
            return { x0: x - tw / 2, y0: y + gap * 0.6, x1: x + tw / 2, y1: y + gap * 0.6 + lh };
        }
      };

      // minIdx > 0 → relaxed mode: only labels of recent words block placement.
      const evaluate = (x, y, tw, minIdx) => {
        if (x < bx0 || x > bx1 || y < by0 || y > by1) return null;
        const tooClose = stars.some(x - minStar, y - minStar, x + minStar, y + minStar, (n) => {
          const dx = n.x - x;
          const dy = n.y - y;
          return dx * dx + dy * dy < minStar * minStar;
        });
        if (tooClose) return null;
        const p = { x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 };
        if (labels.some(p.x0, p.y0, p.x1, p.y1, (n) => n.i >= minIdx && overlaps(p, n.rect))) return null;

        const start = Math.floor(rng() * 4);
        for (let k = 0; k < 4; k++) {
          const anchor = ANCHORS[(start + k) % 4];
          const r = labelRect(x, y, anchor, tw);
          if (r.x0 < edgeSafe || r.x1 > W - edgeSafe || r.y0 < edgeSafe || r.y1 > H - edgeSafe) continue;
          const hit = labels.some(r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad, (n) =>
            n.i >= minIdx && overlaps(r, n.rect, pad)
          );
          if (hit) continue;
          const coversStar = stars.some(r.x0 - 4, r.y0 - 4, r.x1 + 4, r.y1 + 4, (n) =>
            n.x > r.x0 - 4 && n.x < r.x1 + 4 && n.y > r.y0 - 4 && n.y < r.y1 + 4
          );
          if (coversStar) continue;
          return { anchor, rect: r };
        }
        return null;
      };

      let heading = rng() * TAU;
      let prev = null;
      let fails = 0;

      for (let i = 0; i < N; i++) {
        const word = this.words[i];
        const tw = ctx.measureText(word.text).width;
        const newPhrase = !prev || word.phrase !== this.words[i - 1].phrase;
        let best = null;
        let bestScore = -Infinity;

        const consider = (x, y, score, minIdx) => {
          const res = evaluate(x, y, tw, minIdx);
          if (!res) return;
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, anchor: res.anchor, rect: res.rect };
          }
        };

        // 1. Continue the phrase: drift near the previous word so lines stay readable.
        //    Search in widening rings so a crowded field still keeps the line together.
        if (!newPhrase) {
          for (let ring = 0; ring < 3 && !best; ring++) {
            const spread = 2.4 + ring * 1.6;
            for (let k = 0; k < 40; k++) {
              const turn = (rng() - 0.5) * spread;
              const ang = heading + turn;
              const d = fs * (2.6 + ring * 2.2 + rng() * 3.2) + tw * 0.35;
              const x = prev.x + Math.cos(ang) * d;
              const y = prev.y + Math.sin(ang) * d;
              const space = nearestStar(x, y, fs * 8) / (fs * 8);
              consider(x, y, space * 0.6 + density(x, y) * 0.3 - Math.abs(turn) * 0.08 + rng() * 0.15, 0);
            }
          }
        }
        // 2. New phrase (or no local room): best-candidate sampling over the whole field.
        if (!best) {
          for (let k = 0; k < 110; k++) {
            const x = bx0 + rng() * (bx1 - bx0);
            const y = by0 + rng() * (by1 - by0);
            const space = nearestStar(x, y, fs * 14) / (fs * 14);
            consider(x, y, space * 0.65 + density(x, y) * 0.45 + rng() * 0.1, 0);
          }
        }
        // 3. Field is full: only avoid recent labels; older overlapped labels fade out (see occlusion).
        let relaxed = false;
        if (!best) {
          fails++;
          relaxed = true;
          for (let k = 0; k < 160 && !best; k++) {
            const x = bx0 + rng() * (bx1 - bx0);
            const y = by0 + rng() * (by1 - by0);
            consider(x, y, rng(), Math.max(1, i - 24));
          }
        }
        if (!best) {
          // Last resort: anywhere inside the bounds.
          const x = bx0 + rng() * (bx1 - bx0);
          const y = by0 + rng() * (by1 - by0);
          best = { x, y, anchor: 'right', rect: labelRect(x, y, 'right', tw) };
        }

        const node = { i, x: best.x, y: best.y, anchor: best.anchor, rect: best.rect, tw, relaxed };
        nodes.push(node);
        stars.insert(node, node.x, node.y, node.x, node.y);
        labels.insert(node, node.rect.x0, node.rect.y0, node.rect.x1, node.rect.y1);

        if (prev && !newPhrase) heading = Math.atan2(node.y - prev.y, node.x - prev.x);
        else heading = rng() * TAU;
        prev = node;
      }

      return { nodes, fails };
    }

    /** If two labels overlap, the earlier one fades out when the later one appears. */
    _computeOcclusion() {
      const nodes = this.nodes;
      const grid = new SpatialGrid(this.fontSize * 5);
      const pad = this.fontSize * 0.2;
      nodes.forEach((n) => {
        n.hideAt = Infinity;
        grid.insert(n, n.rect.x0, n.rect.y0, n.rect.x1, n.rect.y1);
      });
      nodes.forEach((n) => {
        grid.some(n.rect.x0 - pad, n.rect.y0 - pad, n.rect.x1 + pad, n.rect.y1 + pad, (m) => {
          if (m.i > n.i && overlaps(n.rect, m.rect, pad)) {
            n.hideAt = Math.min(n.hideAt, this.times[m.i]);
          }
          return false;
        });
      });
    }

    _decorateNodes() {
      const rng = mulberry32(this.seed ^ 0xa5a5a5);
      const cx = this.w / 2;
      const cy = this.h / 2;
      const maxD = Math.hypot(cx, cy);
      const scale = clamp(this.fontSize / 16, 0.8, 1.2);
      const swirlDir = rng() < 0.5 ? -1 : 1;
      const N = this.nodes.length;

      this.nodes.forEach((n, i) => {
        n.t = this.times[i];
        n.text = this.words[i].text;
        n.r = (1.0 + rng() * 1.5) * scale;
        n.b = 0.7 + rng() * 0.3;
        n.ph = rng() * TAU;
        n.ts = 0.5 + rng() * 1.3;
        n.ds = 0.6 + rng() * 0.8;
        n.lx = n.rect.x0;
        n.ly = (n.rect.y0 + n.rect.y1) / 2;
        n.ox = n.lx - n.x; // label offset from star
        n.oy = n.ly - n.y;
        // Finale choreography: outer stars set off first, everyone spirals the same way.
        const dn = Math.hypot(n.x - cx, n.y - cy) / maxD;
        n.fd = 0.04 + 0.24 * (1 - dn) + rng() * 0.08; // departure (fraction of finale)
        n.fe = 0.8 + rng() * 0.18; // arrival
        n.swirl = swirlDir * (0.55 + rng() * 0.6);
        n.lf = N > 1 ? i / (N - 1) : 0; // label fade order
        n.px = n.x;
        n.py = n.y;
        n.pp = 0;
      });
    }

    /* ------------------------------------------------------------------ */
    /*  Adjacency graph                                                    */
    /* ------------------------------------------------------------------ */

    buildGraph() {
      const nodes = this.nodes;
      const N = nodes.length;
      const rng = mulberry32((this.seed * 31 + 7) >>> 0);
      const deg = new Uint8Array(N);
      const seen = new Set();
      const edges = [];
      const MAX_DEG = 3;
      const diag = Math.hypot(this.w, this.h);

      const add = (i, j, long) => {
        if (i === j || Math.abs(i - j) <= 2) return false; // never sequential lyric links
        const key = i < j ? i * 100000 + j : j * 100000 + i;
        if (seen.has(key) || deg[i] >= MAX_DEG || deg[j] >= MAX_DEG) return false;
        seen.add(key);
        deg[i]++;
        deg[j]++;
        const newer = nodes[i].t >= nodes[j].t ? i : j;
        const older = newer === i ? j : i;
        const side = rng() < 0.5 ? -1 : 1;
        edges.push({
          a: newer,
          b: older,
          t0: Math.max(nodes[i].t, nodes[j].t) + 0.3 + rng() * 0.8,
          bend: side * (long ? 0.1 + rng() * 0.12 : 0.14 + rng() * 0.26),
          skew: (rng() - 0.5) * 0.3,
          transient: rng() < 0.3,
          life: 6 + rng() * 10,
          sp: 0.6 + rng() * 0.8,
          ph: rng() * TAU,
          long
        });
        return true;
      };

      // Local links: each star reaches toward a few nearby — but non-adjacent — words.
      const order = Array.from({ length: N }, (_, i) => i);
      for (let k = N - 1; k > 0; k--) {
        const s = Math.floor(rng() * (k + 1));
        [order[k], order[s]] = [order[s], order[k]];
      }
      for (const i of order) {
        const r = rng();
        const target = r < 0.16 ? 0 : r < 0.62 ? 1 : 2;
        if (deg[i] >= target) continue;
        const ni = nodes[i];
        const cand = [];
        for (let j = 0; j < N; j++) {
          if (Math.abs(i - j) <= 2) continue;
          const dx = nodes[j].x - ni.x;
          const dy = nodes[j].y - ni.y;
          cand.push([dx * dx + dy * dy, j]);
        }
        cand.sort((p, q) => p[0] - q[0]);
        for (let c = 0; c < Math.min(8, cand.length) && deg[i] < target; c++) {
          if (rng() < 0.3) continue; // skip some nearest → less predictable
          add(i, cand[c][1], false);
        }
      }

      // A handful of long, graceful arcs across the field.
      const L = Math.max(N > 6 ? 1 : 0, Math.round(N * 0.05));
      for (let made = 0, tries = 0; made < L && tries < L * 40; tries++) {
        const i = Math.floor(rng() * N);
        const j = Math.floor(rng() * N);
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < diag * 0.22 || d > diag * 0.55) continue;
        if (add(i, j, true)) made++;
      }

      this.edges = edges;
    }

    /* ------------------------------------------------------------------ */
    /*  Queries                                                            */
    /* ------------------------------------------------------------------ */

    activeIndex(t) {
      const a = this.times;
      let lo = 0;
      let hi = a.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] <= t) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    }

    /** Star (or revealed label) under a point, for hover / click-to-seek. */
    pick(x, y, t) {
      if (t >= this.finaleStart) return -1;
      let best = -1;
      let bestD = 18 * 18;
      for (const n of this.nodes) {
        const dx = n.x - x;
        const dy = n.y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = n.i;
        }
      }
      if (best >= 0) return best;
      const active = this.activeIndex(t);
      for (let i = active; i >= 0; i--) {
        const r = this.nodes[i].rect;
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && t < this.nodes[i].hideAt) return i;
      }
      return -1;
    }

    /* ------------------------------------------------------------------ */
    /*  Render                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * @param {number} t     song time in seconds (negative = not started)
     * @param {number} now   performance.now() — ambient motion only
     * @param {{intro?:number, outro?:number}} env  loop transition multipliers
     */
    render(t, now, env = {}) {
      const ctx = this.ctx;
      const { w, h, dpr } = this;
      const G = clamp((env.intro ?? 1) * (env.outro ?? 1), 0, 1);
      const F0 = this.finaleStart;
      const D = this.finaleDuration;
      const fp = Number.isFinite(F0) ? clamp((t - F0) / D, 0, 1) : 0;
      const cx = w / 2;
      const cy = h / 2;
      const active = this.activeIndex(t);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (G <= 0.001) return;

      /* positions -------------------------------------------------------- */
      for (const n of this.nodes) {
        let x = n.x;
        let y = n.y;
        let p = 0;
        if (fp > 0) {
          p = easeInOutCubic(clamp((fp - n.fd) / (n.fe - n.fd), 0, 1));
          if (p > 0) {
            const vx = x - cx;
            const vy = y - cy;
            const th = n.swirl * p;
            const s = 1 - p;
            const c = Math.cos(th);
            const sn = Math.sin(th);
            x = cx + (vx * c - vy * sn) * s;
            y = cy + (vx * sn + vy * c) * s;
          }
        }
        n.fx = x; // no drift — labels use this
        n.fy = y;
        const drift = 1 - p;
        n.px = x + Math.sin(now * 0.00021 * n.ds + n.ph) * 0.7 * drift;
        n.py = y + Math.cos(now * 0.00017 * n.ds + n.ph * 1.3) * 0.7 * drift;
        n.pp = p;
      }

      const gather = smoothstep(0.35, 1, fp);

      /* ambient dust ----------------------------------------------------- */
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#cfe6ff';
      const dustDim = 1 - 0.55 * gather;
      for (const d of this.dust) {
        const a = d.a * (0.65 + 0.35 * Math.sin(now * 0.0006 * d.sp + d.ph)) * dustDim * G;
        if (a < 0.005) continue;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(d.x + Math.sin(now * 0.00004 * d.sp + d.ph) * 4, d.y, d.r, 0, TAU);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'lighter';

      /* curved connections ------------------------------------------------ */
      const edgeFinale = Number.isFinite(F0) ? 1 - smoothstep(F0, F0 + D * 0.38, t) : 1;
      ctx.lineCap = 'round';
      for (const e of this.edges) {
        if (e.t0 >= F0) continue; // no new connections once the finale begins
        const age = t - e.t0;
        if (age <= 0) continue;
        let a = smoothstep(0, 1.4, age);
        if (e.transient) a *= 1 - smoothstep(e.life, e.life + 3.5, age);
        let base = 0.3 + 0.55 * Math.exp(-age / 5);
        base *= 0.75 + 0.25 * Math.sin(now * 0.0005 * e.sp + e.ph);
        if (this.hover === e.a || this.hover === e.b) base = Math.max(base, 0.95);
        const alpha = a * base * edgeFinale * G;
        if (alpha < 0.004) continue;

        const A = this.nodes[e.a];
        const B = this.nodes[e.b];
        const dx = B.px - A.px;
        const dy = B.py - A.py;
        const qx = (A.px + B.px) / 2 - dy * e.bend + dx * e.skew;
        const qy = (A.py + B.py) / 2 + dx * e.bend + dy * e.skew;

        // Draw-on: the curve grows outward from the newly lit star.
        const u = easeOutCubic(clamp(age / 1.8, 0, 1));
        let cx1 = qx;
        let cy1 = qy;
        let ex = B.px;
        let ey = B.py;
        if (u < 1) {
          cx1 = lerp(A.px, qx, u);
          cy1 = lerp(A.py, qy, u);
          ex = lerp(cx1, lerp(qx, B.px, u), u);
          ey = lerp(cy1, lerp(qy, B.py, u), u);
        }
        ctx.beginPath();
        ctx.moveTo(A.px, A.py);
        ctx.quadraticCurveTo(cx1, cy1, ex, ey);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.8;
        ctx.strokeStyle = `rgba(168,213,255,${(alpha * 0.08).toFixed(4)})`;
        ctx.stroke();
        ctx.lineWidth = 0.7;
        ctx.strokeStyle = `rgba(206,232,255,${(alpha * 0.5).toFixed(4)})`;
        ctx.stroke();

        if (u < 1) {
          const s = 9;
          ctx.globalAlpha = clamp((1 - u) * 0.9 * G, 0, 1);
          ctx.drawImage(this.sprites.core, ex - s / 2, ey - s / 2, s, s);
        }
      }

      /* stars ------------------------------------------------------------- */
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        const age = t - n.t;
        const tw = 0.72 + 0.28 * Math.sin(now * 0.0011 * n.ts + n.ph);
        const dim = 0.12 * n.b * tw;
        let inten;
        let size;
        let flash = 0;
        if (age < 0) {
          inten = dim;
          size = n.r * 0.75;
        } else {
          flash = Math.exp(-age / 1.6);
          const isActive = i === active;
          inten = (0.4 + 0.18 * tw) * n.b + 0.65 * flash + (isActive ? 0.16 : 0);
          size = n.r * (1 + 0.9 * flash + (isActive ? 0.2 : 0));
          const rise = smoothstep(0, 0.22, age);
          inten = lerp(dim, inten, rise);
        }
        if (i === this.hover) inten = Math.max(inten, 0.9);
        if (n.pp > 0) {
          inten += n.pp * 0.4;
          inten *= 1 - smoothstep(0.84, 1, n.pp); // hand light over to the single star
        }
        inten *= G;
        if (inten < 0.004) continue;

        const hs = size * (9 + 14 * flash);
        ctx.globalAlpha = clamp(inten * 0.5, 0, 1);
        ctx.drawImage(this.sprites.halo, n.px - hs / 2, n.py - hs / 2, hs, hs);
        const cs = size * 3.2;
        ctx.globalAlpha = clamp(inten, 0, 1);
        ctx.drawImage(this.sprites.core, n.px - cs / 2, n.py - cs / 2, cs, cs);
      }

      /* the single star ---------------------------------------------------- */
      if (fp > 0) this._renderUnion(t, gather, G);

      /* words ------------------------------------------------------------- */
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.font = this.font(this.fontSize);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let i = 0; i <= active; i++) {
        const n = this.nodes[i];
        const age = t - n.t;
        const p = smoothstep(0, 0.8, age);
        const k = active - i;
        let a = 0.2 + 0.8 * Math.exp(-k / 5.5); // recent words read clearly, older soften
        a *= 1 - 0.35 * smoothstep(18, 70, age);
        if (t >= n.hideAt) a *= 1 - smoothstep(n.hideAt, n.hideAt + 0.9, t);
        if (Number.isFinite(F0)) {
          const s = F0 + n.lf * D * 0.45;
          a *= 1 - smoothstep(s, s + D * 0.2, t);
        }
        if (i === this.hover) a = Math.max(a, 0.95);
        a *= p * G;
        if (a < 0.01) continue;

        const white = Math.exp(-k / 2.2);
        const r = Math.round(lerp(168, 245, white));
        const g = Math.round(lerp(213, 250, white));
        ctx.fillStyle = `rgba(${r},${g},255,${a.toFixed(3)})`;
        const blur = ((1 - p) * 9 + (k === 0 ? 10 : 0)) * dpr;
        if (blur > 0.5) {
          ctx.shadowColor = `rgba(168,213,255,${((k === 0 ? 0.5 : 0.4) * a).toFixed(3)})`;
          ctx.shadowBlur = blur;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fillText(n.text, n.fx + n.ox, n.fy + n.oy + (1 - p) * 5);
      }
      ctx.shadowBlur = 0;

      /* hover ring -------------------------------------------------------- */
      if (this.hover >= 0 && fp === 0 && this.nodes[this.hover]) {
        const n = this.nodes[this.hover];
        ctx.globalAlpha = 0.35 * G;
        ctx.strokeStyle = '#a8d5ff';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(n.px, n.py, 8, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    _renderUnion(t, gather, G) {
      const ctx = this.ctx;
      const cx = this.w / 2;
      const cy = this.h / 2;
      const m = Math.min(this.w, this.h);
      const union = this.finaleStart + this.finaleDuration;
      const after = t - union;
      const pulse = after > 0 ? 1 + 0.07 * Math.sin(after * 2.1) + 0.03 * Math.sin(after * 5.3 + 1) : 1;
      const k = gather * G;
      if (k < 0.002) return;

      // Atmosphere
      const R = m * (0.16 + 0.36 * gather) * pulse;
      const atm = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      atm.addColorStop(0, `rgba(168,213,255,${0.16 * k})`);
      atm.addColorStop(0.35, `rgba(25,56,91,${0.16 * k})`);
      atm.addColorStop(1, 'rgba(7,17,31,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = atm;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      // Soft diffraction flare (very restrained)
      const fl = m * 0.32 * gather * pulse;
      const hg = ctx.createLinearGradient(cx - fl, cy, cx + fl, cy);
      hg.addColorStop(0, 'rgba(168,213,255,0)');
      hg.addColorStop(0.5, `rgba(245,250,255,${0.32 * k})`);
      hg.addColorStop(1, 'rgba(168,213,255,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(cx - fl, cy - 0.6, fl * 2, 1.2);
      const vl = fl * 0.45;
      const vg = ctx.createLinearGradient(cx, cy - vl, cx, cy + vl);
      vg.addColorStop(0, 'rgba(168,213,255,0)');
      vg.addColorStop(0.5, `rgba(245,250,255,${0.2 * k})`);
      vg.addColorStop(1, 'rgba(168,213,255,0)');
      ctx.fillStyle = vg;
      ctx.fillRect(cx - 0.5, cy - vl, 1, vl * 2);

      // Halo + core
      const hs = (50 + m * 0.42 * gather) * pulse;
      ctx.globalAlpha = clamp(0.95 * k, 0, 1);
      ctx.drawImage(this.sprites.halo, cx - hs / 2, cy - hs / 2, hs, hs);
      const cs = (10 + 26 * gather) * pulse;
      ctx.globalAlpha = clamp(k, 0, 1);
      ctx.drawImage(this.sprites.core, cx - cs / 2, cy - cs / 2, cs, cs);
      ctx.drawImage(this.sprites.core, cx - cs / 4, cy - cs / 4, cs / 2, cs / 2);

      // One quiet ring at the moment of union
      if (after > 0 && after < 3.4) {
        const q = after / 3.4;
        ctx.globalAlpha = Math.pow(1 - q, 2) * 0.28 * G;
        ctx.strokeStyle = '#a8d5ff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 12 + easeOutCubic(q) * m * 0.32, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  global.KhatConstellation = Constellation;
})(window);
