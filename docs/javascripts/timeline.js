/* CaMa-Flood-GPU docs: interactive run timeline.
 *
 * Embed with <div class="cmf-timeline" data-view="time-axis|statistics"
 * [data-preset="..."]></div>. Dependency-free; mounts on every Material page load
 * (document$) or on DOMContentLoaded.
 *
 * Everything the widget animates is computed from a model of the real code
 * (HydroForge 014720f, CaMa-Flood-GPU bb0fafe):
 *   - schedule, reuse_count, upsampling rule, spin-up and source chunks:
 *     hydroforge/data/datasets/plan.py (TemporalDomain.declare, SourceChunkPlan.compile,
 *     compile_cadence), contracts/schedule.py (_step_at_trusted),
 *     data/datasets/base.py (_distributed divides by reuse_count)
 *   - runoff loading: scripts/run_*.py use torch DataLoader(dataset, batch_size=None,
 *     num_workers, prefetch_factor); one item = one source chunk. torch dispatches
 *     num_workers * prefetch_factor indices up front, index i to worker i % num_workers
 *     (in-order round robin), and one more index each time the loop receives a chunk.
 *   - statistics windows: hydroforge/statistics/windows.py (StatisticsWindowController,
 *     WindowState): spin-up steps belong to no window, records are labelled with the
 *     start of their inner window, compound outputs publish at outer closes,
 *     partial_period "close"/"drop".
 *   - samples: one per sub-step, weight dt (execution/executors/eager.py).
 *   - output: hydroforge/io/rank_output/ring.py (plan_output_batches) and writer.py
 *     (RankOutputWriter): one file per output and rank, each file pinned to one
 *     writer process, `depth` slots of `batch` rows, a full slot is appended by its
 *     writer, a slot is reused only after its append finished, close() flushes
 *     partial slots.
 * Durations (how long a read, a step or an append takes) are illustrative only.
 */
(function () {
  "use strict";

  var HOUR = 3600e3;
  var DAY = 24 * HOUR;
  var T0 = Date.UTC(2000, 0, 1);
  var SVGNS = "http://www.w3.org/2000/svg";

  /* ------------------------------------------------------------ options */
  var PERIODS = {
    d10: { label: "10 days (2000-01-01 to 01-10)", last: Date.UTC(2000, 0, 10) },
    d75: { label: "2½ months (to 2000-03-15)", last: Date.UTC(2000, 2, 15) },
    y1: { label: "1 year (2000, 366 days)", last: Date.UTC(2000, 11, 31) },
    m14: { label: "14 months (to 2001-02-28)", last: Date.UTC(2001, 1, 28) }
  };
  // one spin-up cycle replays this source period
  var SPIN_FIRST = T0;
  var SPIN_LAST = Date.UTC(2000, 0, 10);

  var OPS = [
    { id: "mean", variable: "total_outflow", compound: false },
    { id: "max", variable: "total_outflow", compound: false },
    { id: "last", variable: "river_depth", compound: false },
    { id: "max_mean", variable: "total_outflow", compound: true }
  ];

  var DEFAULTS = {
    step: 24, interval: 24, upsampling: "repeat", sub: "adaptive", spin: 1,
    period: "d75", chunk: 1, loaders: 2, prefetch: 2,
    inner: "day", outer: "none", ops: ["mean", "last"], partial: "close",
    writers: 2, pending: 200, ranks: 1
  };

  var PRESETS = {
    daily: {
      short: "Daily",
      label: "One year of daily runoff and daily steps (as run_daily_bin.py, + 1 spin-up cycle)",
      cfg: { step: 24, interval: 24, sub: "adaptive", spin: 1, period: "y1", chunk: 1,
        loaders: 2, prefetch: 2, inner: "day", outer: "none", ops: ["mean", "last"],
        partial: "close", writers: 2, pending: 200, ranks: 1 }
    },
    era5: {
      short: "Hourly ERA5",
      label: "Hourly runoff, hourly steps, daily statistics (as run_era5.py)",
      cfg: { step: 1, interval: 1, sub: "adaptive", spin: 0, period: "d10", chunk: 24,
        loaders: 1, prefetch: 2, inner: "day", outer: "none", ops: ["mean", "last"],
        partial: "close", writers: 2, pending: 200, ranks: 1 }
    },
    upsample: {
      short: "6 h from daily",
      label: "6-hourly steps from daily runoff (upsampling)",
      cfg: { step: 6, interval: 24, upsampling: "repeat", sub: "fixed", spin: 1, period: "d10",
        chunk: 2, loaders: 2, prefetch: 2, inner: "day", outer: "none", ops: ["mean", "last"],
        partial: "close", writers: 2, pending: 200, ranks: 1 }
    },
    annual: {
      short: "Annual max",
      label: "One year of daily means and their annual maximum (max_mean)",
      cfg: { step: 24, interval: 24, sub: "adaptive", spin: 0, period: "y1", chunk: 1,
        loaders: 2, prefetch: 2, inner: "day", outer: "year", ops: ["mean", "max_mean"],
        partial: "close", writers: 2, pending: 200, ranks: 1 }
    },
    monthly: {
      short: "Monthly max",
      label: "Monthly maximum of daily means (max_mean)",
      cfg: { step: 24, interval: 24, sub: "adaptive", spin: 0, period: "d75", chunk: 1,
        loaders: 2, prefetch: 2, inner: "day", outer: "month", ops: ["mean", "max_mean"],
        partial: "close", writers: 2, pending: 200, ranks: 1 }
    },
    small: {
      short: "Small batches",
      label: "Small batches: max_pending_steps=8, 2 ranks",
      cfg: { step: 24, interval: 24, sub: "adaptive", spin: 0, period: "d75", chunk: 1,
        loaders: 2, prefetch: 2, inner: "day", outer: "month", ops: ["mean", "last", "max_mean"],
        partial: "close", writers: 2, pending: 8, ranks: 2 }
    },
    inproc: {
      short: "No workers",
      label: "output_workers=0 and loader_workers=0 (everything in the model process)",
      cfg: { step: 24, interval: 24, sub: "adaptive", spin: 0, period: "d10", chunk: 1,
        loaders: 0, prefetch: 2, inner: "day", outer: "none", ops: ["mean", "last"],
        partial: "close", writers: 0, pending: 8, ranks: 1 }
    }
  };

  // [value, short label, tooltip]; segmented unless select: true
  var FIELDS = {
    step: { label: "model_step", opts: [[24, "1 d"], [6, "6 h"], [1, "1 h"]], num: true },
    interval: { label: "time_interval", opts: [[24, "1 d"], [6, "6 h"], [1, "1 h"]], num: true },
    upsampling: { label: "upsampling", wide: true, opts: [["none", "None"], ["repeat", "repeat"], ["distribute", "distribute"]] },
    sub: { label: "num_sub_steps", opts: [["fixed", "fixed", "fixed N = model_step / 240 s (360 per day)"], ["adaptive", "adaptive", "num_sub_steps=None with the adaptive_time module"]] },
    spin: { label: "spin_up_cycles", opts: [[0, "0"], [1, "1"], [2, "2"]], num: true },
    period: { label: "period", select: true, opts: Object.keys(PERIODS).map(function (k) { return [k, PERIODS[k].label]; }) },
    chunk: { label: "chunk_len", opts: [[1, "1"], [2, "2"], [8, "8"], [24, "24"]], num: true },
    loaders: { label: "loader_workers", opts: [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], num: true },
    prefetch: { label: "prefetch_factor", opts: [[1, "1"], [2, "2"], [3, "3"]], num: true },
    inner: { label: "inner window", opts: [["step", "step", "EveryStep()"], ["day", "day", 'CalendarWindow(period="day")']] },
    outer: { label: "outer window", wide: true, opts: [["none", "none", "outer=None: the outer window equals the inner one"], ["month", "month", 'CalendarWindow(period="month")'], ["year", "year", 'CalendarWindow(period="year")']] },
    partial: { label: "partial_period", opts: [["close", "close"], ["drop", "drop"]] },
    writers: { label: "output_workers", opts: [[0, "0"], [1, "1"], [2, "2"], [3, "3"]], num: true },
    pending: { label: "max_pending_steps", opts: [[200, "200"], [20, "20"], [8, "8"]], num: true },
    ranks: { label: "ranks", opts: [[1, "1"], [2, "2"]], num: true }
  };

  var VIEW_FIELDS = {
    "time-axis": ["step", "interval", "upsampling", "sub", "spin", "chunk", "loaders", "prefetch", "inner", "period"],
    statistics: ["step", "inner", "outer", "ops", "partial", "spin", "writers", "pending", "ranks", "period"]
  };

  /* ------------------------------------------------------------ helpers */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(ms, hours) {
    var d = new Date(ms);
    var s = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
    if (hours) s += " " + pad2(d.getUTCHours()) + ":00";
    return s;
  }
  function fmtShort(ms, hours) {
    var d = new Date(ms);
    if (hours && d.getUTCHours() !== 0) return pad2(d.getUTCHours()) + "h";
    return pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  function fmtMonth(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1);
  }
  function hoursLabel(h) { return h === 24 ? "1 day" : h + " h"; }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // last index i with arr[i] <= t (arr sorted ascending), -1 if none
  function bisect(arr, t) {
    var lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] <= t) { r = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return r;
  }

  // Illustrative discharge (m3/s) near a river mouth and its depth (m): winter baseflow,
  // rain floods and a snowmelt flood peak in early June. Deterministic.
  var SIGNAL = (function () {
    // [day of year, amplitude, rise (d), recession (d)]
    var EV = [[5.5, 2100, 1.2, 4], [40, 3600, 1.8, 7], [62, 1500, 1, 4], [97, 1300, 1.5, 6],
      [203, 1700, 2, 9], [236, 2200, 1.6, 8], [281, 1000, 1.5, 6], [331, 800, 1.2, 5]];
    function q(tau) {
      var y = tau - 366 * Math.floor(tau / 366);
      var v = 700 + 260 * Math.cos(2 * Math.PI * (y - 200) / 366);
      var x = (y - 128) / 28;
      if (x > 0) v += 9800 * x * x * x * Math.exp(3 * (1 - x));
      for (var i = 0; i < EV.length; i++) {
        var e = EV[i], d = y - e[0];
        if (d < -5 * e[2] || d > 10 * e[3]) continue;
        v += d < 0 ? e[1] * Math.exp(-(d * d) / (2 * e[2] * e[2])) : e[1] * Math.exp(-d / e[3]);
      }
      return v * (1 + 0.015 * Math.sin(2 * Math.PI * (tau - 0.3)));
    }
    return {
      q: q,
      h: function (tau) { return 1.2 + 0.11 * Math.sqrt(q(tau)); },
      // runoff reaching the rivers (illustrative): leads the discharge by about two days
      r: function (tau) { return q(tau + 2); }
    };
  })();

  /* ------------------------------------------------------------ model */
  function batchPlan(pending, workers) {
    // ring.py plan_output_batches (rows small enough that RING_BYTES never binds here)
    var background = workers > 0;
    var pendingRows = background ? Math.floor(pending / 2) : pending;
    var batch = Math.max(1, Math.min(30, pendingRows));
    var depth = background ? Math.max(1, Math.floor(pending / batch)) : 1;
    return { batch: batch, depth: depth };
  }

  function windowKey(rule, ms) {
    if (rule === "step") return ms;
    var d = new Date(ms);
    if (rule === "day") return Math.floor(ms / DAY);
    if (rule === "month") return d.getUTCFullYear() * 12 + d.getUTCMonth();
    return d.getUTCFullYear(); // year, start_month=1
  }

  function buildModel(cfg) {
    var notes = [];
    var H = cfg.step, I = cfg.interval;
    if (H > I) {
      notes.push({ kind: "error", text: "model_step must not exceed dataset time_interval (plan.py compile_cadence): time_interval raised to " + hoursLabel(H) + "." });
      I = H;
    }
    var R = I / H; // reuse_count (all offered values divide evenly)
    var upsampling = R > 1 ? cfg.upsampling : null;
    var period = PERIODS[cfg.period] || PERIODS.d75;
    // TemporalDomain.declare: end_date is the last record; the main period ends one interval later
    var endDate = period.last + DAY - I * HOUR;
    var mainCount = Math.round((endDate - T0) / (I * HOUR)) + 1;
    var spinEndDate = SPIN_LAST + DAY - I * HOUR;
    var spinCount = cfg.spin > 0 ? Math.round((spinEndDate - SPIN_FIRST + I * HOUR) / (I * HOUR)) : 0;
    var L = cfg.chunk;

    // SourceChunkPlan.compile: every spin-up cycle, then the main period; short final chunks
    var chunks = [];
    function addPhase(phase, start, count, cycle) {
      for (var off = 0; off < count; off += L) {
        chunks.push({ index: chunks.length, phase: phase, cycle: cycle, start: start + off * I * HOUR,
          length: Math.min(L, count - off), steps: [] });
      }
    }
    for (var c = 0; c < cfg.spin; c++) addPhase("spinup", SPIN_FIRST, spinCount, c);
    var numSpinChunks = chunks.length;
    addPhase("main", T0, mainCount, null);

    // schedule (_step_at_trusted): reuse_count model steps per record
    var steps = [];
    var src = 0;
    chunks.forEach(function (ch) {
      for (var r = 0; r < ch.length; r++) {
        var recStart = ch.start + r * I * HOUR;
        for (var u = 0; u < R; u++) {
          var st = recStart + u * H * HOUR;
          var step = { i: steps.length, phase: ch.phase, cycle: ch.cycle, start: st, end: st + H * HOUR,
            record: src, recordStart: recStart, reuse: u, chunk: ch.index, n: 0 };
          steps.push(step);
          ch.steps.push(step.i);
        }
        src++;
      }
    });
    var numSpinSteps = 0;
    while (numSpinSteps < steps.length && steps[numSpinSteps].phase === "spinup") numSpinSteps++;

    // sub-steps: fixed N = T / 240 s (360 for a day), or adaptive N = ceil(T / min dt_i)
    var Tsec = H * 3600;
    var nMax = 0;
    steps.forEach(function (s, idx) {
      if (cfg.sub === "fixed") {
        s.n = Math.round(Tsec / 240);
      } else {
        var tau = (s.start - T0) / DAY;
        var h = SIGNAL.h(tau);
        if (s.phase === "spinup") {
          // illustrative: the river is still filling during spin-up
          var frac = (idx % Math.max(1, numSpinSteps / Math.max(1, cfg.spin))) / Math.max(1, numSpinSteps / Math.max(1, cfg.spin));
          h *= 0.35 + 0.25 * (s.cycle || 0) + 0.3 * frac;
        }
        var dt = 0.7 * 4000 / Math.sqrt(9.81 * Math.max(h, 0.01));
        s.n = Math.max(1, Math.ceil(Tsec / dt));
      }
      if (s.n > nMax) nMax = s.n;
    });

    // ---- statistics windows (windows.py), main steps only
    var innerRule = cfg.inner;
    var outerRule = cfg.outer === "none" ? innerRule : cfg.outer;
    var ops = OPS.filter(function (o) { return cfg.ops.indexOf(o.id) >= 0; });
    var innerOps = ops.filter(function (o) { return !o.compound; });
    var outerOps = ops.filter(function (o) { return o.compound; });
    var final = steps.length - 1;
    var droppedOuter = null;
    if (cfg.partial === "drop" && outerRule !== "step") {
      var fs = steps[final];
      var k0 = windowKey(outerRule, fs.start), k1 = windowKey(outerRule, fs.end);
      if (k0 === k1) droppedOuter = k0; // the final outer window is incomplete
    }
    var lastInner = null, lastOuter = null;
    var records = [];
    var innerWins = [], outerWins = [];
    var curInner = null, curOuter = null;
    var acc = null, foldMax = null, foldFrom = null, outerFolded = false;
    for (var i = numSpinSteps; i < steps.length; i++) {
      var s = steps[i];
      var ik = windowKey(innerRule, s.start), ok = windowKey(outerRule, s.start);
      var isFinal = i === final;
      var innerFirst = innerRule === "step" ? true : lastInner !== ik;
      var innerLast = innerRule === "step" ? true : (windowKey(innerRule, s.end) !== ik || (isFinal && cfg.partial === "close"));
      var outerFirst = outerRule === "step" ? true : lastOuter !== ok;
      var outerLast = outerRule === "step" ? true : (windowKey(outerRule, s.end) !== ok || (isFinal && cfg.partial === "close"));
      if (droppedOuter !== null && ok === droppedOuter) { s.dropped = true; continue; }
      if (lastInner === null) { innerFirst = true; outerFirst = true; }
      lastInner = ik; lastOuter = ok;
      if (innerFirst) {
        curInner = { first: i, last: i, label: s.start, closed: false };
        innerWins.push(curInner);
        acc = { wsum: 0, sum: 0, max: -Infinity, lastDepth: 0 };
      }
      if (outerFirst) {
        curOuter = { first: i, last: i, label: s.start, key: ok, closed: false };
        outerWins.push(curOuter);
        foldMax = null; foldFrom = null; outerFolded = false;
      }
      curInner.last = i; curOuter.last = i;
      s.inner = innerWins.length - 1; s.outer = outerWins.length - 1;
      // one sample after every sub-step, weight dt
      var dtd = (H / 24) / s.n, tau0 = (s.start - T0) / DAY;
      for (var k = 1; k <= s.n; k++) {
        var tau = tau0 + k * dtd, v = SIGNAL.q(tau);
        acc.wsum += dtd; acc.sum += v * dtd;
        if (v > acc.max) acc.max = v;
        if (k === s.n) acc.lastDepth = SIGNAL.h(tau);
      }
      if (innerLast) {
        curInner.closed = true;
        var mean = acc.sum / acc.wsum;
        if (foldMax === null || mean > foldMax) { foldMax = mean; foldFrom = curInner.label; }
        outerFolded = true;
        var streams = innerOps.map(function (o) { return o.id; });
        if (outerLast && outerFolded) { outerOps.forEach(function (o) { streams.push(o.id); }); curOuter.closed = true; }
        curInner.mean = mean;
        if (streams.length) {
          records.push({ step: i, label: curInner.label, streams: streams, outerClose: outerLast,
            values: { mean: mean, max: acc.max, last: acc.lastDepth, max_mean: foldMax, max_mean_from: foldFrom },
            hours: H < 24 && innerRule === "step" });
        }
      }
    }

    // ---- streams (one rank file per output), writer assignment (writer.py __init__)
    var bp = batchPlan(cfg.pending, cfg.writers);
    var streamDefs = ops.map(function (o, j) {
      return { op: o.id, key: o.variable + "_" + o.id, worker: cfg.writers > 0 ? j % cfg.writers : -1 };
    });

    // ---- wall-clock simulation (illustrative durations; 1 unit = one model step)
    var W = cfg.loaders, PF = cfg.prefetch;
    function readCost(ch) { return 0.3 + 0.3 * ch.length; }
    function writeCost(rows) { return 0.4 + 0.08 * rows; }
    var reads = new Array(chunks.length);
    var free = []; for (var w = 0; w < W; w++) free.push(0);
    function dispatch(idx, t) {
      var wk = idx % W, st = Math.max(t, free[wk]), rd = st + readCost(chunks[idx]);
      free[wk] = rd;
      reads[idx] = { chunk: idx, worker: wk, dispatch: t, start: st, ready: rd, recv: null };
    }
    if (W > 0) for (var d0 = 0; d0 < Math.min(W * PF, chunks.length); d0++) dispatch(d0, 0);

    var segs = []; // {kind, t0, t1, step?, text?}
    var stepT0 = new Float64Array(steps.length), stepT1 = new Float64Array(steps.length);
    var recByStep = {};
    records.forEach(function (r, j) { recByStep[r.step] = j; });

    // output state (rank 0; other ranks run the same schedule)
    var st = streamDefs.map(function () {
      return { slot: 0, rows: 0, fill: [], submitted: [], pendEnd: [], snaps: [], written: 0 };
    });
    st.forEach(function (x) {
      for (var j = 0; j < bp.depth; j++) { x.fill.push(0); x.submitted.push(0); x.pendEnd.push(null); }
    });
    var tasks = [];
    var wfree = []; for (var ww = 0; ww < cfg.writers; ww++) wfree.push(0);
    var slotEvents = []; // {t, s, slot, kind:'state', state, fill}
    function snap(si, t, slot, fill, state, written) {
      slotEvents.push({ t: t, s: si, slot: slot, fill: fill, state: state, written: written });
    }
    var t = 0;
    function submit(items, tNow, isClose) {
      // items: [{si, slot, start, stop}] grouped per worker -> one task per worker
      var byW = {};
      items.forEach(function (it) {
        var wk = streamDefs[it.si].worker;
        (byW[wk] = byW[wk] || []).push(it);
      });
      Object.keys(byW).forEach(function (wkS) {
        var wk = +wkS, list = byW[wkS];
        var rows = list.reduce(function (a, it) { return a + it.stop - it.start; }, 0);
        var dur = writeCost(rows);
        if (wk < 0) {
          // in-process append (output_workers=0): the model waits
          list.forEach(function (it) {
            var d = writeCost(it.stop - it.start);
            var x = st[it.si];
            snap(it.si, tNow, it.slot, it.stop, 3, x.written);
            segs.push({ kind: "write", t0: tNow, t1: tNow + d, text: streamDefs[it.si].key });
            tasks.push({ worker: -1, submit: tNow, start: tNow, end: tNow + d, close: isClose,
              items: [{ si: it.si, slot: it.slot, rows: it.stop - it.start }] });
            tNow += d;
            x.written += it.stop - it.start;
            x.submitted[it.slot] = it.stop;
            snap(it.si, tNow, it.slot, it.stop === bp.batch || isClose ? 0 : it.stop, it.stop === bp.batch || isClose ? 0 : 1, x.written);
          });
          return;
        }
        var start = Math.max(tNow, wfree[wk]), end = start + dur;
        wfree[wk] = end;
        var task = { worker: wk, submit: tNow, start: start, end: end, close: isClose,
          items: list.map(function (it) { return { si: it.si, slot: it.slot, rows: it.stop - it.start }; }) };
        tasks.push(task);
        list.forEach(function (it) {
          var x = st[it.si];
          x.submitted[it.slot] = it.stop;
          x.pendEnd[it.slot] = end;
          snap(it.si, tNow, it.slot, it.stop, 2, x.written);
          snap(it.si, start, it.slot, it.stop, 3, x.written);
          x.written += it.stop - it.start;
          slotEvents.push({ t: end, s: it.si, slot: it.slot, fill: 0, state: 0, written: x.written, done: true });
        });
      });
      return tNow;
    }
    function place(rec) {
      var full = [];
      streamDefs.forEach(function (sd, si) {
        if (rec.streams.indexOf(sd.op) < 0) return;
        var x = st[si];
        var slot = x.slot, row = x.rows;
        if (row === bp.batch) { slot = (slot + 1) % bp.depth; row = 0; }
        if (row === 0 && x.pendEnd[slot] !== null) {
          if (x.pendEnd[slot] > t) {
            // slot reuse waits for its previous append (writer.py _next_row)
            segs.push({ kind: "wait-slot", t0: t, t1: x.pendEnd[slot], text: sd.key + " slot " + slot });
            t = x.pendEnd[slot];
          }
          x.pendEnd[slot] = null;
        }
        if (row === 0) x.submitted[slot] = 0;
        x.slot = slot; x.rows = row + 1;
        x.fill[slot] = row + 1;
        snap(si, t, slot, row + 1, 1, x.written);
        if (row === bp.batch - 1) full.push({ si: si, slot: slot, start: x.submitted[slot], stop: bp.batch });
      });
      if (full.length) {
        var t2 = submit(full, t, false);
        if (cfg.writers === 0) {
          // in-process writes advanced the clock through their segments
          t = segs[segs.length - 1].t1;
        } else if (t2 !== undefined) t = t2;
      }
    }

    for (var ci = 0; ci < chunks.length; ci++) {
      var ch = chunks[ci];
      if (W > 0) {
        var rd = reads[ci];
        if (rd.ready > t) { segs.push({ kind: "wait-chunk", t0: t, t1: rd.ready, text: "chunk " + ci }); t = rd.ready; }
        rd.recv = t;
        if (ci + W * PF < chunks.length) dispatch(ci + W * PF, t);
      } else {
        var rc = readCost(ch);
        reads[ci] = { chunk: ci, worker: -1, dispatch: t, start: t, ready: t + rc, recv: t + rc };
        segs.push({ kind: "read", t0: t, t1: t + rc, text: "chunk " + ci });
        t += rc;
      }
      for (var si2 = 0; si2 < ch.steps.length; si2++) {
        var idx = ch.steps[si2];
        stepT0[idx] = t;
        segs.push({ kind: "step", t0: t, t1: t + 1, step: idx });
        t += 1;
        stepT1[idx] = t;
        var rj = recByStep[idx];
        if (rj !== undefined) { records[rj].t = t; place(records[rj]); }
      }
    }
    // model.close(): flush partly filled slots, then wait for every append
    var closeStart = t;
    var partial = [];
    st.forEach(function (x, si) {
      if (x.submitted[x.slot] < x.rows && x.rows < bp.batch) partial.push({ si: si, slot: x.slot, start: x.submitted[x.slot], stop: x.rows });
    });
    if (partial.length) {
      submit(partial, t, true);
      if (cfg.writers === 0) t = segs[segs.length - 1].t1;
    }
    var tEnd = t;
    tasks.forEach(function (tk) { if (tk.end > tEnd) tEnd = tk.end; });
    if (tEnd > closeStart) segs.push({ kind: "close", t0: closeStart, t1: tEnd, text: "close()" });
    segs.sort(function (a, b) { return a.t0 - b.t0; });

    // per-stream slot snapshots
    slotEvents.sort(function (a, b) { return a.t - b.t || (a.done ? -1 : 0) - (b.done ? -1 : 0); });
    var snaps = streamDefs.map(function () { return { t: [], fill: [], state: [], written: [], cur: [] }; });
    var cur = streamDefs.map(function () {
      var f = [], s2 = [];
      for (var j = 0; j < bp.depth; j++) { f.push(0); s2.push(0); }
      return { fill: f, state: s2, written: 0, slot: 0 };
    });
    slotEvents.forEach(function (e) {
      var c2 = cur[e.s];
      c2.fill[e.slot] = e.fill; c2.state[e.slot] = e.state; c2.written = e.written;
      if (e.state === 1) c2.slot = e.slot;
      var sn = snaps[e.s];
      sn.t.push(e.t); sn.fill.push(c2.fill.slice()); sn.state.push(c2.state.slice());
      sn.written.push(c2.written); sn.cur.push(c2.slot);
    });

    var stepsPerInner = innerRule === "step" ? 1 : 24 / H;
    var stepsPerChunk = L * R;
    return {
      cfg: cfg, H: H, I: I, R: R, upsampling: upsampling, notes: notes, endDate: endDate,
      mainCount: mainCount, spinCount: spinCount, chunks: chunks, numSpinChunks: numSpinChunks,
      steps: steps, numSpinSteps: numSpinSteps, nMax: nMax, stepT0: stepT0, stepT1: stepT1,
      segs: segs, segT0: segs.map(function (s3) { return s3.t0; }), reads: reads, records: records,
      recT: records.map(function (r) { return r.t; }), innerWins: innerWins, outerWins: outerWins,
      ops: ops, streams: streamDefs, batch: bp.batch, depth: bp.depth, tasks: tasks, snaps: snaps,
      tEnd: tEnd, closeStart: closeStart, droppedOuter: droppedOuter,
      stepsPerInner: stepsPerInner, stepsPerChunk: stepsPerChunk
    };
  }

  /* ------------------------------------------------------------ widget */
  var REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var uid = 0;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var VIEW_PRESETS = {
    "time-axis": ["daily", "era5", "upsample", "inproc"],
    statistics: ["annual", "monthly", "small", "inproc"]
  };
  var VIEWS = {
    "time-axis": { title: "One model step, N sub-steps", sub: "inside step_advance(), and where its runoff comes from", speed: 4 },
    statistics: { title: "Statistics windows on the GPU", sub: "only finished windows leave the device", speed: 32 }
  };
  var SPEEDS = [[0.25, "0.25 steps/s"], [1, "1 step/s"], [4, "4 steps/s"], [32, "32 steps/s"], [128, "128 steps/s"]];

  function f1(v) { return String(Math.round(v * 10) / 10); }
  function dayLabel(ms, hours) {
    var d = new Date(ms);
    if (hours && d.getUTCHours() !== 0) return pad2(d.getUTCHours()) + ":00";
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }
  function txt(x, y, cls, s, anchor) {
    return '<text class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(s) + "</text>";
  }
  function line(x1, y1, x2, y2, cls) {
    return '<line class="' + cls + '" x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) + '"/>';
  }
  function rect(x, y, w, h, cls, rx, extra) {
    return '<rect class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '" width="' + f1(Math.max(0, w)) + '" height="' + f1(Math.max(0, h)) + '"' + (rx ? ' rx="' + rx + '"' : "") + (extra || "") + "/>";
  }
  function wcls(w) { return w < 0 ? "tl-wm" : "tl-wc" + (w % 4); }
  // point at fraction u of the length of a polyline
  function along(pts, u) {
    var len = [0], total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
      len.push(total);
    }
    var d = clamp(u, 0, 1) * total;
    for (var j = 1; j < pts.length; j++) {
      if (d <= len[j] || j === pts.length - 1) {
        var f = len[j] > len[j - 1] ? (d - len[j - 1]) / (len[j] - len[j - 1]) : 1;
        return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f];
      }
    }
    return pts[pts.length - 1];
  }

  function Timeline(root) {
    this.root = root;
    this.view = root.getAttribute("data-view") === "statistics" ? "statistics" : "time-axis";
    var list = VIEW_PRESETS[this.view];
    var preset = root.getAttribute("data-preset");
    if (list.indexOf(preset) < 0) preset = list[0];
    this.cfg = Object.assign({}, DEFAULTS, PRESETS[preset].cfg);
    this.cfg.ops = this.cfg.ops.slice();
    this.preset = preset;
    this.t = 0;
    this.target = 0;
    this.playing = false;
    this.speed = VIEWS[this.view].speed;
    this.id = "cmf-tl-" + (++uid);
    this.build();
    this.markPreset(preset);
    this.rebuild(true);
  }

  Timeline.prototype.build = function () {
    var self = this, root = this.root, V = VIEWS[this.view];
    root.innerHTML = "";
    root.classList.add("cmf-tl-ready");
    root.setAttribute("data-search-exclude", "");

    var head = el("div", "cmf-tl-head");
    head.innerHTML = '<span class="cmf-tl-kicker">Interactive</span><span class="cmf-tl-title">' + esc(V.title) +
      '</span><span class="cmf-tl-subtitle">' + esc(V.sub) + "</span>";
    root.appendChild(head);

    // presets as pills
    var pres = el("div", "cmf-tl-presets");
    pres.setAttribute("role", "group");
    pres.setAttribute("aria-label", "Presets");
    this.presetBtns = {};
    VIEW_PRESETS[this.view].forEach(function (k) {
      var b = button("cmf-tl-pill", PRESETS[k].short, function () {
        self.preset = k;
        self.cfg = Object.assign({}, DEFAULTS, PRESETS[k].cfg);
        self.cfg.ops = self.cfg.ops.slice();
        self.syncInputs();
        self.markPreset(k);
        self.rebuild(true);
      });
      b.title = PRESETS[k].label;
      b.setAttribute("aria-pressed", "false");
      pres.appendChild(b);
      self.presetBtns[k] = b;
    });
    root.appendChild(pres);
    this.presetDesc = el("p", "cmf-tl-presetdesc");
    root.appendChild(this.presetDesc);

    // the full configuration, behind a disclosure
    var more = el("div", "cmf-tl-more");
    var sum = button("cmf-tl-summary", "", function () {
      var open = sum.getAttribute("aria-expanded") !== "true";
      sum.setAttribute("aria-expanded", open ? "true" : "false");
      form.hidden = !open;
      more.classList.toggle("cmf-tl-open", open);
    });
    sum.innerHTML = '<span class="cmf-tl-chev" aria-hidden="true"></span><span class="cmf-tl-sumlab">Configure</span><span class="cmf-tl-sumcfg"></span>';
    sum.setAttribute("aria-expanded", "false");
    sum.setAttribute("aria-controls", this.id + "-config");
    more.appendChild(sum);
    this.sumCfg = sum.querySelector(".cmf-tl-sumcfg");
    var form = el("form", "cmf-tl-config");
    form.id = this.id + "-config";
    form.hidden = true;
    form.setAttribute("aria-label", "Timeline configuration");
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    more.appendChild(form);

    this.inputs = {};
    VIEW_FIELDS[this.view].forEach(function (name) {
      if (name === "ops") {
        var fs = el("fieldset", "cmf-tl-field cmf-tl-ops");
        fs.innerHTML = "<legend>operations</legend>";
        var wrap = el("div", "cmf-tl-toggles");
        OPS.forEach(function (o) {
          var lab = el("label", "cmf-tl-toggle");
          var cb = document.createElement("input");
          cb.type = "checkbox"; cb.value = o.id; cb.className = "cmf-tl-sr";
          cb.setAttribute("data-op", o.id);
          cb.addEventListener("change", function () {
            var list = [];
            OPS.forEach(function (o2) { if (self.inputs["op_" + o2.id].checked) list.push(o2.id); });
            if (!list.length) { cb.checked = true; return; }
            self.cfg.ops = list; self.customized(); self.rebuild(false);
          });
          lab.appendChild(cb);
          var sp = el("span");
          sp.textContent = o.id;
          if (o.variable === "river_depth") sp.title = "last value of river_depth";
          lab.appendChild(sp);
          wrap.appendChild(lab);
          self.inputs["op_" + o.id] = cb;
        });
        fs.appendChild(wrap);
        form.appendChild(fs);
        return;
      }
      var f = FIELDS[name];
      if (f.select) {
        var lab = el("label", "cmf-tl-field cmf-tl-wide");
        lab.innerHTML = "<span class=\"cmf-tl-flab\">" + esc(f.label) + "</span>";
        var sel = document.createElement("select");
        sel.name = name;
        sel.className = "cmf-tl-select";
        f.opts.forEach(function (op) {
          var o = document.createElement("option"); o.value = String(op[0]); o.textContent = op[1]; sel.appendChild(o);
        });
        sel.addEventListener("change", function () { self.setField(name, sel.value); });
        lab.appendChild(sel);
        form.appendChild(lab);
        self.inputs[name] = { kind: "select", el: sel };
        return;
      }
      // segmented control: native radios (arrow keys, labels) styled as one pill
      var fs2 = el("fieldset", "cmf-tl-field" + (f.wide ? " cmf-tl-wide" : ""));
      var lg = document.createElement("legend");
      lg.className = "cmf-tl-flab";
      lg.textContent = f.label;
      fs2.appendChild(lg);
      var seg = el("div", "cmf-tl-seg");
      var radios = {};
      var group = self.id + "-" + name;
      f.opts.forEach(function (op) {
        var l = el("label", "cmf-tl-segopt");
        var r = document.createElement("input");
        r.type = "radio"; r.name = group; r.value = String(op[0]); r.className = "cmf-tl-sr";
        r.setAttribute("data-field", name);
        r.addEventListener("change", function () { if (r.checked) self.setField(name, r.value); });
        var t = el("span"); t.textContent = op[1];
        if (op[2]) l.title = op[2];
        l.appendChild(r); l.appendChild(t);
        seg.appendChild(l);
        radios[String(op[0])] = r;
      });
      fs2.appendChild(seg);
      form.appendChild(fs2);
      self.inputs[name] = { kind: "seg", radios: radios, el: fs2 };
    });
    root.appendChild(more);

    // the figure: drag across it to move through the run
    var stage = el("div", "cmf-tl-stage");
    this.stageSvg = document.createElementNS(SVGNS, "svg");
    this.stageSvg.setAttribute("class", "cmf-tl-svg");
    this.stageSvg.setAttribute("role", "img");
    this.stageSvg.setAttribute("aria-label", this.view === "statistics"
      ? "Inner-window means fill a hydrograph as the run advances; finished windows travel to their output files. The readout below describes the same state in words."
      : "The current model step, zoomed into its sub-steps, with the runoff chunks around it. The readout below describes the same state in words.");
    stage.appendChild(this.stageSvg);
    root.appendChild(stage);
    this.stage = stage;
    this.bindStage(stage);

    // transport
    var bar = el("div", "cmf-tl-transport");
    this.playBtn = button("cmf-tl-play", "", function () { self.toggle(); });
    this.setPlayLabel(false);
    var back = button("cmf-tl-icon", "", function () { self.jumpStep(-1); });
    back.innerHTML = ICONS.back; back.setAttribute("aria-label", "Previous model step"); back.title = "Previous model step (←)";
    var fwd = button("cmf-tl-icon", "", function () { self.jumpStep(1); });
    fwd.innerHTML = ICONS.fwd; fwd.setAttribute("aria-label", "Next model step"); fwd.title = "Next model step (→)";
    var restart = button("cmf-tl-icon", "", function () { self.pause(); self.seek(0); });
    restart.innerHTML = ICONS.restart; restart.setAttribute("aria-label", "Back to the start"); restart.title = "Back to the start (Home)";
    var spd = document.createElement("select");
    spd.className = "cmf-tl-select cmf-tl-mini";
    spd.setAttribute("aria-label", "Playback speed in model steps per second");
    SPEEDS.forEach(function (o) {
      var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1]; spd.appendChild(opt);
    });
    spd.value = String(this.speed);
    spd.addEventListener("change", function () { self.speed = +spd.value; self.requestRender(); });
    var grow = el("span", "cmf-tl-grow");
    [this.playBtn, back, fwd, restart, grow, spd].forEach(function (b) { bar.appendChild(b); });
    root.appendChild(bar);

    // scrubber: the whole run as a small hydrograph
    var scrub = el("div", "cmf-tl-scrub");
    scrub.setAttribute("role", "slider");
    scrub.setAttribute("tabindex", "0");
    scrub.setAttribute("aria-label", "Run timeline: drag or use the arrow keys");
    this.scrubSvg = document.createElementNS(SVGNS, "svg");
    this.scrubSvg.setAttribute("class", "cmf-tl-svg");
    this.scrubSvg.setAttribute("aria-hidden", "true");
    scrub.appendChild(this.scrubSvg);
    root.appendChild(scrub);
    this.scrub = scrub;
    this.bindScrub(scrub);

    this.readout = el("p", "cmf-tl-readout");
    this.readout.setAttribute("aria-live", "polite");
    root.appendChild(this.readout);

    this.ruleBox = el("div", "cmf-tl-rules");
    this.ruleBox.setAttribute("aria-live", "polite");
    root.appendChild(this.ruleBox);

    this.foot = el("p", "cmf-tl-foot");
    root.appendChild(this.foot);

    this.syncInputs();
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(function () {
        var w = self.stage.clientWidth;
        if (w && w !== self.lastW) { self.layout(); self.requestRender(); }
      });
      this.ro.observe(root);
    }
  };

  var ICONS = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4c0 .6.6.9 1.1.6l8-5.2c.5-.3.5-1 0-1.3l-8-5.1c-.5-.3-1.1 0-1.1.6z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>',
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3.5 2.5v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  Timeline.prototype.setPlayLabel = function (playing) {
    this.playBtn.innerHTML = (playing ? ICONS.pause : ICONS.play) + "<span>" + (playing ? "Pause" : "Play") + "</span>";
    this.playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
  };

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function button(cls, text, fn) {
    var b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text;
    b.addEventListener("click", fn); return b;
  }

  Timeline.prototype.setField = function (name, raw) {
    var f = FIELDS[name];
    this.cfg[name] = f.num ? +raw : raw;
    this.customized();
    this.rebuild(name === "period" || name === "spin" || name === "step" || name === "interval");
  };

  Timeline.prototype.markPreset = function (k) {
    var self = this;
    Object.keys(this.presetBtns).forEach(function (key) {
      self.presetBtns[key].setAttribute("aria-pressed", key === k ? "true" : "false");
    });
    this.presetDesc.textContent = k && PRESETS[k] ? PRESETS[k].label : "Custom configuration";
  };

  Timeline.prototype.customized = function () {
    // keep the preset pills honest once the reader edits a field
    var match = null, cfg = this.cfg;
    VIEW_PRESETS[this.view].forEach(function (k) {
      var p = Object.assign({}, DEFAULTS, PRESETS[k].cfg);
      var same = VIEW_FIELDS[this.view].every(function (f) {
        return f === "ops" ? p.ops.join() === cfg.ops.join() : p[f] === cfg[f];
      });
      if (same && !match) match = k;
    }, this);
    this.preset = match;
    this.markPreset(match);
  };

  Timeline.prototype.setInput = function (name, value) {
    var inp = this.inputs[name];
    if (!inp) return;
    if (inp.kind === "select") { inp.el.value = String(value); return; }
    Object.keys(inp.radios).forEach(function (v) { inp.radios[v].checked = v === String(value); });
  };

  Timeline.prototype.syncInputs = function () {
    var self = this, cfg = this.cfg;
    Object.keys(this.inputs).forEach(function (k) {
      if (k.indexOf("op_") === 0) { self.inputs[k].checked = cfg.ops.indexOf(k.slice(3)) >= 0; return; }
      self.setInput(k, cfg[k]);
    });
  };

  Timeline.prototype.rebuild = function (resetTime) {
    var frac = this.model ? this.t / this.model.tEnd : 0;
    var cfg = this.cfg;
    // the statistics view has no runoff input field: records arrive once per model step
    if (this.view === "statistics") cfg.interval = cfg.step;
    this.model = buildModel(cfg);
    var m = this.model;
    // reflect the rules in the inputs
    var up = this.inputs.upsampling;
    if (up) {
      // reuse_count = 1 -> only None is valid; otherwise None is invalid
      Object.keys(up.radios).forEach(function (v) {
        up.radios[v].disabled = m.R === 1 ? v !== "none" : v === "none";
      });
      this.setInput("upsampling", m.R === 1 ? "none" : cfg.upsampling);
    }
    if (this.inputs.interval) this.setInput("interval", m.I);
    if (this.inputs.prefetch) {
      var pf = this.inputs.prefetch;
      Object.keys(pf.radios).forEach(function (v) { pf.radios[v].disabled = cfg.loaders === 0; });
    }
    this.sumCfg.textContent = this.summary();
    this.t = this.target = resetTime ? 0 : clamp(frac * m.tEnd, 0, m.tEnd);
    this.cache = null;
    this.renderRules();
    this.layout();
    this.requestRender();
  };

  Timeline.prototype.summary = function () {
    var c = this.cfg, m = this.model;
    var parts = ["model_step " + hoursLabel(m.H)];
    if (this.view === "time-axis") {
      parts.push("time_interval " + hoursLabel(m.I));
      parts.push((c.sub === "adaptive" ? "adaptive" : "fixed") + " sub-steps");
      parts.push(c.loaders + " loader" + (c.loaders === 1 ? "" : "s") + (c.loaders ? " × " + c.prefetch : ""));
    } else {
      parts.push(c.inner === "step" ? "every step" : "daily" + (c.outer === "none" ? "" : " / " + c.outer + "ly"));
      parts.push(c.ops.join(", "));
      parts.push(c.writers + " writer" + (c.writers === 1 ? "" : "s"));
    }
    if (c.spin) parts.push(c.spin + " spin-up");
    return parts.join(" · ");
  };

  Timeline.prototype.renderRules = function () {
    var m = this.model, cfg = this.cfg, parts = [];
    m.notes.forEach(function (n) { parts.push('<p class="cmf-tl-err">' + esc(n.text) + "</p>"); });
    var rule;
    if (m.R === 1) {
      rule = "model_step = time_interval: reuse_count = 1, upsampling must be <code>None</code>; one <code>set_inputs()</code> and one <code>step_advance()</code> per runoff record.";
    } else {
      rule = "reuse_count = time_interval ÷ model_step = " + m.R + ": upsampling must be <code>\"repeat\"</code> or <code>\"distribute\"</code>; the script calls <code>set_inputs()</code> once per record and <code>step_advance()</code> " + m.R + " times" +
        (m.upsampling === "distribute" ? "; <code>\"distribute\"</code> divides each record by " + m.R + " when it is read." : "; <code>\"repeat\"</code> reuses the record unchanged.");
    }
    if (this.view === "time-axis") {
      parts.push("<p>" + rule + "</p>");
      var spin = cfg.spin ? cfg.spin + " spin-up cycle" + (cfg.spin > 1 ? "s" : "") + " × " + (m.numSpinSteps / cfg.spin) + " steps (replaying 2000-01-01 to 01-10) + " : "";
      parts.push("<p>Schedule: " + spin + (m.steps.length - m.numSpinSteps) + " main steps; end_date = " + fmtDate(m.endDate, m.I < 24) + " (last record), so the run ends at " + fmtDate(m.endDate + m.I * HOUR, m.I < 24) + ". " +
        m.chunks.length + " chunks of up to " + cfg.chunk + " record" + (cfg.chunk > 1 ? "s" : "") + " (each phase is chunked separately). " +
        (cfg.loaders > 0
          ? "DataLoader keeps up to loader_workers × prefetch_factor = " + cfg.loaders * cfg.prefetch + " chunks requested; chunk i goes to worker i mod " + cfg.loaders + "."
          : "loader_workers = 0: the model process reads each chunk itself, and the GPU waits.") + "</p>");
    } else {
      var outerTxt = cfg.outer === "none" ? "outer = inner" : "outer = " + cfg.outer;
      parts.push("<p>Windows: inner = " + (cfg.inner === "step" ? "every model step" : "day") + ", " + outerTxt + "; " + (m.steps.length - m.numSpinSteps) + " main steps of " + hoursLabel(m.H) + ", " + m.records.length + " publications. " +
        (m.droppedOuter !== null ? "partial_period=\"drop\": the incomplete last outer window (and its inner windows) is not written. " : "") +
        "Each file gets " + m.depth + " slot" + (m.depth > 1 ? "s" : "") + " of " + m.batch + " row" + (m.batch > 1 ? "s" : "") + " (batch = min(30, " + (cfg.writers ? "max_pending_steps ÷ 2" : "max_pending_steps") + "), depth = " + (cfg.writers ? "max_pending_steps ÷ batch" : "1 without writers") + "). " +
        (cfg.writers > 0 ? "Files are spread over " + cfg.writers + " writer process" + (cfg.writers > 1 ? "es" : "") + " per rank; a file always goes to the same writer." : "output_workers = 0: the model process appends each full batch itself and waits.") + "</p>");
    }
    this.ruleBox.innerHTML = parts.join("");
    this.foot.innerHTML = this.view === "statistics"
      ? "Drag across the chart or the bar below it. Discharge values and durations are illustrative (one model step = one time unit). Timing shown for synchronous copies; on CUDA the copy into the slot overlaps compute and a full batch is handed over when the next result arrives."
      : "Drag across the figure or the bar below it. Discharge, runoff and durations are illustrative (one model step = one time unit, a chunk read ≈ 0.3 + 0.3 × records). Adaptive N follows dt = 0.7·Δx/√(g·h) for an illustrative deepest river.";
  };

  /* ---------- scrubbing */
  Timeline.prototype.bindScrub = function (scrub) {
    var self = this, dragging = false;
    function tAt(ev) {
      var r = scrub.getBoundingClientRect(), g = self.ov || { x0: 8, x1: r.width - 8 };
      return clamp((ev.clientX - r.left - g.x0) / Math.max(1, g.x1 - g.x0), 0, 1) * self.model.tEnd;
    }
    scrub.addEventListener("pointerdown", function (ev) {
      dragging = true; scrub.setPointerCapture(ev.pointerId); self.pause(); self.seek(tAt(ev)); scrub.focus({ preventScroll: true });
    });
    scrub.addEventListener("pointermove", function (ev) { if (dragging) self.seek(tAt(ev)); });
    function end() { dragging = false; }
    scrub.addEventListener("pointerup", end);
    scrub.addEventListener("pointercancel", end);
    scrub.addEventListener("keydown", function (ev) {
      var k = ev.key, handled = true;
      if (k === "ArrowRight" || k === "ArrowUp") self.jumpStep(ev.shiftKey ? 10 : 1);
      else if (k === "ArrowLeft" || k === "ArrowDown") self.jumpStep(ev.shiftKey ? -10 : -1);
      else if (k === "PageUp") self.jumpRecord(1);
      else if (k === "PageDown") self.jumpRecord(-1);
      else if (k === "Home") { self.pause(); self.seek(0); }
      else if (k === "End") { self.pause(); self.seek(self.model.tEnd); }
      else if (k === " " || k === "Enter") self.toggle();
      else handled = false;
      if (handled) ev.preventDefault();
    });
  };

  // Drag on the figure itself. Statistics: the chart maps x to a point of the main
  // period. Time axis: the strip moves like a film (drag left = later), the zoomed
  // panel moves its playhead (drag right = later, one panel width = one model step).
  Timeline.prototype.bindStage = function (stage) {
    var self = this, drag = null;
    function pos(ev) {
      var r = self.stageSvg.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }
    stage.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || !self.G) return;
      var p = pos(ev), G = self.G, mode = null;
      if (self.view === "statistics") {
        if (p[0] >= G.px0 - 8 && p[0] <= G.px1 + 8 && p[1] >= G.chTop - 16 && p[1] <= G.base + 22) mode = "chart";
      } else if (p[1] <= G.stripBottom) mode = "strip";
      else if (p[1] >= G.ptop && p[1] <= G.pbot + 24) mode = "panel";
      if (!mode) return;
      self.pause();
      drag = { mode: mode, x: p[0], p: self.stepPos() };
      stage.setPointerCapture(ev.pointerId);
      stage.classList.add("cmf-tl-dragging");
      if (mode === "chart") self.seek(self.chartT(p[0]));
    });
    stage.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var x = pos(ev)[0], G = self.G;
      if (drag.mode === "chart") self.seek(self.chartT(x));
      else if (drag.mode === "strip") self.seek(self.posT(drag.p - (x - drag.x) / G.stepW));
      else self.seek(self.posT(drag.p + (x - drag.x) / Math.max(1, G.ix1 - G.ix0)));
    });
    function end() { drag = null; stage.classList.remove("cmf-tl-dragging"); }
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  };

  // position in model steps (step index + fraction done) at the target time
  Timeline.prototype.stepPos = function () {
    var m = this.model, g = this.goal(), i = bisect(m.stepT0, g);
    if (i < 0) return 0;
    return i + clamp(g - m.stepT0[i], 0, 1);
  };
  Timeline.prototype.posT = function (p) {
    var m = this.model, n = m.steps.length;
    p = clamp(p, 0, n);
    var i = Math.floor(p);
    if (i >= n) return m.stepT1[n - 1];
    return m.stepT0[i] + (p - i);
  };
  Timeline.prototype.chartT = function (x) {
    var m = this.model, G = this.G, nMain = m.steps.length - m.numSpinSteps;
    var k = clamp((x - G.px0) / Math.max(1, G.px1 - G.px0), 0, 1) * nMain;
    return this.posT(m.numSpinSteps + k);
  };

  // Move to t. Scrubbing eases the shown time toward the target (critically damped,
  // one requestAnimationFrame loop); playback and reduced motion jump directly.
  Timeline.prototype.seek = function (t, immediate) {
    this.target = clamp(t, 0, this.model.tEnd);
    if (immediate || REDUCED || this.playing) {
      this.t = this.target;
      this.requestRender();
      return;
    }
    this.ease();
  };

  Timeline.prototype.ease = function () {
    var self = this;
    if (this.easing) return;
    this.easing = true;
    var last = null;
    function frame(ts) {
      if (!self.root.isConnected) { self.easing = false; return; }
      var dt = last === null ? 1 / 60 : Math.min(0.05, (ts - last) / 1000);
      last = ts;
      var diff = self.target - self.t;
      if (Math.abs(diff) <= Math.max(1e-4, self.model.tEnd * 1e-5)) {
        self.t = self.target; self.easing = false; self.render(); return;
      }
      self.t += diff * (1 - Math.exp(-dt * 14));
      self.render();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  Timeline.prototype.goal = function () {
    return this.easing ? this.target : this.t;
  };

  Timeline.prototype.currentStep = function () {
    // index of the last step started at or before the target time (or -1)
    return bisect(this.model.stepT0, this.goal());
  };

  Timeline.prototype.jumpStep = function (d) {
    this.pause();
    var m = this.model, i = this.currentStep();
    var target;
    if (d > 0) {
      var j = i + d;
      if (i >= 0 && this.goal() < m.stepT0[i] + 1e-9 && d === 1) j = i + 1;
      target = j >= m.steps.length ? m.tEnd : m.stepT0[Math.max(0, j)];
    } else {
      var j2 = i + d;
      if (i >= 0 && this.goal() > m.stepT0[i] + 1e-9) j2 = i + d + 1;
      target = j2 < 0 ? 0 : m.stepT0[j2];
    }
    this.seek(target);
  };

  Timeline.prototype.jumpRecord = function (d) {
    this.pause();
    var m = this.model;
    if (!m.records.length) return;
    var i = bisect(m.recT, this.goal() - 1e-9);
    var j = d > 0 ? i + 1 : i - (i >= 0 && m.recT[i] >= this.goal() - 1e-9 ? 1 : 0);
    if (d < 0 && i >= 0 && m.recT[i] < this.goal() - 1e-9) j = i;
    j = clamp(j, 0, m.records.length - 1);
    this.seek(m.recT[j]);
  };

  Timeline.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };
  Timeline.prototype.play = function () {
    var self = this;
    if (this.easing) { this.t = this.target; }
    if (this.t >= this.model.tEnd - 1e-9) this.t = 0;
    this.target = this.t;
    this.playing = true;
    this.setPlayLabel(true);
    this.readout.setAttribute("aria-live", "off");
    var last = null;
    if (REDUCED) {
      this.timer = setInterval(function () {
        if (!self.root.isConnected) { self.pause(); return; }
        var n = Math.max(1, Math.round(self.speed * 0.6));
        var i = self.currentStep();
        var j = i + n;
        if (j >= self.model.steps.length) { self.seek(self.model.tEnd); self.pause(); return; }
        self.seek(self.model.stepT0[j]);
      }, 600);
      return;
    }
    function frame(ts) {
      if (!self.playing) return;
      if (!self.root.isConnected) { self.pause(); return; }
      if (last !== null) {
        var dt = Math.min(0.1, (ts - last) / 1000);
        self.t = self.target = Math.min(self.model.tEnd, self.t + dt * self.speed);
        self.render();
        if (self.t >= self.model.tEnd) { self.pause(); return; }
      }
      last = ts;
      self.raf = requestAnimationFrame(frame);
    }
    this.raf = requestAnimationFrame(frame);
  };
  Timeline.prototype.pause = function () {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.raf = this.timer = null;
    if (this.playBtn) {
      this.setPlayLabel(false);
      this.readout.setAttribute("aria-live", "polite");
    }
    this.requestRender();
  };

  Timeline.prototype.requestRender = function () {
    var self = this;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(function () { self.pending = false; if (self.root.isConnected) self.render(); });
  };

  // how long (in time units) a published record takes to reach its file: about a
  // third of a second of playback, whatever the speed
  Timeline.prototype.travel = function () { return clamp(this.speed * 0.35, 0.6, 12); };

  /* ---------- layout */
  Timeline.prototype.layout = function () {
    if (!this.model) return;
    var W = Math.max(280, Math.floor(this.stage.clientWidth || this.root.clientWidth || 640));
    this.lastW = this.stage.clientWidth;
    var s = this.view === "statistics" ? this.layoutStats(W) : this.layoutAxis(W);
    var svg = this.stageSvg;
    svg.setAttribute("viewBox", "0 0 " + W + " " + this.G.H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", this.G.H);
    svg.innerHTML = s + '<g data-r="dyn"></g>';
    this.dyn = svg.querySelector('[data-r="dyn"]');
    this.revealRect = svg.querySelector('[data-r="reveal"]');
    this.insClip = svg.querySelector('[data-r="insclip"]');
    if (this.view !== "time-axis") this.ins = null;
    this.layoutScrub();
  };

  function hatchDef(id) {
    return '<pattern id="' + id + '" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="tl-hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="tl-hatch"/></pattern>';
  }

  /* ---------- overview: the whole run as a small hydrograph */
  Timeline.prototype.layoutScrub = function () {
    var m = this.model, id = this.id;
    var W = Math.max(280, this.scrub.clientWidth || 640), H = 64;
    var x0 = 8, x1 = W - 8, top = 14, base = 44;
    var X = function (t) { return x0 + (x1 - x0) * t / m.tEnd; };
    // one column per pixel: the largest step value in it (0 = no step: the model waits)
    var nc = Math.ceil(x1 - x0) + 1, cv = new Float64Array(nc), cs = new Int8Array(nc), vmax = 1;
    for (var i = 0; i < m.steps.length; i++) {
      var s = m.steps[i], v = SIGNAL.q((s.start + s.end) / 2 / DAY - T0 / DAY);
      if (v > vmax) vmax = v;
      var a = Math.max(0, Math.floor(X(m.stepT0[i]) - x0)), b = Math.min(nc - 1, Math.max(a, Math.ceil(X(m.stepT1[i]) - x0) - 1));
      for (var c = a; c <= b; c++) { if (v > cv[c]) cv[c] = v; cs[c] = s.phase === "spinup" ? 1 : 2; }
    }
    function area(kind) {
      var d = "", open = false;
      for (var c2 = 0; c2 < nc; c2++) {
        var on = cs[c2] === kind, x = x0 + c2;
        if (on) {
          var y = f1(base - (base - top) * cv[c2] / vmax);
          d += (open ? "V" + y : "M" + x + " " + base + "V" + y) + "H" + (x + 1);
          open = true;
        } else if (open) { d += "V" + base + "Z"; open = false; }
      }
      return open ? d + "V" + base + "Z" : d;
    }
    var main = area(2), spin = area(1), s2 = [];
    s2.push("<defs><clipPath id=\"" + id + "-ov\"><rect data-r=\"ovclip\" x=\"" + x0 + "\" y=\"0\" width=\"0\" height=\"" + H + "\"/></clipPath>" + hatchDef(id + "-ovh") + "</defs>");
    s2.push('<path class="tl-ov-ghost" d="' + main + '"/>');
    if (spin) s2.push('<path fill="url(#' + id + '-ovh)" class="tl-ov-spin" d="' + spin + '"/>');
    s2.push('<g clip-path="url(#' + id + '-ov)"><path class="tl-ov-area" d="' + main + '"/>' + (spin ? '<path class="tl-ov-spin-done" d="' + spin + '"/>' : "") + "</g>");
    s2.push(line(x0, base + 0.5, x1, base + 0.5, "tl-ov-base"));
    m.segs.forEach(function (g) {
      if (g.kind === "step" || g.kind === "close") return;
      s2.push(rect(X(g.t0), base + 2, Math.max(1, X(g.t1) - X(g.t0)), 3, "tl-ov-stall"));
    });
    // phase labels above
    var labels = [];
    if (m.numSpinSteps) {
      var per = m.numSpinSteps / this.cfg.spin;
      for (var cy = 0; cy < this.cfg.spin; cy++) labels.push([X(m.stepT0[cy * per]), "spin-up " + (cy + 1)]);
    }
    labels.push([X(m.stepT0[m.numSpinSteps]), "main period"]);
    var lastEnd = -99;
    labels.forEach(function (l) {
      var x = Math.max(x0, l[0] + 1);
      if (x < lastEnd + 8 || x > x1 - 50) return;
      s2.push(txt(x, 9, "tl-xs tl-muted", l[1]));
      lastEnd = x + l[1].length * 5.4;
    });
    // month labels below
    var lastMonth = null, lastX = -99;
    for (var k = m.numSpinSteps; k < m.steps.length; k++) {
      var d = new Date(m.steps[k].start), key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (key === lastMonth) continue;
      lastMonth = key;
      var x = X(m.stepT0[k]);
      s2.push(line(x, base + 1, x, base + 5, "tl-tick"));
      if (x - lastX > 44 && x < x1 - 24) {
        s2.push(txt(Math.max(x0, x), base + 16, "tl-xs tl-muted", d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()]));
        lastX = x;
      }
    }
    s2.push('<g data-r="ovhead">' + line(0, top - 6, 0, base, "tl-ov-now") + '<circle class="tl-ov-knob" cx="0" cy="' + base + '" r="6"/></g>');
    var svg = this.scrubSvg;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.innerHTML = s2.join("");
    this.ov = { x0: x0, x1: x1, X: X };
    this.ovClip = svg.querySelector('[data-r="ovclip"]');
    this.ovHead = svg.querySelector('[data-r="ovhead"]');
  };

  /* ---------- statistics view: the flood-peak card */
  Timeline.prototype.layoutStats = function (W) {
    var m = this.model, cfg = this.cfg, id = this.id, out = [];
    var wide = W >= 620;
    var colW = wide ? Math.min(236, Math.round(W * 0.32)) : W;
    var gap = wide ? 22 : 0;
    var cw = wide ? W - colW - gap : W;
    var pad = wide ? 20 : 12;
    var chTop = 90, chH = wide ? 176 : 132;
    var base = chTop + chH, cardH = base + 48;
    var px0 = pad, px1 = cw - pad;
    var nSpin = m.numSpinSteps, nMain = m.steps.length - nSpin;
    var SX = function (k) { return px0 + (px1 - px0) * k / Math.max(1, nMain); };
    var vmax = 1;
    m.innerWins.forEach(function (w) { if (w.mean > vmax) vmax = w.mean; });
    var vtop = vmax * 1.24;
    var Y = function (v) { return base - chH * clamp(v / vtop, 0, 1); };
    var nw = m.innerWins.length;
    var winX0 = [], winX1 = [], winT1 = [], winOuter = [];
    m.innerWins.forEach(function (w) {
      winX0.push(SX(w.first - nSpin)); winX1.push(SX(w.last + 1 - nSpin));
      winT1.push(m.stepT1[w.last]); winOuter.push(m.steps[w.first].outer);
    });
    // bars: separate when wide enough, otherwise one stepped area
    var d = "", barGap = nw && (winX1[0] - winX0[0]) >= 5;
    if (barGap) {
      m.innerWins.forEach(function (w, j) {
        d += "M" + f1(winX0[j] + 0.5) + " " + base + "V" + f1(Y(w.mean)) + "H" + f1(winX1[j] - 0.5) + "V" + base + "Z";
      });
    } else if (nw) {
      d = "M" + f1(winX0[0]) + " " + base;
      m.innerWins.forEach(function (w, j) { d += "V" + f1(Y(w.mean)) + "H" + f1(winX1[j]); });
      d += "V" + base + "Z";
    }
    // max_mean: running best inner window per outer window (strict >, as windows.py folds)
    var showMax = cfg.ops.indexOf("max_mean") >= 0 && cfg.outer !== "none";
    var best = [], outerFirstWin = {}, outerLastWin = {};
    for (var j = 0; j < nw; j++) {
      var o = winOuter[j];
      if (outerFirstWin[o] === undefined) outerFirstWin[o] = j;
      outerLastWin[o] = j;
      best.push(j > 0 && winOuter[j - 1] === o && m.innerWins[best[j - 1]].mean >= m.innerWins[j].mean ? best[j - 1] : j);
    }
    var hrs = m.H < 24;
    var innerAdj = cfg.inner === "step" ? (hrs ? hoursLabel(m.H) : "daily") : "daily";
    var outerAdj = { month: "monthly", year: "annual" }[cfg.outer] || "";

    out.push("<defs><clipPath id=\"" + id + "-rev\"><rect data-r=\"reveal\" x=\"" + px0 + "\" y=\"" + (chTop - 14) + "\" width=\"0\" height=\"" + (chH + 14) + "\"/></clipPath>" + hatchDef(id + "-h") + "</defs>");
    out.push(rect(0.75, 0.75, cw - 1.5, cardH - 1.5, "tl-card", 14));
    out.push(txt(pad, 27, "tl-gpu", "GPU") + txt(pad + 32, 27, "tl-muted", wide ? "statistics accumulate in device memory" : "statistics in device memory"));
    out.push(txt(pad, 55, "tl-ital tl-title", innerAdj + " mean outflow at a river mouth"));
    out.push(txt(pad, 72, "tl-xs tl-muted", "illustrative values · one bar = one inner window"));
    // outer window separators
    if (cfg.outer !== "none" && m.outerWins.length > 1 && m.outerWins.length <= 30) {
      m.outerWins.forEach(function (ow, k) {
        if (!k) return;
        var x = SX(ow.first - nSpin);
        out.push(line(x, chTop - 6, x, base, "tl-outer-sep"));
      });
    }
    out.push('<path class="tl-ghost" d="' + d + '"/>');
    out.push('<g clip-path="url(#' + id + '-rev)"><path class="tl-area" d="' + d + '"/></g>');
    // dropped steps (partial_period="drop")
    var firstDrop = -1;
    for (var q = nSpin; q < m.steps.length; q++) if (m.steps[q].dropped) { firstDrop = q - nSpin; break; }
    if (firstDrop >= 0) {
      out.push('<rect fill="url(#' + id + '-h)" x="' + f1(SX(firstDrop)) + '" y="' + (base - chH * 0.5) + '" width="' + f1(px1 - SX(firstDrop)) + '" height="' + f1(chH * 0.5) + '" class="tl-drop"/>');
      if (px1 - SX(firstDrop) > 60) out.push(txt(SX(firstDrop) + 4, base - chH * 0.5 - 5, "tl-xs tl-muted", "dropped"));
    }
    out.push(line(px0, base + 0.5, px1, base + 0.5, "tl-axis"));
    // time ticks: days for short runs, months otherwise
    var days = nMain * m.H / 24, lastLab = -99, lastKey = null;
    for (var k = 0; k < nMain; k++) {
      var st = m.steps[nSpin + k], dt = new Date(st.start);
      var key = days <= 16 ? Math.floor(st.start / DAY) : dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      if (key === lastKey) continue;
      lastKey = key;
      var x = SX(k);
      out.push(line(x, base + 1, x, base + 5, "tl-tick"));
      var lab = days <= 16 ? dayLabel(st.start) : dt.getUTCMonth() === 0 && k > 0 ? String(dt.getUTCFullYear()) : MONTHS[dt.getUTCMonth()];
      var monthW = days <= 16 ? (px1 - px0) / days : (px1 - px0) * 30 / days;
      if (days > 16 && monthW < 30 && !(dt.getUTCMonth() === 0 && k > 0)) lab = lab.charAt(0);
      var cx = days <= 16 ? x + monthW / 2 : x + Math.min(monthW, px1 - x) / 2;
      if (cx - lastLab < lab.length * 6 + 6 || cx > px1 - 4) continue;
      out.push(txt(cx, base + 17, "tl-xs tl-muted", lab, "middle"));
      lastLab = cx;
    }
    var y0 = new Date(m.steps[nSpin].start).getUTCFullYear(), y1 = new Date(m.steps[m.steps.length - 1].start).getUTCFullYear();
    out.push(txt(pad, cardH - 13, "tl-xs", (y0 === y1 ? y0 : y0 + "–" + y1) + " · " + nw + " " + innerAdj + " window" + (nw === 1 ? "" : "s") +
      (cfg.outer !== "none" ? " · " + m.outerWins.length + " " + outerAdj + (wide ? " window" + (m.outerWins.length === 1 ? "" : "s") : "") : "")));

    // files: rank 0 (other ranks write the same rows for their own catchments)
    var ns = m.streams.length, files = [], fx, fy;
    var cellW = m.depth <= 3 ? 16 : 10, cellH = 24, stripW = m.depth * (cellW + 3) - 3;
    if (wide) {
      fx = cw + gap; fy = 30;
      out.push(txt(fx, 16, "tl-xs tl-muted", "output files · rank 0"));
    } else {
      fx = 0; fy = cardH + 34;
      out.push(txt(fx, cardH + 22, "tl-xs tl-muted", "output files · rank 0"));
    }
    var rowH = wide ? 88 : 54;
    var totals = m.streams.map(function (sd) {
      return m.records.filter(function (r) { return r.streams.indexOf(sd.op) >= 0; }).length;
    });
    m.streams.forEach(function (sd, si) {
      var y = fy + si * rowH, ix = fx + Math.max(stripW, 40) + 16;
      files.push({
        sx: fx, sy: y + 7, ix: ix, iy: y, tx: wide ? fx : ix + 42, ty: wide ? y + 54 : y + 11,
        entry: wide ? [fx - 3, y + 7 + cellH / 2] : [fx + stripW / 2, y + 3]
      });
    });
    var wy = fy + ns * rowH + (wide ? 4 : 0);
    var nLines = Math.max(1, cfg.writers) + (cfg.ranks > 1 ? 1 : 0);
    var H = Math.max(cardH, wy + nLines * 16 + 14);
    this.G = {
      wide: wide, W: W, H: H, cw: cw, cardH: cardH, pad: pad, chTop: chTop, chH: chH, base: base,
      px0: px0, px1: px1, SX: SX, Y: Y, winX0: winX0, winX1: winX1, winT1: winT1, winOuter: winOuter,
      best: best, outerFirstWin: outerFirstWin, outerLastWin: outerLastWin, showMax: showMax,
      outerAdj: outerAdj, innerAdj: innerAdj, files: files, cellW: cellW, cellH: cellH, totals: totals,
      wy: wy, fx: fx
    };
    return out.join("");
  };

  Timeline.prototype.drawStats = function (S) {
    var m = this.model, G = this.G, cfg = this.cfg, t = this.t, out = [], eps = 1e-9;
    var nSpin = m.numSpinSteps;
    var jPub = bisect(G.winT1, t + eps); // last published inner window
    if (this.revealRect) this.revealRect.setAttribute("width", f1(Math.max(0, (jPub >= 0 ? G.winX1[jPub] : G.px0) - G.px0)));
    var s = S.step;
    var midY = G.chTop + G.chH * 0.45;
    if (!s) {
      out.push(txt((G.px0 + G.px1) / 2, midY, "tl-ital tl-hint", "Press Play, or drag across the chart", "middle"));
    } else if (s.phase === "spinup") {
      out.push(txt((G.px0 + G.px1) / 2, midY, "tl-ital tl-hint", "spin-up cycle " + (s.cycle + 1) + " of " + cfg.spin + ": no statistics yet", "middle"));
      out.push(line(G.px0, G.chTop - 4, G.px0, G.base, "tl-front"));
    } else if (!s.dropped && s.inner !== undefined && s.inner > jPub) {
      // the open window: its mean so far, from every sub-step sample (weight dt)
      var w = m.innerWins[s.inner], sum = 0, wsum = 0;
      for (var k = w.first; k <= S.i; k++) {
        var st = m.steps[k], nn = k === S.i ? S.sub : st.n;
        var dtd = (m.H / 24) / st.n, tau0 = (st.start - T0) / DAY;
        for (var q = 1; q <= nn; q++) { sum += SIGNAL.q(tau0 + q * dtd) * dtd; wsum += dtd; }
      }
      var fx = G.SX(S.i - nSpin + (S.running ? S.frac : 1));
      if (wsum > 0) {
        var y = G.Y(sum / wsum), xa = G.winX0[s.inner], xb = G.winX1[s.inner];
        out.push(rect(xa + 0.5, y, Math.max(1.5, xb - xa - 1), G.base - y, "tl-open"));
        out.push(line(fx, y - 3, fx, G.chTop - 6, "tl-front"));
      } else out.push(line(fx, G.base, fx, G.chTop - 6, "tl-front"));
    } else if (s.dropped) {
      var dx = G.SX(S.i - nSpin + (S.running ? S.frac : 1));
      out.push(line(dx, G.base, dx, G.chTop - 6, "tl-front tl-front-off"));
    }

    // max_mean markers, one per outer window that has a published inner window
    var focus = null;
    if (G.showMax && jPub >= 0) {
      var outers = Object.keys(G.outerFirstWin).map(Number).sort(function (a, b) { return a - b; });
      outers.forEach(function (o) {
        var lw = Math.min(jPub, G.outerLastWin[o]);
        if (lw < G.outerFirstWin[o]) return;
        var b = G.best[lw], bw = m.innerWins[b];
        var x = (G.winX0[b] + G.winX1[b]) / 2, yy = G.Y(bw.mean);
        var closed = m.outerWins[o].closed && G.winT1[G.outerLastWin[o]] <= t + eps;
        focus = { o: o, x: x, y: yy, closed: closed, w: bw };
        out.push('<g class="tl-maxg' + (o === G.winOuter[jPub] ? "" : " tl-max-old") + '">' + line(x, G.base, x, yy, "tl-max-line") +
          '<circle class="tl-max-dot" cx="' + f1(x) + '" cy="' + f1(yy) + '" r="4.2"/></g>');
      });
    }
    if (focus && (!s || s.phase !== "spinup")) {
      var l1 = focus.closed ? "max_mean" : "max_mean so far";
      var l2 = G.outerAdj + " max of " + G.innerAdj + " means";
      var lw = Math.max(l1.length * 6.1, l2.length * 6.4), ly = Math.max(G.chTop + 8, focus.y - 18);
      var right = focus.x + 30 + lw < G.px1, left = focus.x - 30 - lw > G.px0, lx, lead;
      if (right) { lx = focus.x + 30; lead = lx - 4; }
      else if (left) { lx = focus.x - 30; lead = lx + 4; }
      else {
        // no room beside the marker: the top corner of the chart away from the peak
        right = focus.x > (G.px0 + G.px1) / 2;
        lx = right ? G.px0 : G.px1;
        lead = right ? lx + lw + 4 : lx - lw - 4;
        ly = G.chTop + 8;
      }
      out.push('<path class="tl-max-lead" d="M' + f1(focus.x) + " " + f1(focus.y - 5) + "L" + f1(lead) + " " + f1(ly - 4) + '"/>');
      out.push(txt(lx, ly - 1, "tl-max-lab", l1, right ? null : "end"));
      out.push(txt(lx, ly + 12, "tl-ital tl-max-sub", l2, right ? null : "end"));
    }

    // published records travel to their files
    var travel = this.travel(), ri = bisect(m.recT, t + eps), drawn = 0;
    var cardR = G.wide ? G.cw : null;
    for (var r = ri; r >= 0 && m.recT[r] > t - travel && drawn < 48; r--, drawn++) {
      var rec = m.records[r], u = (t - m.recT[r]) / travel;
      var wi = m.steps[rec.step].inner;
      rec.streams.forEach(function (op, n) {
        var si = -1;
        m.streams.forEach(function (sd, z) { if (sd.op === op) si = z; });
        if (si < 0) return;
        var src = op === "max_mean" ? G.best[wi] : wi;
        var p0 = [(G.winX0[src] + G.winX1[src]) / 2, G.Y(m.innerWins[src].mean)];
        // up the frontier, along the top of the chart, out of the card, into the slots
        var p3 = G.files[si].entry, lane = G.chTop - 6 - n * 4, route;
        if (cardR !== null) route = [p0, [p0[0], lane], [cardR - 14, lane], [cardR + 4, p3[1]], p3];
        else route = [p0, [p0[0], lane], [G.cw - 8, lane], [G.cw - 8, G.cardH + 6], [p3[0], p3[1] - 10], p3];
        for (var tr = 0; tr < 3; tr++) {
          var uu = u - tr * 0.05;
          if (uu < 0) break;
          var pt = along(route, 1 - Math.pow(1 - uu, 2));
          out.push('<circle class="' + (op === "max_mean" ? "tl-pt tl-pt-max" : "tl-pt") + '" cx="' + f1(pt[0]) + '" cy="' + f1(pt[1]) + '" r="' + (2.6 - tr * 0.7) + '" opacity="' + (1 - tr * 0.3) + '"/>');
        }
      });
    }

    // files and their slots
    var writing = {};
    m.tasks.forEach(function (tk) {
      if (tk.start <= t + eps && tk.end > t + eps) {
        tk.items.forEach(function (it) { writing[it.si] = { tk: tk, it: it }; });
      }
    });
    m.streams.forEach(function (sd, si) {
      var F = G.files[si], sn = m.snaps[si], k2 = bisect(sn.t, t + eps);
      var fill = k2 >= 0 ? sn.fill[k2] : null, state = k2 >= 0 ? sn.state[k2] : null, written = k2 >= 0 ? sn.written[k2] : 0;
      var wc = wcls(sd.worker);
      for (var dd = 0; dd < m.depth; dd++) {
        var x = F.sx + dd * (G.cellW + 3), f = fill ? fill[dd] : 0, stt = state ? state[dd] : 0;
        out.push(rect(x, F.sy, G.cellW, G.cellH, "tl-slot-bg", 3));
        var h = G.cellH * f / m.batch;
        if (h > 0) out.push(rect(x, F.sy + G.cellH - h, G.cellW, h, ["tl-slot-fill", "tl-slot-fill", "tl-slot-q " + wc, "tl-slot-w " + wc][stt], 2));
      }
      // file icon
      var ix = F.ix, iy = F.iy;
      out.push('<g class="tl-file' + (written ? "" : " tl-file-empty") + (writing[si] ? " tl-file-busy" : "") + '">' +
        '<path class="tl-file-doc" d="M' + ix + " " + iy + "H" + (ix + 23) + "L" + (ix + 31) + " " + (iy + 8) + "V" + (iy + 40) + "H" + ix + 'Z"/>' +
        '<path class="tl-file-fold" d="M' + (ix + 23) + " " + iy + "V" + (iy + 8) + "H" + (ix + 31) + '"/>' +
        line(ix + 5, iy + 11, ix + 19, iy + 11, "tl-file-line") + line(ix + 5, iy + 16, ix + 25, iy + 16, "tl-file-line") +
        txt(ix + 15.5, iy + 32, "tl-nc", ".nc", "middle") + "</g>");
      if (sd.worker >= 0) out.push('<circle class="tl-wdot ' + wc + '" cx="' + (ix + 31) + '" cy="' + (iy + 40) + '" r="4"/>');
      var name = sd.key, meta = "rank0.nc · " + (sd.worker >= 0 ? "writer " + sd.worker : "model process");
      var stat = "time " + written + " / " + G.totals[si];
      var comp = OPS.filter(function (o) { return o.id === sd.op; })[0].compound;
      if (comp && written < G.totals[si]) stat += " · window open";
      out.push(txt(F.tx, F.ty, "tl-fname", name) + txt(F.tx, F.ty + 12, "tl-xs tl-muted", meta) + txt(F.tx, F.ty + 24, "tl-xs", stat));
      // a batch on its way to the file
      var wr = writing[si];
      if (wr) {
        var u2 = clamp((t - wr.tk.start) / Math.max(1e-6, wr.tk.end - wr.tk.start), 0, 1);
        var sx = F.sx + wr.it.slot * (G.cellW + 3) + G.cellW / 2, sy = F.sy + G.cellH / 2;
        var px = sx + (ix + 15 - sx) * u2, py = sy + (iy + 22 - sy) * u2;
        out.push('<g class="tl-pkt ' + wc + '">' + rect(px - 13, py - 7, 26, 14, "tl-pkt-box", 7) + txt(px, py + 3.5, "tl-pkt-txt", "+" + wr.it.rows, "middle") + "</g>");
      }
    });
    // writer processes
    var y3 = G.wy, lines = [];
    if (cfg.writers === 0) {
      var busy = m.tasks.filter(function (tk) { return tk.start <= t + eps && tk.end > t + eps; })[0];
      lines.push(["tl-wm", "model process " + (busy ? "appends " + busy.items[0].rows + " rows itself (output_workers=0)" : "appends full batches itself")]);
    } else {
      for (var wk = 0; wk < cfg.writers; wk++) {
        var act = null, queued = 0;
        m.tasks.forEach(function (tk) {
          if (tk.worker !== wk || tk.submit > t + eps || tk.end <= t + eps) return;
          if (tk.start <= t + eps) act = tk; else queued++;
        });
        var mine = m.streams.filter(function (sd) { return sd.worker === wk; }).map(function (sd) { return sd.op; });
        var rows = act ? act.items.reduce(function (a, it) { return a + it.rows; }, 0) : 0;
        lines.push([wcls(wk), "writer " + wk + " · " + (act ? "appending " + rows + " rows (" + act.items.map(function (it) { return m.streams[it.si].op; }).join(", ") + ")" : mine.length ? "idle · " + mine.join(", ") : "no files") + (queued ? " · " + queued + " queued" : "")]);
      }
    }
    if (cfg.ranks > 1) lines.push(["tl-wm", "rank 1: same files, own catchments"]);
    lines.forEach(function (l, n) {
      var yy = y3 + n * 16 + 8;
      out.push('<circle class="tl-wdot ' + l[0] + '" cx="' + (G.fx + 4) + '" cy="' + (yy - 3.5) + '" r="3.5"/>' + txt(G.fx + 13, yy, "tl-xs", l[1]));
    });
    return out.join("");
  };

  /* ---------- time-axis view: one model step, sliced thin */
  Timeline.prototype.layoutAxis = function (W) {
    var m = this.model, cfg = this.cfg, id = this.id, out = [];
    var wide = W >= 560;
    var K = wide ? 9 : 5;
    var stripTop = 40, stripBase = 86, labY = 100, chY = 108, chH = 16;
    var ptop = 160, ph = wide ? 214 : 186, pbot = ptop + ph;
    // the zoomed step on the left, the whole run in a small window beside it
    var pw = wide ? Math.round(W * 0.64) : W;
    var ix0 = 14, ix1 = pw - 14;
    var inset = wide
      ? { x: pw + 16, y: ptop, w: W - pw - 16, h: ph }
      : { x: 0, y: pbot + 96, w: W, h: 112 };
    var cTop = ptop + 34, cBot = pbot - 62, bTop = pbot - 46;
    // record values (illustrative runoff), divided by reuse_count with "distribute"
    var rv = new Float64Array(m.steps.length), rmax = 1;
    m.steps.forEach(function (s, i) {
      var v = SIGNAL.r((s.recordStart + m.I * HOUR / 2 - T0) / DAY) / (m.upsampling === "distribute" ? m.R : 1);
      rv[i] = v; if (v > rmax) rmax = v;
    });
    var secs = m.H * 3600;
    out.push("<defs>" + hatchDef(id + "-h") +
      '<linearGradient id="' + id + '-fade" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.12" stop-color="#fff"/><stop offset="0.88" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<mask id="' + id + '-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="' + W + '" height="' + (chY + chH + 6) + '"><rect width="' + W + '" height="' + (chY + chH + 6) + '" fill="url(#' + id + '-fade)"/></mask></defs>');
    out.push(txt(0, 15, "tl-strong", "step_advance()") + txt(wide ? 104 : 100, 15, "tl-ital tl-cap", "one model step = " + (m.H === 24 ? "one day" : hoursLabel(m.H)) + " = " + secs.toLocaleString("en-US") + " s"));
    if (wide) out.push(txt(W, 15, "tl-xs tl-muted", "runoff records, read in chunks", "end"));
    out.push(rect(0.75, ptop, pw - 1.5, ph, "tl-panel", 10));
    out.push(txt(ix0, ptop + 19, "tl-xs", "outflow, updated every sub-step"));
    out.push(rect(1.5, bTop, pw - 3, pbot - bTop - 0.75, "tl-band-bg", 0));
    var bandTxt = m.upsampling === "distribute" ? "runoff: the record ÷ " + m.R + ", constant within the step"
      : m.R > 1 ? "runoff: the record's rate, reused for " + m.R + " steps"
        : "runoff: this step's rate, constant within the step";
    out.push(txt(ix1, pbot + 30, "tl-xs tl-muted", "sub-step k", "end"));
    var nl = cfg.loaders;
    out.push(this.layoutInset(inset, rv, rmax));
    var ly = wide ? pbot + 112 : inset.y + inset.h + 36;
    var what = nl ? nl + " worker" + (nl > 1 ? "s" : "") + " × prefetch_factor " + cfg.prefetch + " = " + nl * cfg.prefetch + " chunks requested ahead" : "loader_workers = 0: read in the model process";
    out.push(line(0, ly - 18, W, ly - 18, "tl-lane"));
    out.push(txt(0, ly, "tl-strong", "runoff loader") + (wide ? txt(100, ly, "tl-xs tl-muted", what) : ""));
    var ry = ly + 14;
    if (!wide) { out.push(txt(0, ry, "tl-xs tl-muted", what)); ry += 13; }
    if (nl) { out.push(txt(0, ry, "tl-xs tl-muted", "chunk i → worker i mod " + nl + (cfg.chunk > 1 ? " · " + cfg.chunk + " records per chunk" : " · one record per chunk"))); ry += 13; }
    var lanes = Math.max(1, nl);
    var laneTop = ry + 4;
    this.G = {
      wide: wide, W: W, H: laneTop + lanes * 24 + 4, K: K, stepW: W / K, stripTop: stripTop, stripBase: stripBase,
      labY: labY, chY: chY, chH: chH, stripBottom: chY + chH + 8, ptop: ptop, pbot: pbot, ix0: ix0, ix1: ix1,
      cTop: cTop, cBot: cBot, bTop: bTop, rv: rv, rmax: rmax, laneTop: laneTop, pw: pw, inset: inset, bandTxt: bandTxt
    };
    return out.join("");
  };

  // The whole run in a small window: runoff hangs from the top, outflow rises from
  // the bottom (a classic flood hydrograph); played steps in colour, the rest grey.
  Timeline.prototype.layoutInset = function (b, rv, rmax) {
    var m = this.model, id = this.id, out = [];
    var x0 = b.x + 10, x1 = b.x + b.w - 10, rTop = b.y + 30, rH = b.h * 0.22, base = b.y + b.h - 16, qH = b.h * 0.4;
    var n = m.steps.length, qv = new Float64Array(n), qmax = 1;
    m.steps.forEach(function (s, i) {
      var v = SIGNAL.q((s.start + s.end) / 2 / DAY - T0 / DAY);
      if (s.phase === "spinup") v *= 0.75;
      qv[i] = v; if (v > qmax) qmax = v;
    });
    var X = function (k) { return x0 + (x1 - x0) * k / n; };
    // one column per pixel: the largest value of the steps in it
    var nc = Math.max(1, Math.ceil(x1 - x0)), cq = new Float64Array(nc), cr = new Float64Array(nc);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(X(i) - x0), z = Math.max(a, Math.ceil(X(i + 1) - x0) - 1);
      for (var c = a; c <= z && c < nc; c++) { if (qv[i] > cq[c]) cq[c] = qv[i]; if (rv[i] > cr[c]) cr[c] = rv[i]; }
    }
    var dq = "M" + f1(x0) + " " + f1(base), dr = "";
    for (c = 0; c < nc; c++) {
      dq += "V" + f1(base - qH * cq[c] / qmax) + "H" + f1(x0 + c + 1);
      if (cr[c] > 0) dr += "M" + f1(x0 + c) + " " + f1(rTop) + "v" + f1(rH * cr[c] / rmax) + "h1v" + f1(-rH * cr[c] / rmax) + "z";
    }
    dq += "V" + f1(base) + "Z";
    out.push('<defs><clipPath id="' + id + '-ins"><rect data-r="insclip" x="' + f1(x0) + '" y="' + b.y + '" width="0" height="' + b.h + '"/></clipPath></defs>');
    out.push(rect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5, "tl-panel", 10));
    out.push(txt(b.x + 10, b.y + 17, "tl-xs", "the whole run"));
    out.push(txt(b.x + b.w - 10, b.y + 17, "tl-xs tl-muted", fmtMonth(m.steps[m.numSpinSteps].start) + " – " + fmtMonth(m.steps[n - 1].start), "end"));
    out.push('<path class="tl-ins-r-ghost" d="' + dr + '"/><path class="tl-ins-q-ghost" d="' + dq + '"/>');
    out.push('<g clip-path="url(#' + id + '-ins)"><path class="tl-ins-r" d="' + dr + '"/><path class="tl-ins-q" d="' + dq + '"/></g>');
    out.push(line(x0, base + 0.5, x1, base + 0.5, "tl-tick"));
    if (m.numSpinSteps) out.push(line(X(m.numSpinSteps), rTop - 4, X(m.numSpinSteps), base, "tl-outer-sep") + txt(x0, base + 12, "tl-xs tl-muted", "spin-up"));
    out.push(txt(x1, rTop + rH + 12, "tl-xs tl-muted", "runoff", "end") + txt(x1, base - qH - 4, "tl-xs tl-muted", "outflow", "end"));
    this.ins = { X: X, x0: x0, base: base, qH: qH, qmax: qmax, qv: qv, rTop: rTop };
    return out.join("");
  };

  Timeline.prototype.chunkState = function (c, S) {
    var m = this.model, t = this.t, eps = 1e-9, rd = m.reads[c], ch = m.chunks[c];
    var lastStep = ch.steps[ch.steps.length - 1], firstStep = ch.steps[0];
    if (S.i >= firstStep && S.i <= lastStep && !(S.i === lastStep && !S.running && S.seg && S.seg.kind !== "step")) return { s: "inuse" };
    if (S.i > lastStep || (S.i === lastStep && !S.running)) return { s: "used" };
    if (!rd || rd.dispatch > t + eps) return { s: "off" };
    if (rd.start > t + eps) return { s: "queued" };
    if (rd.ready > t + eps) return { s: "reading", p: (t - rd.start) / Math.max(1e-6, rd.ready - rd.start) };
    return { s: "ready" };
  };

  Timeline.prototype.drawAxis = function (S) {
    var m = this.model, G = this.G, cfg = this.cfg, t = this.t, out = [], eps = 1e-9, id = this.id;
    var W = G.W, hrs = m.H < 24;
    var pos = S.i < 0 ? 0 : S.i + (S.running ? S.frac : 1);
    var cx = W / 2;
    function SXs(k) { return cx + (k - pos) * G.stepW; }
    var k0 = Math.max(0, Math.floor(pos - G.K / 2) - 1), k1 = Math.min(m.steps.length - 1, Math.ceil(pos + G.K / 2) + 1);
    // the strip: one block per model step, height = its runoff record
    var seen = {};
    out.push('<g mask="url(#' + id + '-mask)">');
    for (var k = k0; k <= k1; k++) {
      var s = m.steps[k], x = SXs(k), h = 6 + 34 * G.rv[k] / G.rmax;
      var cls = "tl-blk" + (k === S.i ? " tl-blk-cur" : k < S.i ? " tl-blk-done" : "");
      if (s.phase === "spinup") out.push('<rect fill="url(#' + id + '-h)" x="' + f1(x + 1) + '" y="' + f1(G.stripBase - h) + '" width="' + f1(G.stepW - 2) + '" height="' + f1(h) + '" class="tl-blk-spin"/>');
      out.push(rect(x + 1, G.stripBase - h, G.stepW - 2, h, cls + (s.phase === "spinup" ? " tl-blk-sp" : "")));
      if (s.reuse === 0 && m.R > 1) out.push(line(x + 0.5, G.stripTop - 4, x + 0.5, G.stripBase, "tl-rec"));
      var lab = dayLabel(s.start, hrs);
      if (G.stepW > lab.length * 6.2 + 4) out.push(txt(x + G.stepW / 2, G.labY, "tl-xs" + (k === S.i ? " tl-strong" : " tl-muted"), lab, "middle"));
      // the window closes at the end of this step: a record is published
      if (s.phase === "main" && !s.dropped && s.inner !== undefined && m.innerWins[s.inner].last === k) {
        var done = m.stepT1[k] <= t + eps;
        out.push('<path class="tl-pub' + (done ? " tl-pub-done" : "") + '" d="M' + f1(x + G.stepW - 5) + " " + f1(G.stripBase - h - 9) + "h8l-4 5z\"/>");
      }
      if (!seen[s.chunk]) {
        seen[s.chunk] = true;
        var ch = m.chunks[s.chunk], a = SXs(ch.steps[0]), b = SXs(ch.steps[ch.steps.length - 1] + 1);
        var cs = this.chunkState(s.chunk, S), rd = m.reads[s.chunk];
        var wc = wcls(rd ? rd.worker : -1);
        out.push(rect(a + 1.5, G.chY, b - a - 3, G.chH, "tl-ch tl-ch-" + cs.s + " " + wc, 5));
        if (cs.s === "reading") out.push(rect(a + 1.5, G.chY, (b - a - 3) * cs.p, G.chH, "tl-ch-prog " + wc, 5));
        var cl = ["chunk " + ch.index + (rd && rd.worker >= 0 ? " · w" + rd.worker : "") + " · " + (cs.s === "off" ? "not requested" : cs.s === "inuse" ? "in use" : cs.s), "c" + ch.index + " " + (cs.s === "inuse" ? "in use" : cs.s === "off" ? "–" : cs.s), "c" + ch.index];
        var vis0 = Math.max(a, 0), vis1 = Math.min(b, W);
        for (var q = 0; q < cl.length; q++) {
          if (vis1 - vis0 - 8 >= cl[q].length * 5.6) { out.push(txt(vis0 + 6, G.chY + 11.5, "tl-chlab" + (cs.s === "inuse" ? " tl-chlab-inv" : ""), cl[q])); break; }
        }
      }
    }
    out.push("</g>");
    out.push(line(cx, G.stripTop - 8, cx, G.chY + G.chH + 3, "tl-nowline"));
    var st = S.i >= 0 ? m.steps[S.i] : m.steps[0];
    var si = Math.max(0, S.i);
    // projection of the current step onto the panel
    var bx0 = SXs(si) + 1, bx1 = SXs(si) + G.stepW - 1;
    out.push('<path class="tl-proj" d="M' + f1(bx0) + " " + (G.chY + G.chH + 2) + "L1 " + G.ptop + "M" + f1(bx1) + " " + (G.chY + G.chH + 2) + "L" + (G.pw - 1) + " " + G.ptop + '"/>');

    // the zoomed step: one sample per sub-step
    var n = st.n, dtd = (m.H / 24) / n, tau0 = (st.start - T0) / DAY;
    if (!this.cache || this.cache.i !== si) {
      var stride = Math.max(1, Math.ceil(n / 300)), xs = [], vs = [], lo = Infinity, hi = -Infinity;
      for (var j = 0; j <= n; j += stride) push(j);
      if (xs[xs.length - 1] !== n) push(n);
      var mid = (lo + hi) / 2, half = Math.max((hi - lo) / 2 * 1.5, mid * 0.012);
      this.cache = { i: si, xs: xs, vs: vs, mid: mid, half: half };
    }
    function push(jj) { var v = SIGNAL.q(tau0 + jj * dtd); xs.push(jj); vs.push(v); if (v < lo) lo = v; if (v > hi) hi = v; }
    var C = this.cache;
    var X = function (jj) { return G.ix0 + (G.ix1 - G.ix0) * jj / n; };
    var cm = (G.cTop + G.cBot) / 2, ch2 = (G.cBot - G.cTop) / 2;
    var Yc = function (v) { return clamp(cm - (v - C.mid) / C.half * ch2, G.cTop - 6, G.cBot + 6); };
    var kk = S.i < 0 ? 0 : S.sub;
    var dDone = "", dTodo = "";
    for (var z = 0; z < C.xs.length; z++) {
      var pt = f1(X(C.xs[z])) + " " + f1(Yc(C.vs[z]));
      if (C.xs[z] <= kk) dDone += (dDone ? "L" : "M") + pt;
      if (C.xs[z] >= kk || z === C.xs.length - 1) dTodo += (dTodo ? "L" : "M") + pt;
    }
    if (kk > 0 && kk < n) {
      var pk = f1(X(kk)) + " " + f1(Yc(SIGNAL.q(tau0 + kk * dtd)));
      dDone += "L" + pk; dTodo = "M" + pk + "L" + dTodo.slice(1);
    }
    var spin = st.phase === "spinup", noStats = spin || st.dropped;
    out.push('<path class="tl-curve-todo" d="' + dTodo + '"/>');
    if (dDone) out.push('<path class="tl-curve-done' + (noStats ? " tl-curve-spin" : "") + '" d="' + dDone + '"/>');
    var every = Math.max(1, Math.round(n / 90));
    var dots = [];
    for (var jd = every; jd <= kk; jd += every) dots.push('<circle cx="' + f1(X(jd)) + '" cy="' + f1(Yc(SIGNAL.q(tau0 + jd * dtd))) + '" r="2"/>');
    out.push('<g class="' + (noStats ? "tl-dots tl-dots-off" : "tl-dots") + '">' + dots.join("") + "</g>");
    // mean so far over the inner window (all of its sub-steps done so far)
    var px = X(kk);
    if (!noStats && S.i >= 0 && kk > 0 && st.inner !== undefined) {
      var w = m.innerWins[st.inner], sum = 0, wsum = 0, cnt = 0;
      for (var k2 = w.first; k2 <= S.i; k2++) {
        var s2 = m.steps[k2], nn = k2 === S.i ? kk : s2.n, d2 = (m.H / 24) / s2.n, ta2 = (s2.start - T0) / DAY;
        for (var q2 = 1; q2 <= nn; q2++) { sum += SIGNAL.q(ta2 + q2 * d2) * d2; wsum += d2; cnt++; }
      }
      var my = Yc(sum / wsum);
      out.push(line(G.ix0, my, px, my, "tl-mean"));
      var ml = "mean so far = Σ / " + cnt;
      var right = px + 8 + ml.length * 6 < G.ix1;
      out.push(txt(right ? px + 8 : px - 8, my + (my > cm ? -6 : 13), "tl-xs tl-mean-lab", ml, right ? null : "end"));
    }
    if (noStats && S.i >= 0) out.push(txt(G.ix1, G.ptop + 19, "tl-xs tl-muted", spin ? "spin-up: no statistics samples" : "dropped window: no samples", "end"));
    // this step's runoff: one level for the whole step, a new level every step
    var lvl = 3 + (G.pbot - G.bTop - 25) * G.rv[si] / G.rmax;
    out.push(rect(1.5, G.pbot - 1 - lvl, G.pw - 3, lvl, "tl-band"));
    out.push(line(1.5, G.pbot - 1 - lvl, G.pw - 1.5, G.pbot - 1 - lvl, "tl-band-top"));
    out.push(txt(G.ix0, G.bTop + 14, "tl-xs tl-band-lab", G.bandTxt));
    // the whole run: played part in colour, a marker at the current step
    if (this.ins) {
      var I = this.ins, ip = S.i < 0 ? 0 : S.i + (S.running ? S.frac : 1), ixp = I.X(ip);
      if (this.insClip) this.insClip.setAttribute("width", f1(Math.max(0, ixp - I.x0)));
      var qy = I.base - I.qH * I.qv[Math.max(0, Math.min(m.steps.length - 1, si))] / I.qmax;
      out.push(line(ixp, I.rTop - 6, ixp, I.base, "tl-play") + '<circle class="tl-ins-dot" cx="' + f1(ixp) + '" cy="' + f1(qy) + '" r="3"/>');
    }
    // playhead
    out.push(line(px, G.ptop + 26, px, G.pbot, "tl-play"));
    out.push('<circle class="tl-play-knob" cx="' + f1(px) + '" cy="' + (G.ptop + 26) + '" r="3.5"/>');
    // the model waits, or the run is over
    var msg = null;
    if (t >= m.tEnd - eps) msg = "run finished";
    else if (S.seg && S.seg.kind !== "step") {
      var c = /chunk (\d+)/.exec(S.seg.text || ""), rdw = c ? m.reads[+c[1]] : null;
      msg = S.seg.kind === "wait-chunk" ? "the model waits for " + S.seg.text + (rdw && rdw.worker >= 0 ? " (loader worker " + rdw.worker + ")" : "")
        : S.seg.kind === "read" ? "the model process reads " + S.seg.text + " itself"
          : S.seg.kind === "close" ? "close(): waiting for the last appends" : "the model waits";
    } else if (S.i < 0) msg = "Press Play, or drag across the figure";
    if (msg) {
      out.push(rect(2, G.cTop - 10, G.pw - 4, G.cBot - G.cTop + 20, "tl-veil"));
      out.push(txt(G.pw / 2, (G.cTop + G.cBot) / 2 + 4, "tl-ital tl-hint" + (S.seg && S.seg.kind !== "step" && t < m.tEnd - eps ? " tl-hint-warn" : ""), msg, "middle"));
    }
    // axis under the panel
    [0, 0.25, 0.5, 0.75, 1].forEach(function (fr) {
      var jj = Math.round(n * fr), x2 = X(jj);
      out.push(line(x2, G.pbot, x2, G.pbot + 4, "tl-tick") + txt(x2, G.pbot + 15, "tl-xs tl-muted", String(jj), fr === 0 ? "start" : fr === 1 ? "end" : "middle"));
    });
    var dt = m.H * 3600 / n;
    var info = [["N = ", n + " sub-steps"], ["dt = ", (dt >= 100 ? Math.round(dt) : dt.toFixed(1)) + " s"], ["k = ", String(kk)]];
    var ix = 0;
    info.forEach(function (p, z2) {
      out.push(txt(ix, G.pbot + 48, z2 === 2 ? "tl-strong tl-blue" : "tl-strong", p[0] + p[1]));
      ix += (p[0] + p[1]).length * 6.4 + 22;
    });
    var how = cfg.sub === "adaptive" ? "adaptive: N from the CFL condition, every model step" : "fixed: N = model_step / 240 s";
    out.push(txt(0, G.pbot + 64, "tl-ital tl-cap", how));
    var legY = G.pbot + 79;
    out.push('<circle class="tl-dots-key" cx="4" cy="' + (legY - 3.5) + '" r="2.4"/>' + txt(12, legY, "tl-xs tl-muted", "a statistics sample" + (every > 1 ? " (every " + (every === 2 ? "2nd" : every === 3 ? "3rd" : every + "th") + " of " + n + " drawn)" : "")));

    // loader lanes
    var nl = cfg.loaders, tw = G.wide ? 104 : 66, lx0 = G.wide ? 74 : 62;
    for (var lw = 0; lw < Math.max(1, nl); lw++) {
      var y = G.laneTop + lw * 24;
      out.push(txt(0, y + 12, "tl-xs", nl ? "worker " + lw : "model"));
      out.push(line(lx0 - 6, y + 8, W, y + 8, "tl-lane"));
      var toks = [];
      for (var c2 = 0; c2 < m.chunks.length; c2++) {
        if (nl && c2 % nl !== lw) continue;
        var cs2 = this.chunkState(c2, S);
        if (cs2.s === "used") continue;
        if (cs2.s === "off") { if (toks.length < 5) toks.push([c2, cs2]); break; }
        if (!nl && cs2.s !== "inuse" && cs2.s !== "reading") { toks.push([c2, { s: "off" }]); break; }
        toks.push([c2, cs2]);
        if (toks.length >= 5) break;
      }
      var maxT = Math.max(1, Math.floor((W - lx0) / (tw + 6)));
      toks.slice(0, maxT).forEach(function (tk, z3) {
        var x3 = lx0 + z3 * (tw + 6), wc3 = wcls(nl ? lw : -1), stt = tk[1].s;
        out.push(rect(x3, y + 1, tw, 15, "tl-ch tl-ch-" + stt + " " + wc3, 7.5));
        if (stt === "reading") out.push(rect(x3, y + 1, tw * tk[1].p, 15, "tl-ch-prog " + wc3, 7.5));
        var label = G.wide ? "chunk " + tk[0] + " · " + (stt === "off" ? "next" : stt === "inuse" ? "in use" : stt) : "c" + tk[0] + " " + (stt === "off" ? "next" : stt === "inuse" ? "use" : stt === "reading" ? "read" : stt === "queued" ? "queue" : stt);
        out.push(txt(x3 + tw / 2, y + 12, "tl-chlab" + (stt === "inuse" ? " tl-chlab-inv" : ""), label, "middle"));
      });
    }
    return out.join("");
  };

  /* ---------- state at t */
  Timeline.prototype.state = function () {
    var m = this.model, t = this.t;
    var gi = bisect(m.segT0, t);
    var seg = gi >= 0 ? m.segs[gi] : null;
    // a finished stall (or the end of the run) is not the current activity
    if (seg && seg.kind !== "step" && t >= seg.t1 - 1e-9) seg = null;
    var i = bisect(m.stepT0, t);
    var running = i >= 0 && t < m.stepT1[i] - 1e-9 && seg && seg.kind === "step";
    var frac = running ? (t - m.stepT0[i]) : (i >= 0 ? 1 : 0);
    var step = i >= 0 ? m.steps[i] : null;
    var sub = step ? Math.min(step.n, Math.floor(frac * step.n + 1e-9)) : 0;
    return { seg: seg, i: i, step: step, running: running, frac: frac, sub: sub };
  };

  /* ---------- render */
  Timeline.prototype.render = function () {
    var m = this.model;
    if (!m || !this.G) return;
    var S = this.state();
    var x = this.ov.X(this.t);
    this.ovClip.setAttribute("width", f1(Math.max(0, x - this.ov.x0)));
    this.ovHead.setAttribute("transform", "translate(" + f1(x) + " 0)");
    this.root.classList.toggle("cmf-tl-playing", this.playing);
    this.scrub.setAttribute("aria-valuemin", "0");
    this.scrub.setAttribute("aria-valuemax", String(m.steps.length));
    this.scrub.setAttribute("aria-valuenow", String(Math.max(0, S.i + 1)));
    var rtxt = this.readoutText(S);
    this.scrub.setAttribute("aria-valuetext", rtxt.replace(/<[^>]+>/g, ""));
    if (rtxt !== this.lastReadout) { this.readout.innerHTML = rtxt; this.lastReadout = rtxt; }
    this.dyn.innerHTML = this.view === "statistics" ? this.drawStats(S) : this.drawAxis(S);
  };

  Timeline.prototype.readoutText = function (S) {
    var m = this.model, cfg = this.cfg, parts = [];
    var hrs = m.H < 24;
    if (!S.step) {
      parts.push('<span class="cmf-tl-phase">Ready</span>');
    } else {
      var s = S.step;
      var ph = s.phase === "spinup" ? "spin-up " + (s.cycle + 1) : "main period";
      var idx = s.phase === "spinup" ? (s.i % (m.numSpinSteps / cfg.spin)) + 1 : s.i - m.numSpinSteps + 1;
      var tot = s.phase === "spinup" ? m.numSpinSteps / cfg.spin : m.steps.length - m.numSpinSteps;
      parts.push('<span class="cmf-tl-phase' + (s.phase === "spinup" ? " cmf-tl-phase-spin" : "") + '">' + ph.charAt(0).toUpperCase() + ph.slice(1) + "</span>" +
        "model step <b>" + idx + "</b>/" + tot + " · " + fmtDate(s.start, hrs));
      parts.push("sub-step <b>" + S.sub + "</b>/" + s.n);
      if (s.phase === "spinup") parts.push("no statistics during spin-up");
      else if (s.dropped) parts.push("dropped window (partial_period=\"drop\")");
      else if (s.inner !== undefined) {
        var iw = m.innerWins[s.inner];
        parts.push("inner window " + fmtDate(iw.label, cfg.inner === "step" && hrs));
        if (cfg.outer !== "none") parts.push("outer window " + (cfg.outer === "month" ? fmtMonth(m.outerWins[s.outer].label) : new Date(m.outerWins[s.outer].label).getUTCFullYear()));
      }
    }
    if (S.seg && S.seg.kind !== "step") {
      var why = {
        "read": "model process reads " + S.seg.text + " (loader_workers=0)",
        "wait-chunk": "loop waits for " + S.seg.text,
        "wait-slot": "model waits: " + S.seg.text + " is still being appended",
        "write": "model process appends " + S.seg.text + " (output_workers=0)",
        "close": "close(): waiting for the last appends"
      }[S.seg.kind];
      parts.push('<span class="cmf-tl-warn"><i aria-hidden="true"></i>' + esc(why) + "</span>");
    }
    if (this.t >= m.tEnd - 1e-9) {
      parts.push('<span class="cmf-tl-ok">run finished: every row is on disk</span>');
      return parts.join('<span class="cmf-tl-sep" aria-hidden="true"> · </span>');
    }
    if (this.view === "time-axis") {
      var lw = this.loaderSummary();
      if (lw) parts.push(lw);
    } else {
      var ws = this.writerSummary();
      if (ws) parts.push(ws);
    }
    return parts.join('<span class="cmf-tl-sep" aria-hidden="true"> · </span>');
  };

  Timeline.prototype.loaderSummary = function () {
    var m = this.model, t = this.t, out = [];
    if (this.cfg.loaders === 0) return "";
    var reading = [], ready = 0;
    m.reads.forEach(function (r) {
      if (!r || r.dispatch > t) return;
      if (r.recv !== null && r.recv <= t) return;
      if (r.start <= t && r.ready > t) reading.push("worker " + r.worker + " reading chunk " + r.chunk);
      else if (r.ready <= t) ready++;
    });
    out = reading.slice(0, 2);
    if (ready) out.push(ready + " chunk" + (ready > 1 ? "s" : "") + " ready");
    return out.join(", ");
  };

  Timeline.prototype.writerSummary = function () {
    var m = this.model, t = this.t, out = [];
    m.tasks.forEach(function (tk) {
      if (tk.worker >= 0 && tk.start <= t && tk.end > t) {
        out.push("writer " + tk.worker + " appending " + tk.items.map(function (it) { return it.rows + " rows to " + m.streams[it.si].key + "_rank0.nc"; }).join(" + "));
      }
    });
    return out.slice(0, 2).join(", ");
  };

  /* ------------------------------------------------------------ mount */
  function mountAll() {
    var nodes = document.querySelectorAll(".cmf-timeline:not([data-cmf-mounted])");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute("data-cmf-mounted", "");
      try { nodes[i].cmfTimeline = new Timeline(nodes[i]); }
      catch (err) { nodes[i].removeAttribute("data-cmf-mounted"); if (window.console) console.error("cmf-timeline:", err); }
    }
  }
  if (typeof window !== "undefined" && window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(function () { mountAll(); });
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
  // exposed for tests
  window.cmfTimelineModel = buildModel;
})();
