/* CaMa-Flood-GPU home page: hero river map, scroll-driven figures, benchmark.
 *
 * Each step of a chapter drives one figure of that chapter's sticky stage: the
 * figure's progress p (0..1) is how far its step has scrolled past the reading
 * line. The catchment and matrix figures compute W from a small built-in
 * example (8 x 6 runoff cells of 6 x 6 pixels, 24 catchments); the maps and the
 * gauge figures read docs/home/data/*.js, written by tools/home_data.py.
 */
(function () {
  "use strict";

  var H0 = window.HOME || {};
  var RIVERS = H0.rivers || { gpus: [] };
  var HYDRO = H0.hydrograph || { stations: [] };
  var YEAR = HYDRO.year || RIVERS.year || 2000;
  // gauges of tools/home_data.py: the Mekong at Mukdahan, the Amazon at Manacapuru
  var NO_STATION = { name: "", outflow: [], depth: [], flood_table_m: [], bank_m: 1, width_m: 1, distance_m: 1 };
  var GAUGE = HYDRO.stations[0] || NO_STATION, MANACAPURU = HYDRO.stations[1] || NO_STATION;
  var REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var NARROW = false;

  /* ------------------------------------------------------------ helpers */
  function f1(v) { return String(Math.round(v * 10) / 10); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function txt(x, y, cls, s, anchor) {
    return '<text class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(s) + "</text>";
  }
  function line(x1, y1, x2, y2, cls) {
    return '<line class="' + cls + '" x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) + '"/>';
  }
  function rect(x, y, w, h, cls, extra) {
    return '<rect class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '" width="' + f1(Math.max(0, w)) + '" height="' + f1(Math.max(0, h)) + '"' + (extra || "") + "/>";
  }
  function mix(pct) { return ' style="fill: color-mix(in srgb, var(--blue) ' + Math.round(pct) + '%, var(--paper))"'; }
  function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
  function rng(seed) {
    return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  }
  // point at fraction u of the length of a polyline
  function along(pts, u) {
    var len = [0], total = 0, i;
    for (i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      len.push(total);
    }
    var d = clamp(u, 0, 1) * total;
    for (i = 1; i < pts.length; i++) {
      if (d <= len[i] || i === pts.length - 1) {
        var f = len[i] > len[i - 1] ? (d - len[i - 1]) / (len[i] - len[i - 1]) : 1;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
    }
    return pts[pts.length - 1];
  }
  function smooth(p, a, b) { return clamp((p - a) / (b - a), 0, 1); }
  var DROP = "M0 -11C3.6 -5.6 6.5 -1.6 6.5 2.4A6.5 6.5 0 0 1 -6.5 2.4C-6.5 -1.6 -3.6 -5.6 0 -11Z";

  /* ------------------------------------------------------------ the example */
  var EX = (function () {
    var NC = 8, NR = 6, K = 6, PX = NC * K, PY = NR * K, rnd = rng(3);
    var runoff = [];
    for (var r = 0; r < NR; r++) {
      for (var c = 0; c < NC; c++) {
        var v = 1.3 + 2.2 * (0.5 + 0.5 * Math.sin(c * 0.9 + 0.4) * Math.cos(r * 0.8 - 0.3)) + rnd() * 1.4;
        runoff.push(Math.round(v * 10) / 10);
      }
    }
    // 24 catchments: a jittered 6 x 4 lattice of seeds, wobbly nearest-seed regions
    var seeds = [];
    for (var sr = 0; sr < 4; sr++) {
      for (var sc = 0; sc < 6; sc++) {
        seeds.push([(sc + 0.5) * PX / 6 + (rnd() - 0.5) * 4, (sr + 0.5) * PY / 4 + (rnd() - 0.5) * 4]);
      }
    }
    var owner = [];
    for (var y = 0; y < PY; y++) {
      var row = [];
      for (var x = 0; x < PX; x++) {
        var qx = x + 0.5 + 2.6 * Math.sin(y * 0.45 + x * 0.12) + 1.5 * Math.cos(x * 0.37 - y * 0.21);
        var qy = y + 0.5 + 2.2 * Math.cos(x * 0.41 + y * 0.09) + 1.2 * Math.sin(y * 0.33 - x * 0.27);
        var best = 0, bd = Infinity;
        for (var s = 0; s < seeds.length; s++) {
          var dx = qx - seeds[s][0], dy = (qy - seeds[s][1]) * 1.15, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = s; }
        }
        row.push(best);
      }
      owner.push(row);
    }
    var NCAT = seeds.length, W = [];
    for (var i = 0; i < NCAT; i++) { var wr = []; for (var g = 0; g < NC * NR; g++) wr.push(0); W.push(wr); }
    for (y = 0; y < PY; y++) for (x = 0; x < PX; x++) W[owner[y][x]][Math.floor(y / K) * NC + Math.floor(x / K)]++;
    var nnz = 0, maxRow = 0, wmax = 0;
    W.forEach(function (wr2) {
      var n = 0;
      wr2.forEach(function (w) { if (w) { n++; nnz++; if (w > wmax) wmax = w; } });
      if (n > maxRow) maxRow = n;
    });
    // the drop lands in cell g12 (row 1, column 4)
    var dropPx = [4 * K + 2, 1 * K + 3], cstar = owner[dropPx[1]][dropPx[0]];
    var pixels = [];
    for (y = 0; y < PY; y++) for (x = 0; x < PX; x++) if (owner[y][x] === cstar) pixels.push([x, y]);
    // the pixel the drop landed on goes first
    pixels.sort(function (a, b) {
      var da = Math.abs(a[0] - dropPx[0]) + Math.abs(a[1] - dropPx[1]), db = Math.abs(b[0] - dropPx[0]) + Math.abs(b[1] - dropPx[1]);
      return da - db || a[1] - b[1] || a[0] - b[0];
    });
    // the cells the drop's catchment overlaps: [cell, pixels]
    var row = [];
    W[cstar].forEach(function (w, g) { if (w) row.push([g, w]); });
    return { NC: NC, NR: NR, K: K, PX: PX, PY: PY, runoff: runoff, owner: owner, NCAT: NCAT, W: W, nnz: nnz, maxRow: maxRow, wmax: wmax, cstar: cstar, pixels: pixels, dropPx: dropPx, dropCell: 12, row: row };
  })();

  // catchment fills as horizontal pixel runs and their outlines, then the runoff grid (pixel units)
  function catchmentPaths(s, x0, y0) {
    var p = catchmentLayers(s, x0, y0);
    return p.ctm + p.grid;
  }
  function catchmentLayers(s, x0, y0) {
    var fills = {}, edges = "";
    for (var y = 0; y < EX.PY; y++) {
      var x = 0;
      while (x < EX.PX) {
        var o = EX.owner[y][x], x1 = x;
        while (x1 < EX.PX && EX.owner[y][x1] === o) x1++;
        fills[o] = (fills[o] || "") + "M" + f1(x0 + x * s) + " " + f1(y0 + y * s) + "h" + f1((x1 - x) * s) + "v" + f1(s) + "h" + f1(-(x1 - x) * s) + "Z";
        x = x1;
      }
      for (x = 0; x < EX.PX; x++) {
        if (x + 1 < EX.PX && EX.owner[y][x + 1] !== EX.owner[y][x]) edges += "M" + f1(x0 + (x + 1) * s) + " " + f1(y0 + y * s) + "v" + f1(s);
        if (y + 1 < EX.PY && EX.owner[y + 1][x] !== EX.owner[y][x]) edges += "M" + f1(x0 + x * s) + " " + f1(y0 + (y + 1) * s) + "h" + f1(s);
      }
    }
    var out = "";
    Object.keys(fills).forEach(function (k) {
      var c = +k, shade = [9, 15, 21, 12][c % 4];
      out += '<path class="ctm" d="' + fills[k] + '" style="fill: ' + (c === EX.cstar ? "var(--orange-soft)" : "color-mix(in srgb, var(--ink) " + shade + "%, var(--paper))") + '"/>';
    });
    out += '<path class="ctm-b" vector-effect="non-scaling-stroke" d="' + edges + '"/>';
    var grid = "", cs = EX.K * s;
    for (var gx = 0; gx <= EX.NC; gx++) grid += "M" + f1(x0 + gx * cs) + " " + f1(y0) + "v" + f1(EX.NR * cs);
    for (var gy = 0; gy <= EX.NR; gy++) grid += "M" + f1(x0) + " " + f1(y0 + gy * cs) + "h" + f1(EX.NC * cs);
    return { ctm: out, grid: '<path class="cellgrid" vector-effect="non-scaling-stroke" d="' + grid + '"/>' };
  }

  /* ------------------------------------------------------------ figures */
  var FIGS = {};

  // the annual mean runoff of the forcing on its coarse grid, as a world map of width wd at (wx, wy)
  var RUNOFF = RIVERS.runoff || null;
  // where the 8 x 6 example cells (2 x 1.5 degrees) sit on the world map: on the Mekong
  var SPOT = [104.5, 17];
  function worldMap(wx, wy, wd) {
    var R = RUNOFF, w = wd / R.nx, lv = unpackLevels(R.levels, R.ny, R.nx, 1), paths = {};
    for (var j = 0; j < R.ny; j++) {
      for (var i = 0; i < R.nx; i++) {
        var l = lv[j * R.nx + i];
        if (l) paths[l] = (paths[l] || "") + "M" + f1(wx + i * w) + " " + f1(wy + j * w) + "h" + f1(w) + "v" + f1(w) + "h" + f1(-w) + "Z";
      }
    }
    var s = w / R.deg, spot = [wx + (SPOT[0] + 180) * s, wy + (R.north - SPOT[1]) * s];
    return {
      svg: Object.keys(paths).map(function (k) { return '<path d="' + paths[k] + '"' + mix(16 + 72 * (k - 1) / 14) + "/>"; }).join(""),
      h: R.ny * w, spot: spot, spotW: 2 * s
    };
  }
  // the transform that shrinks a box of width w0 at (x0, y0) by z (0..1) onto a box of width w1 at (x1, y1)
  function shrink(x0, y0, w0, x1, y1, w1, z) {
    var sc = Math.exp(Math.log(w1 / w0) * z);
    return "translate(" + f1(x0 + (x1 - x0) * z - x0 * sc) + " " + f1(y0 + (y1 - y0) * z - y0 * sc) + ") scale(" + sc.toFixed(4) + ")";
  }

  // 01 the runoff grid: the cell seen from the side, its neighbours, then the whole world
  FIGS.grid = {
    build: function () {
      var cs = 45, x0 = 30, y0 = 54, out = [], dc = EX.dropCell;
      this.g = { cs: cs, x0: x0, y0: y0 };
      this.cells = EX.runoff.map(function (v, g) {
        var c = g % EX.NC, r = Math.floor(g / EX.NC);
        return { x: x0 + c * cs, y: y0 + r * cs, v: v, d: Math.hypot(c - dc % EX.NC, r - Math.floor(dc / EX.NC)) };
      });
      if (RUNOFF) {
        var wx = 10, wy = 84, wm = worldMap(wx, wy, 400), leg = "";
        this.w = wm;
        for (var k = 1; k <= 15; k++) leg += rect(wx + 214 + (k - 1) * 8, wy + wm.h + 18, 8, 6, "", mix(16 + 72 * (k - 1) / 14));
        out.push('<g data-r="world" opacity="0">' + wm.svg +
          txt(wx, wy - 14, "sm strong", "the whole grid: annual mean runoff, " + YEAR) + txt(wx, wy + wm.h + 24, "sm mut", "eartH2Observe WRR2, ECMWF HTESSEL") +
          leg + txt(wx + 208, wy + wm.h + 24, "sm mut", "0", "end") + txt(wx + 338, wy + wm.h + 24, "sm mut", RUNOFF.max_mm + "+ mm/day") + "</g>");
      }
      return { vb: "0 0 420 340", s: out.join("") };
    },
    after: function (svg) { this.world = svg.querySelector('[data-r="world"]'); },
    draw: function (p) {
      var g = this.g, out = [], dc = EX.dropCell, zoom = this.w ? smooth(p, 0.48, 0.8) : 0;
      if (this.world) this.world.setAttribute("opacity", f1(smooth(p, 0.5, 0.72)));
      // the example grid shrinks into its spot on the world map
      var W0 = EX.NC * g.cs, w = this.w, sx = w ? Math.exp(Math.log(w.spotW / W0) * zoom) : 1;
      var T = w ? shrink(g.x0, g.y0, W0, w.spot[0], w.spot[1], w.spotW, zoom) : "";
      var fade = 1 - smooth(p, 0.72, 0.82);
      if (fade > 0) {
        out.push('<g opacity="' + f1(fade) + '" transform="' + T + '">');
        this.cells.forEach(function (c, i) {
          var a = i === dc ? 1 : smooth(p, 0.05 + c.d * 0.045, 0.13 + c.d * 0.045), pct = 12 + (c.v - 1.2) / 4.4 * 62;
          if (a <= 0) return;
          out.push('<g opacity="' + f1(a) + '">' + rect(c.x + 0.5, c.y + 0.5, g.cs - 1, g.cs - 1, "cell", mix(pct)) +
            txt(c.x + g.cs / 2, c.y + g.cs / 2 + 4, "cellv" + (pct > 58 ? " halo" : ""), c.v.toFixed(1), "middle") + "</g>");
        });
        var c = this.cells[dc];
        out.push(rect(c.x + 1, c.y + 1, g.cs - 2, g.cs - 2, "blue-s", ' stroke-width="3"'));
        out.push(rect(g.x0, g.y0, EX.NC * g.cs, EX.NR * g.cs, "", ' style="fill: none; stroke: var(--ink-3)" stroke-width="' + f1(1 / sx) + '"'));
        out.push("</g>");
      }
      var lab = 1 - smooth(p, 0.46, 0.52);
      if (lab > 0) {
        var cc = this.cells[dc];
        out.push('<g opacity="' + f1(lab) + '">' + line(cc.x + g.cs / 2, cc.y, cc.x + g.cs / 2, g.y0 - 8, "blue-s") +
          txt(cc.x + g.cs / 2 - 6, g.y0 - 24, "halo strong", "one cell (g12)", "end") + txt(cc.x + g.cs / 2 + 6, g.y0 - 24, "sm mut halo", "the column seen from the side") +
          txt(g.x0, g.y0 + EX.NR * g.cs + 18, "mut", "0.25° cells") + txt(g.x0 + EX.NC * g.cs, g.y0 + EX.NR * g.cs + 18, "mut", "runoff, mm / day", "end") + "</g>");
      }
      if (zoom >= 1) out.push(rect(w.spot[0] - 2, w.spot[1] - 2, w.spotW + 4, 0.75 * w.spotW + 4, "blue-s", ' stroke-width="1.5"'));
      return out.join("");
    }
  };

  // 02 catchments on pixels: the drop's cell first, then the catchments over it
  FIGS.catch = {
    build: function () {
      var s = 8, x0 = 8, y0 = 8, layers = catchmentLayers(s, x0, y0);
      this.g = { s: s, x0: x0, y0: y0 };
      var out = [];
      out.push('<defs><pattern id="jr-dots" width="8" height="8" patternUnits="userSpaceOnUse" x="' + x0 + '" y="' + y0 + '"><circle class="dotpat" cx="4" cy="4" r="0.8"/></pattern></defs>');
      if (RUNOFF) {
        this.w = worldMap(10, 74, 380);
        out.push('<g data-r="world">' + this.w.svg + "</g>");
      }
      out.push('<g data-r="zoom"><g data-r="ctm" opacity="0">' + layers.ctm + rect(x0, y0, EX.PX * s, EX.PY * s, "", ' fill="url(#jr-dots)"') + "</g>" + layers.grid + "</g>");
      return { vb: "0 0 400 304", s: out.join("") };
    },
    after: function (svg) { this.ctm = svg.querySelector('[data-r="ctm"]'); this.zoom = svg.querySelector('[data-r="zoom"]'); this.world = svg.querySelector('[data-r="world"]'); },
    draw: function (p) {
      var g = this.g, out = [], cw = EX.K * g.s, dc = EX.dropCell;
      // from the world map of the previous figure back into the cells
      var z = this.w ? 1 - smooth(p, 0.3, 0.55) : 0, T = this.w ? shrink(g.x0, g.y0, EX.PX * g.s, this.w.spot[0], this.w.spot[1], this.w.spotW, z) : "";
      if (this.zoom) this.zoom.setAttribute("transform", T);
      if (this.world) this.world.setAttribute("opacity", f1(1 - smooth(p, 0.45, 0.56)));
      if (this.ctm) this.ctm.setAttribute("opacity", f1(smooth(p, 0.52, 0.62)));
      out.push('<g transform="' + T + '">');
      // the cell of the previous figure and the pixel the drop landed on
      var hold = 1 - smooth(p, 0.62, 0.68);
      if (hold > 0) {
        var cx = g.x0 + (dc % EX.NC) * cw, cy = g.y0 + Math.floor(dc / EX.NC) * cw;
        out.push('<g opacity="' + f1(hold) + '">' + rect(cx, cy, cw, cw, "blue-s", ' stroke-width="3"') + txt(cx + cw + 6, cy - 6, "halo strong", "one cell (g12)") + "</g>");
      }
      var dp = EX.dropPx;
      out.push('<path class="blue-f" transform="translate(' + f1(g.x0 + (dp[0] + 0.5) * g.s) + " " + f1(g.y0 + (dp[1] + 0.5) * g.s) + ') scale(0.55)" d="' + DROP + '"/>');
      var n = Math.round(smooth(p, 0.66, 0.95) * EX.pixels.length), counts = {}, cur = null;
      for (var i = 0; i < n; i++) {
        var px = EX.pixels[i], cell = Math.floor(px[1] / EX.K) * EX.NC + Math.floor(px[0] / EX.K);
        counts[cell] = (counts[cell] || 0) + 1;
        out.push(rect(g.x0 + px[0] * g.s + 1.5, g.y0 + px[1] * g.s + 1.5, g.s - 3, g.s - 3, "blue-f", ' opacity="0.75"'));
        cur = { px: px, cell: cell };
      }
      var el = document.querySelector('[data-r="wnow"]');
      if (!cur) { if (el) el.textContent = " "; return out.join("") + "</g>"; }
      var x = g.x0 + cur.px[0] * g.s, y = g.y0 + cur.px[1] * g.s;
      out.push(rect(x - 1, y - 1, g.s + 2, g.s + 2, "blue-f"));
      if (!NARROW) out.push(line(x + g.s + 2, y + g.s / 2, 404, y + g.s / 2, "ln") + '<path style="fill: var(--ink-2)" d="M404 ' + f1(y + g.s / 2 - 4) + "l7 4l-7 4z\"/>");
      var cc = cur.cell % EX.NC, cr = Math.floor(cur.cell / EX.NC);
      out.push(rect(g.x0 + cc * cw, g.y0 + cr * cw, cw, cw, "blue-s", ' stroke-width="2.5"'));
      if (el) el.textContent = "W[c" + EX.cstar + ", g" + cur.cell + "] = " + counts[cur.cell] + " × pixel area";
      return out.join("") + "</g>";
    }
  };

  // 03 the sparse matrix, and the row of the orange catchment as a weighted sum
  FIGS.matrix = {
    build: function (narrow) {
      var out = [], sp = 7, mapS = 0.42 * 8, mx, my, W2, map0;
      if (narrow) { mx = 28; my = 182; W2 = 370; map0 = [0, 4]; } else { mx = 214; my = 46; W2 = 570; map0 = [0, 46]; }
      var eqY = my + EX.NCAT * sp + 40;
      out.push("<g>" + catchmentPaths(mapS, map0[0], map0[1]) + "</g>");
      var capX = narrow ? 176 : 0, capY = narrow ? 40 : map0[1] + EX.PY * mapS + 18;
      out.push(txt(capX, capY, "sm", "here: " + EX.nnz + " of " + EX.NCAT * EX.NC * EX.NR + " entries,") + txt(capX, capY + 13, "sm", "max " + EX.maxRow + " per row"));
      out.push(txt(mx, my - 22, "disp", "W") + txt(mx + 20, my - 22, "sm", "catchments × cells"));
      out.push(txt(mx + 48 * sp, my - 22, "sm mut", "rows: 24 catchments", "end") + txt(mx + 48 * sp, my - 10, "sm mut", "columns: 48 runoff cells", "end"));
      var dots = "";
      for (var r = 0; r < EX.NCAT; r++) for (var c = 0; c < 48; c++) dots += "M" + f1(mx + c * sp) + " " + f1(my + r * sp) + "h0.01";
      out.push('<path d="' + dots + '" stroke-linecap="round" style="stroke: color-mix(in srgb, var(--ink) 30%, var(--paper)); stroke-width: 1.3"/>');
      for (r = 0; r < EX.NCAT; r += 3) out.push(txt(mx - 8, my + r * sp + 3.5, "sm mut", "c" + r, "end"));
      for (c = 0; c < 48; c += 8) out.push(txt(mx + c * sp, my + EX.NCAT * sp + 12, "sm mut", "g" + c, "middle"));
      this.g = { mx: mx, my: my, sp: sp, mapS: mapS, map0: map0, eqY: eqY, eqX: 0 };
      return { vb: "0 0 " + W2 + " " + (eqY + (narrow ? 62 : 46)), s: out.join("") };
    },
    draw: function (p) {
      var g = this.g, out = [], rows = smooth(p, 0.04, 0.55) * (EX.NCAT + 0.999), ex = smooth(p, 0.6, 0.66);
      if (ex > 0) out.push(rect(g.mx - 5, g.my + EX.cstar * g.sp - 4, 48 * g.sp + 6, g.sp + 1, "", ' rx="2" style="fill: var(--orange-soft)" opacity="' + f1(ex) + '"'));
      for (var r = 0; r < Math.min(EX.NCAT, Math.floor(rows)); r++) {
        for (var c = 0; c < 48; c++) {
          var w = EX.W[r][c];
          if (!w) continue;
          var sz = 1.6 + 4.4 * Math.sqrt(w / EX.wmax);
          out.push(rect(g.mx + c * g.sp - sz / 2, g.my + r * g.sp - sz / 2, sz, sz, r === EX.cstar ? "or-f" : "blue-f"));
        }
      }
      if (ex <= 0) return out.join("");
      // the example: which cells the orange catchment adds up, with how many pixels each
      var shown = Math.round(smooth(p, 0.66, 0.92) * EX.row.length), cw = EX.K * g.mapS, terms = [];
      EX.row.forEach(function (e, i) {
        var gc = e[0], x = g.map0[0] + (gc % EX.NC) * cw, y = g.map0[1] + Math.floor(gc / EX.NC) * cw;
        var on = i < shown;
        out.push(rect(x + 0.6, y + 0.6, cw - 1.2, cw - 1.2, on ? "or-s" : "ln-3", ' stroke-width="' + (on ? 2 : 1) + '"'));
        if (on) {
          out.push(txt(x + cw / 2, y + cw / 2 + 3.5, "sm strong halo", String(e[1]), "middle"));
          terms.push(e[1] + "·" + EX.runoff[gc].toFixed(1));
        }
      });
      out.push(txt(g.eqX, g.eqY, "sm", "inflow of c" + EX.cstar + " = Σ W[c" + EX.cstar + ", g] · runoff[g]  (pixels × mm/day)"));
      if (terms.length) {
        var sum = shown === EX.row.length ? " = " + Math.round(EX.row.reduce(function (a, e) { return a + e[1] * EX.runoff[e[0]]; }, 0)) : "";
        var cut = NARROW ? 4 : terms.length;
        out.push(txt(g.eqX, g.eqY + 18, "or strong", "= " + terms.slice(0, cut).join(" + ") + (terms.length > cut ? " +" : sum)));
        if (terms.length > cut) out.push(txt(g.eqX + 14, g.eqY + 34, "or strong", terms.slice(cut).join(" + ") + sum));
      }
      return out.join("");
    }
  };

  // 09 input and output run beside the GPU: loaders, the GPU, writers
  FIGS.io = {
    LANES: ["loader 1", "loader 2", "GPU", "writer 1", "writer 2"],
    build: function (narrow) {
      var W = narrow ? 400 : 600, out = [];
      var g = { W: W, top: 34, nodeH: 132, gx0: 84, gx1: W - 10, gy: 214, rh: 22 };
      g.col = narrow ? [8, 70, 150, 270, 346] : [10, 104, 214, 410, 520];
      g.wid = narrow ? [52, 62, 106, 62, 50] : [70, 82, 170, 82, 70];
      this.g = g;
      var c = g.col, w = g.wid, y0 = g.top, h = g.nodeH;
      // disks
      [[c[0], "runoff", "files"], [c[4], "NetCDF", "output"]].forEach(function (d, i) {
        var x = d[0], ww = w[i ? 4 : 0], cy = y0 + 30;
        out.push('<path class="disk" d="M' + x + " " + cy + "v" + (h - 60) + "a" + ww / 2 + " 9 0 0 0 " + ww + " 0v" + -(h - 60) + '"/>');
        out.push('<ellipse class="disk" cx="' + (x + ww / 2) + '" cy="' + cy + '" rx="' + ww / 2 + '" ry="9"/>');
        out.push(txt(x + ww / 2, y0 + h - 4, "sm strong", d[1], "middle") + txt(x + ww / 2, y0 + h + 9, "sm mut", d[2], "middle"));
      });
      // CPU worker processes
      [[c[1], w[1], "loader"], [c[3], w[3], "writer"]].forEach(function (k) {
        for (var i = 0; i < 2; i++) out.push(rect(k[0], y0 + 6 + i * 64, k[1], 52, "cellbox", ' rx="8"') + txt(k[0] + 8, y0 + 20 + i * 64, "sm mut", k[2] + " " + (i + 1)));
      });
      out.push(txt(c[1] + w[1] / 2, y0 - 8, "sm mut", "CPU", "middle") + txt(c[3] + w[3] / 2, y0 - 8, "sm mut", "CPU", "middle"));
      // the GPU
      out.push(rect(c[2], y0 - 6, w[2], h + 6, "card", ' rx="14"'));
      out.push(txt(c[2] + 12, y0 + 10, "bl strong", "GPU") + txt(c[2] + w[2] - 10, y0 + 10, "sm mut", "prefetched", "end"));
      out.push(txt(c[2] + w[2] / 2, y0 + 104, "sm mut", narrow ? "runoff → river" : "runoff · Wᵀ → river model", "middle"));
      // timeline
      out.push(txt(g.gx0, g.gy - 14, "sm", narrow ? "busy time" : "what each process is busy with"));
      this.LANES.forEach(function (name, i) {
        out.push(txt(g.gx0 - 8, g.gy + i * g.rh + 14, "sm" + (i === 2 ? " bl strong" : " mut"), name, "end"));
      });
      out.push(rect(g.gx0, g.gy, g.gx1 - g.gx0, 5 * g.rh, "", ' style="fill: none; stroke: var(--rule)"'));
      return { vb: "0 0 " + W + " " + (g.gy + 5 * g.rh + 22), s: out.join("") };
    },
    // the schedule of day k in GPU-day units: read, wait on the GPU, compute, write
    day: function (k) { return { lane: k % 2, read: [k - 2.4, k - 0.6], gpu: [k, k + 1], write: [k + 1, k + 2.8] }; },
    label: function (k) { var t = new Date(Date.UTC(YEAR, 0, 1 + ((k % 366) + 366) % 366)); return MONTHS[t.getUTCMonth()] + " " + t.getUTCDate(); },
    packet: function (x, y, k, cls) {
      return rect(x - 21, y - 9, 42, 18, "pk" + (cls ? " " + cls : ""), ' rx="4"') + txt(x, y + 3.5, "pkt", this.label(k), "middle");
    },
    draw: function (p, now) {
      var g = this.g, out = [], t = (REDUCED ? 6.4 : now / 1000 * 0.7) % 3660, self = this, c = g.col, w = g.wid, y0 = g.top;
      var slotY = [y0 + 32, y0 + 96], inQ = [], cur = null;
      for (var k = Math.floor(t) - 4; k <= Math.floor(t) + 4; k++) {
        var s = this.day(k), lx = c[1] + w[1] / 2, ly = slotY[s.lane], wx = c[3] + w[3] / 2;
        if (t >= s.read[0] && t < s.read[1]) {
          var u = (t - s.read[0]) / (s.read[1] - s.read[0]);
          var from = [c[0] + w[0] / 2, y0 + 66], at = u < 0.15 ? along([from, [lx, ly]], u / 0.15) : [lx, ly];
          out.push(this.packet(at[0], at[1], k));
          out.push(rect(c[1] + 8, slotY[s.lane] + 13, (w[1] - 16) * u, 3, "blue-f"));
        } else if (t >= s.read[1] && t < s.gpu[0]) {
          inQ.push(k);
        } else if (t >= s.gpu[0] && t < s.gpu[1]) {
          cur = k;
        } else if (t >= s.write[0] && t < s.write[1]) {
          var v = (t - s.write[0]) / (s.write[1] - s.write[0]);
          var gp = [c[2] + w[2] / 2, y0 + 62], at2 = v < 0.15 ? along([gp, [wx, ly]], v / 0.15) : [wx, ly];
          out.push(this.packet(at2[0], at2[1], k, "out"));
          out.push(rect(c[3] + 8, slotY[s.lane] + 13, (w[3] - 16) * v, 3, "or-f"));
        } else if (t >= s.write[1] && t < s.write[1] + 0.35) {
          var e = (t - s.write[1]) / 0.35, pt = along([[wx, ly], [c[4] + w[4] / 2, y0 + 66]], e);
          out.push('<g opacity="' + f1(1 - e) + '">' + this.packet(pt[0], pt[1], k, "out") + "</g>");
        }
      }
      // waiting on the GPU, then the day being computed
      inQ.forEach(function (k, i) { out.push(self.packet(c[2] + 30, y0 + 34 + i * 22, k)); });
      if (cur !== null) {
        var f = t - cur, cx = c[2] + w[2] / 2 + 22, cy = y0 + 62, r = 20;
        out.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" style="fill: none; stroke: var(--rule); stroke-width: 4"/>');
        var a = 2 * Math.PI * f;
        out.push('<path class="blue-s" style="stroke-width: 4" d="M' + cx + " " + (cy - r) + "A" + r + " " + r + " 0 " + (f > 0.5 ? 1 : 0) + " 1 " + f1(cx + r * Math.sin(a)) + " " + f1(cy - r * Math.cos(a)) + '"/>');
        out.push(txt(cx, cy + 4, "sm strong", this.label(cur), "middle"));
      }
      // the timeline: a window around now
      var span = NARROW ? 3 : 4, X = function (u) { return g.gx0 + (g.gx1 - g.gx0) * (0.5 + (u - t) / (2 * span)); };
      out.push('<clipPath id="io-clip"><rect x="' + g.gx0 + '" y="' + g.gy + '" width="' + (g.gx1 - g.gx0) + '" height="' + 5 * g.rh + '"/></clipPath><g clip-path="url(#io-clip)">');
      for (k = Math.floor(t - span) - 3; k <= Math.floor(t + span) + 3; k++) {
        var d = this.day(k);
        [[d.lane, d.read, "blue-soft-f"], [2, d.gpu, "blue-f"], [3 + d.lane, d.write, "or-soft-f"]].forEach(function (b) {
          var x0 = X(b[1][0]) + 1, x1 = X(b[1][1]) - 1, y = g.gy + b[0] * g.rh + 3;
          out.push(rect(x0, y, x1 - x0, g.rh - 6, b[2], ' rx="3"'));
          if (x1 - x0 > 34) out.push(txt((x0 + x1) / 2, y + 12, "pkt" + (b[0] === 2 ? " inv" : ""), self.label(k), "middle"));
        });
      }
      out.push("</g>" + line(X(t), g.gy - 4, X(t), g.gy + 5 * g.rh + 4, "ln") + txt(X(t), g.gy + 5 * g.rh + 16, "sm strong", "now", "middle"));
      return out.join("");
    },
    animated: true
  };

  // polylines packed by tools/home_data.py: uint16 x, y, steps, uint8 meta, then int8 dx, dy per step
  function polylines(b64, perDeg) {
    var bin = atob(b64 || ""), i = 0, out = [];
    function u16() { i += 2; return bin.charCodeAt(i - 2) | bin.charCodeAt(i - 1) << 8; }
    function s8() { var v = bin.charCodeAt(i++); return v > 127 ? v - 256 : v; }
    while (i < bin.length) {
      var x = u16(), y = u16(), steps = u16(), meta = bin.charCodeAt(i++), pts = [[x / perDeg - 180, 90 - y / perDeg]];
      for (var s = 0; s < steps; s++) { x += s8(); y += s8(); pts.push([x / perDeg - 180, 90 - y / perDeg]); }
      out.push({ meta: meta, pts: pts });
    }
    return out;
  }

  // rows of 4-bit levels packed as runs (pack_levels in tools/home_data.py), times k
  function unpackLevels(b64, rows, len, k) {
    var bin = atob(b64 || ""), i = 0, out = new Uint8Array(rows * len);
    for (var r = 0; r < rows && i < bin.length; r++) {
      var lv = bin.charCodeAt(i++), at = 0;
      while (at < len) {
        var b = bin.charCodeAt(i++), end = Math.min(len, at + (b >> 2) + 1), code = b & 3;
        out.fill(k * lv, r * len + at, r * len + end);
        at = end;
        lv = code === 0 ? lv + 1 : code === 1 ? lv - 1 : code === 2 ? bin.charCodeAt(i++) : lv;
      }
    }
    return out;
  }

  // the river network data, shared by the hero map and the two map figures: one entry per reach
  var RV = (function () {
    var per = RIVERS.per_deg || 20, days = RIVERS.days || 366, reaches = polylines(RIVERS.net, per), n = reaches.length;
    var q = RIVERS.q ? unpackLevels(RIVERS.q, n, days, 17) : null;
    return {
      n: n, q: q, days: days, qlog: RIVERS.qlog || [0, 5],
      pts: reaches.map(function (r) { return r.pts; }),
      lvl: reaches.map(function (r) { return r.meta & 7; }),
      gpu: reaches.map(function (r) { return r.meta >> 3; }),
      stems: (RIVERS.stems || []).map(function (s) { return { name: s.name, pts: polylines(s.path, per)[0].pts }; }),
      fine: (function () {
        // the larger rivers' daily discharge in finer steps between their own low and high
        var F = RIVERS.fine;
        if (!F) return null;
        var at = new Int32Array(n).fill(-1);
        F.reaches.forEach(function (r, i) { at[r] = i; });
        return { at: at, lo: F.lo, hi: F.hi, steps: F.steps, lv: unpackLevels(F.q, F.reaches.length, days, 1) };
      })()
    };
  })();

  // figures 05 and 08: the world's rivers as SVG
  var MAP = { lon0: -170, lon1: 180, lat0: 82, lat1: -56, k: 1.8 };
  function mapXY(lon, lat) { return [(lon - MAP.lon0) * MAP.k, (MAP.lat0 - lat) * MAP.k]; }
  function mapBox() { var a = mapXY(MAP.lon1, MAP.lat1); return "0 0 " + f1(a[0]) + " " + f1(a[1]); }
  var WIDTHS = [0.45, 0.7, 1.0, 1.45, 2.1];
  var GROUPS = null;
  function riverGroups() {
    // one path per (gpu, level)
    if (GROUPS) return GROUPS;
    var by = {};
    for (var i = 0; i < RV.n; i++) {
      var k = RV.gpu[i] + ":" + RV.lvl[i];
      by[k] = (by[k] || "") + "M" + RV.pts[i].map(function (c) { var s = mapXY(c[0], c[1]); return f1(s[0]) + " " + f1(s[1]); }).join("L");
    }
    GROUPS = Object.keys(by).map(function (k) { var p = k.split(":"); return { g: +p[0], l: +p[1], d: by[k] }; });
    GROUPS.sort(function (a, b) { return a.l - b.l; });
    return GROUPS;
  }

  // where each main stem is named: a fraction along it from the source, and the side of the label
  var STEM_LABEL = { Ob: [0.6, "end"], Yenisei: [0.55], Lena: [0.6], Amur: [0.55], Yangtze: [0.7, "end"], Mekong: [0.45], Ganges: [0.6, "end"], Volga: [0.5, "end"], Danube: [0.5, "end"], Nile: [0.6], Niger: [0.45, "end"], Congo: [0.55], Amazon: [0.55], "Paraná": [0.5], Mississippi: [0.4], Mackenzie: [0.3], Yukon: [0.5], Murray: [0.5, "end"] };

  FIGS.network = {
    build: function () {
      var out = [];
      riverGroups().forEach(function (p) {
        out.push('<path class="river" data-l="' + p.l + '" d="' + p.d + '" style="stroke: color-mix(in srgb, var(--ink) ' + (34 + p.l * 8) + '%, var(--paper)); stroke-width: ' + WIDTHS[Math.min(p.l, 4)] + '"/>');
      });
      this.stems = RV.stems.map(function (s) {
        var pts = s.pts.map(function (c) { return mapXY(c[0], c[1]); }), lab = STEM_LABEL[s.name] || [0.5], at = along(pts, lab[0]);
        out.push('<path class="drop-path" data-r="stem" d="M' + pts.map(function (q) { return f1(q[0]) + " " + f1(q[1]); }).join("L") + '"/>');
        out.push('<text class="ital halo stem-l" data-r="stem-l" x="' + f1(at[0] + (lab[1] ? -6 : 6)) + '" y="' + f1(at[1] + 4) + '"' + (lab[1] ? ' text-anchor="end"' : "") + ">" + esc(s.name) + "</text>");
        return { pts: pts };
      });
      return { vb: mapBox(), s: out.join("") };
    },
    after: function (svg) {
      this.rivers = svg.querySelectorAll(".river");
      var paths = svg.querySelectorAll('[data-r="stem"]'), labels = svg.querySelectorAll('[data-r="stem-l"]');
      this.stems.forEach(function (s, i) {
        s.el = paths[i]; s.label = labels[i]; s.len = s.el.getTotalLength();
        s.el.style.strokeDasharray = s.len + " " + s.len;
      });
      this.shown = null;
    },
    draw: function (p) {
      var key = Math.round(p * 200);
      if (this.shown !== key) {
        this.shown = key;
        for (var i = 0; i < this.rivers.length; i++) {
          var l = +this.rivers[i].getAttribute("data-l");
          this.rivers[i].style.opacity = p >= (4 - l) * 0.06 ? 1 : 0;
        }
      }
      // the main stems, traced from source to sea one after another
      var out = [], n = this.stems.length;
      this.stems.forEach(function (s, i) {
        var a = 0.24 + 0.4 * i / Math.max(1, n - 1), q = smooth(p, a, a + 0.18);
        s.el.style.strokeDashoffset = String(s.len * (1 - q));
        s.label.style.opacity = q >= 1 ? 1 : 0;
        if (q > 0 && q < 1) {
          var head = along(s.pts, q);
          out.push('<path class="blue-f" transform="translate(' + f1(head[0]) + " " + f1(head[1] - 2) + ') scale(0.6)" d="' + DROP + '"/>');
        }
      });
      return out.join("");
    }
  };

  FIGS.gpus = {
    build: function () {
      var out = [];
      riverGroups().forEach(function (p) {
        out.push('<path class="river" data-g="' + p.g + '" d="' + p.d + '" style="stroke: var(--g' + (p.g % 4) + "); stroke-width: " + WIDTHS[Math.min(p.l, 4)] + '"/>');
      });
      var foot = document.querySelector('[data-fig="gpus"] .gpus');
      var gp = RIVERS.gpus || [], tot = gp.reduce(function (a, g) { return a + g; }, 0) || 1;
      if (foot) {
        foot.innerHTML = '<div class="row">' + gp.map(function (g, i) {
          return '<span style="--c: var(--g' + (i % 4) + ')"><b>GPU ' + i + "</b>" + Math.round(100 * g / tot) + "% of catchments</span>";
        }).join("") + "</div><code>$ torchrun --nproc_per_node=" + gp.length + " run_daily_bin.py</code>";
      }
      return { vb: mapBox(), s: out.join("") };
    },
    after: function (svg) { this.rivers = svg.querySelectorAll(".river"); this.shown = null; },
    draw: function (p) {
      var n = (RIVERS.gpus || []).length || 4, key = Math.round(p * 100);
      if (this.shown === key) return "";
      this.shown = key;
      for (var i = 0; i < this.rivers.length; i++) {
        var g = +this.rivers[i].getAttribute("data-g");
        this.rivers[i].style.opacity = p >= 0.06 + g * (0.62 / n) ? 1 : 0.1;
      }
      return "";
    },
    keep: true
  };

  // an arrow head at (x, y) pointing along angle a (radians)
  function head(x, y, a, cls) {
    var c = Math.cos(a), s = Math.sin(a);
    function p(u, v) { return f1(x + u * c - v * s) + " " + f1(y + u * s + v * c); }
    return '<path class="' + cls + '" d="M' + p(0, 0) + "L" + p(-8, -4.5) + "L" + p(-8, 4.5) + 'Z"/>';
  }
  // a path drawn to fraction f, with its head once complete
  function grow(d, f, cls, tip) {
    if (f <= 0) return "";
    return '<path class="arrow ' + cls + '" d="' + d + '" pathLength="100" stroke-dasharray="100" stroke-dashoffset="' + f1(100 * (1 - f)) + '"/>' +
      (f >= 1 && tip ? head(tip[0], tip[1], tip[2], cls.replace("-s", "-f")) : "");
  }

  // 00 a land surface model splits the rain; one drop goes the whole way
  FIGS.lsm = {
    build: function () {
      var out = [], g = { x0: 20, xb: 470, xc: 528, x1: 640, sky: 186, bed: 216, bot: 320 };
      g.ys = function (x) { return x <= g.xb ? 176 + 10 * (x - g.x0) / (g.xb - g.x0) : 184; };
      this.g = g;
      out.push('<defs><linearGradient id="lsm-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color: var(--blue-soft)"/><stop offset="1" style="stop-color: var(--paper)"/></linearGradient>' +
        '<linearGradient id="lsm-wet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color: var(--blue); stop-opacity: 0.32"/><stop offset="1" style="stop-color: var(--blue); stop-opacity: 0"/></linearGradient></defs>');
      out.push(rect(g.x0, 0, g.x1 - g.x0, g.sky, "", ' fill="url(#lsm-sky)"'));
      // cloud
      out.push('<g class="cloud">' + [[236, 58, 17], [262, 44, 24], [298, 36, 30], [334, 48, 22], [360, 60, 14]].map(function (c) {
        return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"/>';
      }).join("") + rect(222, 52, 150, 22, "", ' rx="11"') + "</g>");
      out.push(txt(388, 40, "sm mut", "precipitation"));
      // soil layers, cut by the stream
      function band(top, bottom, cls) {
        return '<path class="' + cls + '" d="M' + g.x0 + " " + f1(g.ys(g.x0) + top) + "L" + g.xb + " " + f1(g.ys(g.xb) + top) + "L" + g.x1 + " " + f1(g.ys(g.x1) + top) +
          "V" + f1(bottom === null ? g.bot : g.ys(g.x1) + bottom) + "L" + g.xb + " " + f1(bottom === null ? g.bot : g.ys(g.xb) + bottom) + "L" + g.x0 + " " + f1(bottom === null ? g.bot : g.ys(g.x0) + bottom) + 'Z"/>';
      }
      out.push(band(0, 32, "soil") + band(32, 78, "soil-2") + band(78, null, "soil-3"));
      out.push('<path style="fill: var(--paper)" d="M' + g.xb + " " + g.ys(g.xb) + "L" + (g.xb + 7) + " " + g.bed + "H" + (g.xc - 7) + "L" + g.xc + " " + g.ys(g.xc) + 'Z"/>');
      out.push('<path class="water" d="M' + (g.xb + 4.6) + " 202L" + (g.xb + 7) + " " + g.bed + "H" + (g.xc - 7) + "L" + (g.xc - 4.6) + ' 202Z"/>');
      out.push('<path class="ln" d="M' + g.x0 + " " + g.ys(g.x0) + "L" + g.xb + " " + g.ys(g.xb) + "L" + (g.xb + 7) + " " + g.bed + "H" + (g.xc - 7) + "L" + g.xc + " " + g.ys(g.xc) + "H" + g.x1 + '"/>');
      out.push(txt(g.x0 + 8, g.ys(g.x0) + 22, "sm mut", "topsoil") + txt(g.x0 + 8, g.ys(g.x0) + 60, "sm mut", "root zone") + txt(g.x0 + 8, g.ys(g.x0) + 110, "sm mut", "deep soil"));
      out.push(txt(g.xc + 6, g.bed + 6, "sm bl", "stream"));
      // trees with roots, and grass
      [[76, 1], [132, 0.8], [196, 0.65]].forEach(function (t) {
        var x = t[0], s = t[1], y = g.ys(x);
        out.push('<path class="root" d="M' + x + " " + y + "l-10 " + f1(26 * s) + "M" + x + " " + y + "l4 " + f1(40 * s) + "M" + x + " " + y + "l12 " + f1(24 * s) + '"/>');
        out.push(rect(x - 2.2 * s, y - 34 * s, 4.4 * s, 34 * s, "trunk"));
        out.push('<g class="canopy"><circle cx="' + x + '" cy="' + f1(y - 46 * s) + '" r="' + f1(18 * s) + '"/><circle cx="' + f1(x - 13 * s) + '" cy="' + f1(y - 34 * s) + '" r="' + f1(12 * s) + '"/><circle cx="' + f1(x + 13 * s) + '" cy="' + f1(y - 34 * s) + '" r="' + f1(12 * s) + '"/></g>');
      });
      var grass = "";
      for (var x = 214; x < g.xb - 4; x += 11) grass += "M" + x + " " + f1(g.ys(x)) + "l-2 -6M" + (x + 3) + " " + f1(g.ys(x + 3)) + "l2 -7";
      out.push('<path d="' + grass + '" style="stroke: var(--g2); stroke-width: 1; fill: none"/>');
      var rnd = rng(5), st = [];
      for (var i = 0; i < 34; i++) st.push({ x: 228 + rnd() * 140, ph: rnd(), v: 0.6 + rnd() * 0.3, len: 7 + rnd() * 7 });
      this.st = st;
      return { vb: "0 0 640 330", s: out.join("") };
    },
    draw: function (p, now) {
      var g = this.g, out = [], t = REDUCED ? 0.4 : now / 1000;
      this.st.forEach(function (s) {
        var top = 76, span = g.ys(s.x) - top, y = top + ((t * s.v * 180 + s.ph * span) % span);
        if (y + s.len < g.ys(s.x)) out.push(line(s.x, y, s.x - 1.5, y + s.len, "rain"));
      });
      var fall = smooth(p, 0.04, 0.22), et = smooth(p, 0.24, 0.38), inf = smooth(p, 0.32, 0.48), sur = smooth(p, 0.46, 0.64), sub = smooth(p, 0.6, 0.78), done = smooth(p, 0.8, 0.9);
      // the soil wets as water infiltrates
      if (inf > 0) out.push('<path fill="url(#lsm-wet)" d="M224 ' + f1(g.ys(224)) + "L" + (g.xb - 6) + " " + f1(g.ys(g.xb - 6)) + "V" + f1(g.ys(g.xb) + 80 * inf) + "L224 " + f1(g.ys(224) + 80 * inf) + 'Z"/>');
      out.push(grow("M150 112C158 92 146 76 156 56", et, "or-s", [156, 56, -1.4]));
      out.push(grow("M300 " + f1(g.ys(300) - 4) + "C304 160 290 140 300 116", et, "or-s", [300, 116, -1.55]));
      if (et >= 1) out.push(txt(164, 64, "sm or halo", "evaporation and") + txt(164, 76, "sm or halo", "transpiration"));
      [250, 280].forEach(function (x) { out.push(grow("M" + x + " " + f1(g.ys(x) + 4) + "V" + f1(g.ys(x) + 58), inf, "blue-s", [x, g.ys(x) + 58, Math.PI / 2])); });
      if (inf >= 1) out.push(txt(290, g.ys(290) + 44, "sm bl halo", "infiltration"));
      out.push(grow("M340 " + f1(g.ys(340) - 7) + "L" + (g.xb - 4) + " " + f1(g.ys(g.xb) - 7), sur, "blue-s", [g.xb - 4, g.ys(g.xb) - 7, 0.07]));
      if (sur >= 1) out.push(txt(360, g.ys(360) - 14, "sm bl halo", "surface runoff"));
      out.push(grow("M300 " + f1(g.ys(300) + 100) + "C380 " + f1(g.ys(380) + 100) + " 470 270 486 " + (g.bed - 2), sub, "blue-s", [486, g.bed - 2, -1.2]));
      if (sub >= 1) out.push(txt(330, g.ys(330) + 92, "sm bl halo", "subsurface runoff"));
      // the drop: falls from the cloud, then runs off over the surface into the stream
      var dx, dy;
      if (fall < 1) { dx = 330; dy = 78 + (g.ys(330) - 84) * fall * fall; }
      else if (sur <= 0) { dx = 330; dy = g.ys(330) - 6; }
      else { var a = along([[330, g.ys(330) - 6], [g.xb, g.ys(g.xb) - 6], [g.xb + 20, 198]], sur); dx = a[0]; dy = a[1]; }
      if (p > 0.02) out.push('<path class="blue-f drop" transform="translate(' + f1(dx) + " " + f1(dy) + ') scale(0.9)" d="' + DROP + '"/>');
      if (fall >= 1 && sur <= 0) out.push('<ellipse class="blue-s" cx="330" cy="' + f1(g.ys(330)) + '" rx="' + f1(6 + 10 * et) + '" ry="2.4" opacity="' + f1(1 - et) + '"/>');
      if (done > 0) {
        var sx = (g.xb + g.xc) / 2;
        out.push('<g opacity="' + f1(done) + '">' + txt(sx, 118, "strong", "runoff", "middle") + txt(sx, 131, "sm mut", "to CaMa-Flood", "middle") +
          line(sx, 138, sx, 186, "ln-3") + head(sx, 192, Math.PI / 2, "ink3-f") + "</g>");
      }
      return out.join("");
    },
    animated: true
  };

  // the unit catchments and rivers around the Amazon at Manacapuru on 1-arcmin pixels (tools/home_data.py)
  var PLAN = (function () {
    var P = HYDRO.plan;
    if (!P) return null;
    var bin = atob(P.ids), ids = new Uint8Array(P.nx * P.ny), j = 0, n = 0;
    for (var i = 0; i < bin.length; i += 2) { ids.fill(bin.charCodeAt(i), j, j + bin.charCodeAt(i + 1)); j += bin.charCodeAt(i + 1); n = Math.max(n, bin.charCodeAt(i)); }
    // daily discharge of each catchment between its low and high water of the year, which colours its rivers
    var days = MANACAPURU.outflow.length || 366;
    return { P: P, ids: ids, rivers: polylines(P.rivers, P.per_deg), days: days, q: P.q ? unpackLevels(P.q, n, days, 17) : null };
  })();
  function planView(s, x0, y0) {
    var P = PLAN.P, ids = PLAN.ids, fills = {}, edges = "", sum = {};
    function at(lon, lat) { return [x0 + (lon - P.west) * P.per_deg * s, y0 + (P.north - lat) * P.per_deg * s]; }
    for (var y = 0; y < P.ny; y++) {
      for (var x = 0; x < P.nx;) {
        var o = ids[y * P.nx + x], x1 = x;
        while (x1 < P.nx && ids[y * P.nx + x1] === o) x1++;
        if (o) fills[o] = (fills[o] || "") + "M" + f1(x0 + x * s) + " " + f1(y0 + y * s) + "h" + f1((x1 - x) * s) + "v" + f1(s) + "h" + f1(-(x1 - x) * s) + "Z";
        var c = sum[o] || (sum[o] = [0, 0, 0]);
        c[0] += (x + x1) / 2 * (x1 - x); c[1] += (y + 0.5) * (x1 - x); c[2] += x1 - x;
        x = x1;
      }
      for (x = 0; x < P.nx; x++) {
        var v = ids[y * P.nx + x];
        if (x + 1 < P.nx && ids[y * P.nx + x + 1] !== v) edges += "M" + f1(x0 + (x + 1) * s) + " " + f1(y0 + y * s) + "v" + f1(s);
        if (y + 1 < P.ny && ids[(y + 1) * P.nx + x] !== v) edges += "M" + f1(x0 + x * s) + " " + f1(y0 + (y + 1) * s) + "h" + f1(s);
      }
    }
    var out = "";
    Object.keys(fills).forEach(function (k) { out += '<path class="' + (+k === P.station ? "plan-i" : +k === P.down ? "plan-d" : "plan") + '" d="' + fills[k] + '"/>'; });
    out += '<path class="plan-edge" d="' + edges + '"/>';
    var WIDTH = [0.7, 1.5, 3.4];
    PLAN.rivers.forEach(function (r) {
      out += '<path class="plan-river" data-r="plan-river" style="stroke-width: ' + WIDTH[r.meta] + '" d="M' + r.pts.map(function (q) { var a = at(q[0] + 0.5 / P.per_deg, q[1] - 0.5 / P.per_deg); return f1(a[0]) + " " + f1(a[1]); }).join("L") + '"/>';
    });
    var o1 = at(P.outlets[0][0], P.outlets[0][1]), o2 = at(P.outlets[1][0], P.outlets[1][1]);
    out += '<circle class="outlet" cx="' + f1(o1[0]) + '" cy="' + f1(o1[1]) + '" r="4"/><circle class="outlet" cx="' + f1(o2[0]) + '" cy="' + f1(o2[1]) + '" r="4"/>';
    // a longitude-latitude frame
    out += rect(x0, y0, P.nx * s, P.ny * s, "", ' style="fill: none; stroke: var(--ink-3)"');
    var east = P.west + P.nx / P.per_deg, south = P.north - P.ny / P.per_deg, deg = function (v, pos, neg) { return Math.abs(Math.round(v * 10) / 10) + "°" + (v >= 0 ? pos : neg); };
    for (var lo = Math.ceil(P.west * 2) / 2; lo <= east; lo += 0.5) {
      var tx = at(lo, P.north)[0];
      out += line(tx, y0 + P.ny * s, tx, y0 + P.ny * s + 4, "ln-3") + txt(tx, y0 + P.ny * s + 14, "sm mut", deg(lo, "E", "W"), "middle");
    }
    for (var la = Math.ceil(south * 2) / 2; la <= P.north; la += 0.5) {
      var ty = at(P.west, la)[1];
      out += line(x0 - 4, ty, x0, ty, "ln-3") + txt(x0 - 6, ty + 3, "sm mut", deg(la, "N", "S"), "end");
    }
    function cen(k) { var c = sum[k] || [0, 0, 1]; return [x0 + c[0] / c[2] * s, y0 + c[1] / c[2] * s]; }
    return { svg: out, o1: o1, o2: o2, ci: cen(P.station), cd: cen(P.down) };
  }

  // 04 storage and flow: unit catchments in plan, a cross-section with its flood table, the discharge
  FIGS.physics = {
    build: function (narrow) {
      var S = MANACAPURU, out = [], W = narrow ? 400 : 600, table = S.flood_table_m, tmax = table[table.length - 1] || 1;
      var top = narrow ? 210 : 196;
      var g = { W: W, cx: narrow ? 150 : 170, chw: 16, fw: narrow ? 118 : 138, y0: top + 12, y1: top + 174, B: S.bank_m, tmax: tmax, table: table };
      g.k = (g.y1 - g.y0) / (g.B + tmax);
      g.Y = function (e) { return g.y0 + (tmax - e) * g.k; };
      g.X = function (f, side) { return g.cx + side * (g.chw + f * g.fw); };
      this.g = g;
      // plan view: the real unit catchments around the gauge on 1-arcmin pixels
      if (PLAN) {
        var pv = planView((narrow ? 330 : 340) / PLAN.P.nx, 48, 22), lx = narrow ? 20 : 406, ly = narrow ? 194 : 40, sw = function (cls, y, x) { return rect(x, y - 8, 10, 10, cls); };
        out.push(pv.svg);
        out.push(line(pv.o1[0], pv.o1[1], pv.o2[0], pv.o2[1], "or-s dash") + txt((pv.o1[0] + pv.o2[0]) / 2, Math.max(pv.o1[1], pv.o2[1]) + 18, "sm or halo", "L = " + Math.round(S.distance_m / 1000) + " km", "middle"));
        out.push(txt(pv.ci[0], pv.ci[1] + 3, "sm strong halo", "i", "middle") + txt(pv.cd[0], pv.cd[1] + 3, "sm halo", "i + 1", "middle"));
        if (narrow) {
          out.push(sw("plan-i", ly, lx) + txt(lx + 14, ly, "sm", "unit catchment i") + sw("plan-d", ly, lx + 132) + txt(lx + 146, ly, "sm", "downstream") + '<circle class="outlet" cx="' + (lx + 236) + '" cy="' + (ly - 3) + '" r="3.5"/>' + txt(lx + 244, ly, "sm", "outlets"));
        } else {
          out.push(txt(lx, ly - 5, "sm mut", "1-arcmin pixels, MERIT Hydro"));
          out.push(sw("plan-i", ly + 20, lx) + txt(lx + 16, ly + 20, "sm", "unit catchment i"));
          out.push(sw("plan-d", ly + 38, lx) + txt(lx + 16, ly + 38, "sm", "i + 1, downstream"));
          out.push(sw("plan", ly + 56, lx) + txt(lx + 16, ly + 56, "sm", "other catchments"));
          out.push('<circle class="outlet" cx="' + (lx + 5) + '" cy="' + (ly + 71) + '" r="3.5"/>' + txt(lx + 16, ly + 74, "sm", "outlets"));
          var dk = HERO.dark();
          for (var u = 0; u < 5; u++) out.push('<line x1="' + (lx + u * 4) + '" y1="' + (ly + 89) + '" x2="' + (lx + u * 4 + 4) + '" y2="' + (ly + 89) + '" style="stroke: ' + ramp(u / 4, dk) + '; stroke-width: 3"/>');
          out.push(txt(lx + 26, ly + 92, "sm", "river discharge"));
        }
      }
      // cross-section: the channel, and the floodplain drawn from the flood table
      out.push(txt(20, top, "sm mut", narrow ? "cross-section · " + S.name.split(" at ")[0] : "cross-section of catchment i · " + S.name));
      var prof = function (side) { var q = [[g.X(0, side), g.Y(0)]]; table.forEach(function (e, k) { q.push([g.X((k + 1) / table.length, side), g.Y(e)]); }); return q; };
      var L = prof(-1), R = prof(1), ground = L.slice().reverse().concat([[g.cx - g.chw, g.Y(-g.B)], [g.cx + g.chw, g.Y(-g.B)]]).concat(R);
      function pathOf(q) { return q.map(function (v) { return f1(v[0]) + " " + f1(v[1]); }).join("L"); }
      var bed = [[g.cx - g.chw, g.Y(0)], [g.cx - g.chw, g.Y(-g.B)], [g.cx + g.chw, g.Y(-g.B)], [g.cx + g.chw, g.Y(0)]];
      out.push('<path class="ground" d="M' + pathOf(L.slice().reverse()) + "L" + pathOf(bed) + "L" + pathOf(R.slice(1)) + "L" + f1(R[R.length - 1][0]) + " " + (g.y1 + 8) + "L" + f1(L[L.length - 1][0]) + " " + (g.y1 + 8) + 'Z"/>');
      this.ground = ground;
      out.push('<path class="ln" d="M' + pathOf(L.slice().reverse()) + "L" + pathOf(bed) + "L" + pathOf(R.slice(1)) + '"/>');
      R.slice(1).forEach(function (q) { out.push('<circle class="tbl-dot" cx="' + f1(q[0]) + '" cy="' + f1(q[1]) + '" r="2"/>'); });
      out.push(txt(g.cx, g.Y(-g.B) + 14, "sm mut", "river channel", "middle"));
      out.push(txt(g.X(0.92, 1) - 4, g.Y(table[table.length - 1]) + 4, "sm mut", "floodplain", "end"));
      // channel dimensions
      out.push(line(g.cx - g.chw - 8, g.Y(0), g.cx - g.chw - 8, g.Y(-g.B), "ln-3") + txt(g.cx - g.chw - 12, g.Y(-g.B / 2) + 3, "sm", "B", "end"));
      out.push(txt(g.cx - g.chw - 12, g.Y(-g.B / 2) + 15, "sm mut", Math.round(g.B) + " m", "end"));
      // the flood table itself
      var tx = narrow ? 296 : 410, ty = top + 22, rh = 15;
      this.t = { x: tx, y: ty, rh: rh, bw: narrow ? 50 : 90 };
      out.push(txt(tx, top, "sm strong", "flood table"));
      out.push(txt(tx, top + 15, "sm mut", "flooded") + txt(tx + 36 + (narrow ? 50 : 90), top + 15, "sm mut", narrow ? "depth" : "depth above bank"));
      table.forEach(function (e, k) {
        var y = ty + k * rh;
        out.push(txt(tx, y + 10, "sm mut", (k + 1) * 10 + "%"));
        out.push(rect(tx + 30, y + 3, Math.max(1, (narrow ? 50 : 90) * e / tmax), rh - 6, "tbl-bar"));
        out.push(txt(tx + 36 + (narrow ? 50 : 90), y + 10, "sm", e.toFixed(1) + " m"));
      });
      // through the year: the discharge of catchment i
      var n = S.depth.length, qs = S.outflow.map(function (v) { return v || 0; }), qmax = Math.max.apply(null, qs.concat([1]));
      var py = Math.max(ty + table.length * rh, g.y1 + 16) + 26;
      var c = { x0: narrow ? 44 : 60, x1: W - 24, y0: py + 12, y1: py + 76 };
      c.X = function (d) { return c.x0 + (c.x1 - c.x0) * d / Math.max(1, n - 1); };
      c.Yq = function (v) { return c.y1 - (c.y1 - c.y0) * v / qmax; };
      this.c = c; this.qs = qs;
      out.push(txt(20, py, "sm mut", "catchment i through " + YEAR));
      out.push('<path class="cfl-q" d="M' + f1(c.x0) + " " + c.y1 + qs.map(function (v, d) { return "L" + f1(c.X(d)) + " " + f1(c.Yq(v)); }).join("") + "L" + f1(c.x1) + " " + c.y1 + 'Z"/>');
      out.push(line(c.x0, c.y1, c.x1, c.y1, "ln"));
      for (var m = 0; m < 12; m += narrow ? 3 : 1) { var mx = c.X(monthStart(m)); out.push(line(mx, c.y1, mx, c.y1 + 3, "ln-3") + txt(mx + 2, c.y1 + 13, "sm mut", MONTHS[m])); }
      out.push(txt(c.x0 - 6, c.Yq(qmax) + 3, "sm bl", Math.round(qmax / 1000) + "k", "end") + txt(c.x0 - 6, c.y1, "sm bl", "0", "end"));
      out.push(txt(c.x0, c.y1 + 30, "sm bl", "■ discharge Q, m³/s"));
      return { vb: "0 0 " + W + " " + (c.y1 + 40), s: out.join("") };
    },
    after: function (svg) { this.rivers = svg.querySelectorAll('[data-r="plan-river"]'); this.shown = null; },
    draw: function (p) {
      var S = MANACAPURU, g = this.g, out = [], n = S.depth.length || 1, day = Math.min(n - 1, Math.round(smooth(p, 0.03, 0.97) * (n - 1)));
      var h = S.depth[day] || 0, e = h - g.B, table = g.table, frac = 0;
      if (e > 0) {
        var prev = 0;
        for (var k = 0; k < table.length; k++) {
          if (e <= table[k]) { frac = (k + (table[k] > prev ? (e - prev) / (table[k] - prev) : 1)) / table.length; break; }
          prev = table[k]; frac = 1;
        }
      }
      // water: the channel, then the floodplain up to where the profile meets the surface
      var wy = g.Y(Math.min(e, g.tmax)), d;
      if (e <= 0) d = "M" + (g.cx - g.chw) + " " + f1(wy) + "V" + f1(g.Y(-g.B)) + "H" + (g.cx + g.chw) + "V" + f1(wy) + "Z";
      else {
        var side = function (s) {
          var q = [[g.X(0, s), g.Y(0)]];
          table.forEach(function (te, k) { if ((k + 1) / table.length <= frac) q.push([g.X((k + 1) / table.length, s), g.Y(te)]); });
          q.push([g.X(frac, s), wy]);
          return q;
        };
        var L = side(-1), R = side(1);
        d = "M" + L.slice().reverse().map(function (v) { return f1(v[0]) + " " + f1(v[1]); }).join("L") + "L" + (g.cx - g.chw) + " " + f1(g.Y(-g.B)) + "H" + (g.cx + g.chw) + "L" + R.map(function (v) { return f1(v[0]) + " " + f1(v[1]); }).join("L") + "Z";
        out.push(line(g.X(frac, -1), wy - 8, g.X(frac, 1), wy - 8, "or-s") + line(g.X(frac, -1), wy - 11, g.X(frac, -1), wy - 5, "or-s") + line(g.X(frac, 1), wy - 11, g.X(frac, 1), wy - 5, "or-s"));
        out.push(txt(g.cx, wy - 13, "sm or halo", "flooded area " + Math.round(frac * 100) + "% of the catchment", "middle"));
        out.push(line(g.cx + g.chw + 6, g.Y(0), g.cx + g.chw + 6, wy, "blue-s") + txt(g.cx + g.chw + 10, (g.Y(0) + wy) / 2 + 3, "sm bl halo", "flood depth " + e.toFixed(1) + " m"));
      }
      out.unshift('<path class="water" d="' + d + '"/>');
      out.push(line(g.cx + g.chw - 5, g.Y(-g.B), g.cx + g.chw - 5, wy, "blue-s") + txt(g.cx + g.chw + 10, g.Y(-g.B / 2) + 3, "sm bl halo", "h = " + h.toFixed(1) + " m"));
      // rows of the flood table below the current flood depth
      var t = this.t, rows = frac * table.length;
      if (rows > 0) out.push(rect(t.x - 4, t.y, t.bw + 82, Math.floor(rows) * t.rh, "", ' rx="3" style="fill: var(--blue); opacity: 0.14"'));
      if (rows % 1 > 0) out.push(rect(t.x - 4, t.y + Math.floor(rows) * t.rh, t.bw + 82, t.rh, "", ' rx="3" style="fill: var(--blue); opacity: 0.06"'));
      // the day: its date, the rivers of the plan view coloured by that day's discharge, the chart cursor
      var date = new Date(Date.UTC(YEAR, 0, 1 + day)), c = this.c;
      out.push(txt(c.x1, c.y0 - 12, "ital", date.getUTCDate() + " " + MONTHS[date.getUTCMonth()] + " " + YEAR, "end"));
      if (PLAN && PLAN.q && this.shown !== day) {
        this.shown = day;
        var dark = HERO.dark(), ids = PLAN.P.river_ids || [];
        for (var i = 0; i < this.rivers.length; i++) this.rivers[i].style.stroke = ramp(PLAN.q[(ids[i] - 1) * PLAN.days + day] / 255, dark);
      }
      var x = c.X(day);
      out.push(line(x, c.y0 - 4, x, c.y1, "ln") + '<circle class="blue-f" cx="' + f1(x) + '" cy="' + f1(c.Yq(this.qs[day])) + '" r="3"/>');
      return out.join("");
    }
  };

  // 05 the time step follows the CFL condition: the monsoon flood of the Mekong at Mukdahan
  FIGS.cfl = {
    D0: 150, D1: 320, ALPHA: 0.7, G: 9.81,
    dt: function (h) { return Math.min(86400, this.ALPHA * GAUGE.distance_m / Math.sqrt(this.G * Math.max(h, 0.01))); },
    build: function (narrow) {
      var W = narrow ? 400 : 600, out = [], S = GAUGE, self = this;
      var g = { W: W, x0: 20, x1: W - 20, nb: narrow ? 4 : 6, surf: 92, bed: 112, cy0: 196, cy1: 330 };
      g.L = (g.x1 - g.x0) / g.nb;
      g.cx0 = g.x0 + 34; g.cx1 = g.x1 - 40;
      this.g = g;
      // a river cut into catchments of length L
      out.push(txt(g.x0, 14, "sm mut", "a flood wave moving downstream"));
      out.push(rect(g.x0, g.bed, g.x1 - g.x0, 10, "ground"));
      for (var i = 0; i <= g.nb; i++) out.push(line(g.x0 + i * g.L, g.surf - 30, g.x0 + i * g.L, g.bed + 10, "ln-3 dash"));
      out.push(line(g.x0, g.bed + 18, g.x0 + g.L, g.bed + 18, "ln-3") + txt(g.x0 + g.L / 2, g.bed + 30, "sm mut", "L = " + Math.round(S.distance_m / 1000) + " km", "middle"));
      // the chart: discharge and the time step it allows, day by day
      var days = [], qmax = 1, dmax = 1, dmin = Infinity;
      for (var d = this.D0; d <= this.D1; d++) {
        var q = S.outflow[d] || 0, dt = this.dt(S.depth[d] || 0);
        days.push({ q: q, dt: dt }); qmax = Math.max(qmax, q); dmax = Math.max(dmax, dt); dmin = Math.min(dmin, dt);
      }
      this.days = days;
      var X = function (dd) { return g.cx0 + (g.cx1 - g.cx0) * (dd - self.D0) / (self.D1 - self.D0); };
      var Yq = function (q) { return g.cy1 - (g.cy1 - g.cy0) * q / (qmax * 1.1); };
      var Yt = function (t) { return g.cy1 - (g.cy1 - g.cy0) * t / (dmax * 1.15); };
      this.X = X; this.Yq = Yq; this.Yt = Yt;
      out.push(txt(g.x0, g.cy0 - (narrow ? 44 : 30), "sm mut", S.name + " · daily means, " + YEAR));
      var area = "M" + f1(X(this.D0)) + " " + g.cy1;
      days.forEach(function (v, k) { area += "L" + f1(X(self.D0 + k)) + " " + f1(Yq(v.q)); });
      out.push('<path class="cfl-q" d="' + area + "L" + f1(X(this.D1)) + " " + g.cy1 + 'Z"/>');
      out.push('<path class="cfl-dt" d="M' + days.map(function (v, k) { return f1(X(self.D0 + k)) + " " + f1(Yt(v.dt)); }).join("L") + '"/>');
      out.push(line(g.cx0, g.cy1, g.cx1, g.cy1, "ln"));
      for (var m = 0; m < 12; m++) {
        var dm = Math.round((Date.UTC(YEAR, m, 1) - Date.UTC(YEAR, 0, 1)) / 864e5);
        if (dm < this.D0 || dm > this.D1) continue;
        out.push(line(X(dm), g.cy1, X(dm), g.cy1 + 4, "ln-3") + txt(X(dm) + 3, g.cy1 + 14, "sm mut", MONTHS[m]));
      }
      out.push(txt(g.cx0 - 6, Yq(qmax) + 3, "sm bl", fmtInt(Math.round(qmax / 1000)) + "k", "end"));
      out.push(txt(g.cx1 + 6, Yt(dmax) + 3, "sm or", Math.round(dmax / 60) + " min") + txt(g.cx1 + 6, Yt(dmin) + 3, "sm or", Math.round(dmin / 60) + " min"));
      out.push(txt(g.cx0, g.cy1 + 30, "sm bl", "■ discharge, m³/s") + txt(g.cx0 + 140, g.cy1 + 30, "sm or", "— time step Δt"));
      return { vb: "0 0 " + W + " " + (g.cy1 + 40), s: out.join("") };
    },
    draw: function (p, now) {
      var g = this.g, S = GAUGE, out = [], dd = this.D0 + Math.round(smooth(p, 0.05, 0.95) * (this.D1 - this.D0));
      var h = S.depth[dd] || 0, dt = this.dt(h), c = Math.sqrt(this.G * h), v = this.days[dd - this.D0];
      // the wave moves 0.7 L per time step; deeper water, faster wave, shorter step
      var hs = S.depth.filter(function (v) { return v !== null; }), hmin = Math.min.apply(null, hs), hmax = Math.max.apply(null, hs), amp = 6 + 22 * clamp((h - hmin) / (hmax - hmin), 0, 1);
      var tau = 0.25 + 1.1 * dt / 3000, span = g.nb * g.L, k = Math.floor((REDUCED ? 3 : now / 1000) / tau);
      var pos = function (j) { return g.x0 + ((j * this.ALPHA * g.L) % span + span) % span; }.bind(this), xw = pos(k);
      var surf = [];
      for (var x = g.x0; x <= g.x1; x += 4) surf.push(f1(x) + " " + f1(g.surf - amp * Math.exp(-Math.pow((x - xw) / 34, 2))));
      out.push('<path class="water" d="M' + g.x0 + " " + g.bed + "L" + surf.join("L") + "L" + g.x1 + " " + g.bed + 'Z"/>');
      for (var j = 1; j <= 3; j++) {
        var xp = pos(k - j);
        if (xp < xw) out.push('<circle class="blue-f" cx="' + f1(xp) + '" cy="' + f1(g.surf - amp - 8) + '" r="2.5" opacity="' + f1(0.7 - j * 0.18) + '"/>');
      }
      var xp1 = pos(k - 1);
      if (xp1 < xw) {
        out.push(line(xp1, g.surf - amp - 18, xw, g.surf - amp - 18, "or-s") + head(xw, g.surf - amp - 18, 0, "or-f"));
        out.push(txt((xp1 + xw) / 2, g.surf - amp - 24, "sm or halo", "c·Δt = 0.7 L", "middle"));
      }
      out.push('<circle class="blue-f" cx="' + f1(xw) + '" cy="' + f1(g.surf - amp - 8) + '" r="3.5"/>');
      // the chart cursor and the numbers of that day
      var X = this.X(dd);
      out.push(line(X, g.cy0 - 4, X, g.cy1, "ln") + '<circle class="blue-f" cx="' + f1(X) + '" cy="' + f1(this.Yq(v.q)) + '" r="3.5"/><circle class="or-f" cx="' + f1(X) + '" cy="' + f1(this.Yt(v.dt)) + '" r="3.5"/>');
      var date = new Date(Date.UTC(YEAR, 0, 1 + dd)), right = X < (g.cx0 + g.cx1) / 2;
      out.push(txt(right ? X + 8 : X - 8, g.cy0 + 8, "sm strong halo", date.getUTCDate() + " " + MONTHS[date.getUTCMonth()], right ? null : "end"));
      var r1 = "depth h = " + h.toFixed(1) + " m · wave speed c = √(g h) = " + c.toFixed(1) + " m/s", r2 = "Δt = " + Math.round(dt / 60) + " min, " + Math.ceil(86400 / dt) + " steps a day";
      if (NARROW) out.push(txt(g.x0, g.cy0 - 28, "sm", r1) + txt(g.x0, g.cy0 - 14, "sm", r2));
      else out.push(txt(g.x0, g.cy0 - 14, "sm", r1 + " · " + r2));
      return out.join("");
    },
    animated: true
  };

  // every catchment at once: one thread each, atomic adds downstream
  FIGS.scatter = {
    build: function (narrow) {
      var out = [], n = 10, W = narrow ? 380 : 560, bw = (W - 40) / n;
      var down = [2, 2, 4, 4, 6, 6, 8, 8, 9, 9];
      this.g = { n: n, W: W, bw: bw, x0: 20, ty: 70, by: 220, down: down };
      out.push(txt(20, 30, "sm", "discharge Q of each catchment, one GPU thread each") + txt(20, 268, "sm", "storage S of the downstream catchment"));
      for (var i = 0; i < n; i++) {
        var x = 20 + i * bw;
        out.push(rect(x + 3, 70, bw - 6, 30, "cellbox", ' rx="4"') + txt(x + bw / 2, 89, "sm", "c" + i, "middle"));
        out.push(rect(x + 3, 220, bw - 6, 30, "cellbox", ' rx="4"') + txt(x + bw / 2, 239, "sm", "c" + i, "middle"));
        out.push(txt(x + bw / 2, 58, "sm mut", "t" + i, "middle"));
      }
      out.push(txt(20, 292, "sm mut", "catchments numbered upstream → downstream"));
      return { vb: "0 0 " + W + " 304", s: out.join("") };
    },
    draw: function (p) {
      var g = this.g, out = [], a = smooth(p, 0.05, 0.3), b = smooth(p, 0.3, 0.75), c = smooth(p, 0.7, 0.95);
      var hits = {};
      for (var i = 0; i < g.n; i++) {
        var x = g.x0 + i * g.bw + g.bw / 2, d = g.down[i], xd = g.x0 + d * g.bw + g.bw / 2;
        if (a > 0) out.push(rect(x - g.bw / 2 + 3, 70, g.bw - 6, 30, "blue-f", ' rx="4" opacity="' + f1(0.2 + 0.6 * a) + '"'));
        out.push(txt(x, 89, "sm" + (a > 0.5 ? " halo strong" : ""), "c" + i, "middle"));
        if (d === i) { if (b > 0) out.push(txt(x, 165, "sm mut", "mouth", "middle")); continue; }
        var path = [[x, 102], [x, 150], [xd, 170], [xd, 218]];
        if (b > 0) {
          out.push('<path class="ln-3" d="M' + x + " 102C" + x + " 160 " + xd + " 160 " + xd + ' 218"/>');
          var pt = along(path, b);
          out.push('<circle class="blue-f" cx="' + f1(pt[0]) + '" cy="' + f1(pt[1]) + '" r="3.2"/>');
        }
        hits[d] = (hits[d] || 0) + 1;
      }
      Object.keys(hits).forEach(function (k) {
        var x = g.x0 + (+k) * g.bw + g.bw / 2;
        if (c > 0) out.push(rect(x - g.bw / 2 + 3, 220, g.bw - 6, 30, "blue-f", ' rx="4" opacity="' + f1(0.6 * c) + '"'));
        if (hits[k] > 1 && b >= 1) out.push(txt(x, 214, "sm or halo", "atomic +", "middle"));
      });
      return out.join("");
    }
  };

  /* ------------------------------------------------------------ hero map */
  var HERO = {
    lon0: -170, lon1: 180, lat0: 84, lat1: -56,
    day: 152, playing: !REDUCED, speed: 9,
    init: function () {
      this.cv = document.getElementById("map");
      this.sp = document.getElementById("spark");
      this.fig = document.querySelector(".map");
      if (!this.cv || !RV.n || !RV.q) { if (this.fig) this.fig.classList.add("empty"); return; }
      var self = this;
      // daily discharge at all river mouths for the sparkline
      this.tot = RIVERS.spark || [];
      var lo = RV.qlog[0], hi = RV.qlog[1];
      var leg = document.querySelector('[data-r="legend"]');
      if (leg) leg.innerHTML = "<i>" + fmtQ(lo) + "</i><i>" + fmtQ((lo + hi) / 2) + "</i><i>" + fmtQ(hi) + " m³/s</i>";
      var cap = document.querySelector('[data-r="caption"]');
      if (cap) cap.textContent = RIVERS.caption || "";
      this.btn = this.fig.querySelector(".play");
      this.btn.addEventListener("click", function () { self.setPlaying(!self.playing); });
      var sc = this.fig.querySelector(".scrub"), drag = false;
      function at(ev) { var r = sc.getBoundingClientRect(); self.day = clamp((ev.clientX - r.left) / r.width, 0, 0.9999) * RV.days; self.paint(); }
      sc.addEventListener("pointerdown", function (ev) { drag = true; sc.setPointerCapture(ev.pointerId); self.setPlaying(false); at(ev); });
      sc.addEventListener("pointermove", function (ev) { if (drag) at(ev); });
      sc.addEventListener("pointerup", function () { drag = false; });
      sc.addEventListener("keydown", function (ev) {
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          self.setPlaying(false);
          self.day = (Math.floor(self.day) + (ev.key === "ArrowRight" ? 1 : RV.days - 1)) % RV.days;
          self.paint(); ev.preventDefault();
        } else if (ev.key === " ") { self.setPlaying(!self.playing); ev.preventDefault(); }
      });
      this.visible = true;
      if (typeof IntersectionObserver === "function") {
        new IntersectionObserver(function (es) { self.visible = es[0].isIntersecting; if (self.visible) self.loop(); }, { threshold: 0.05 }).observe(this.fig);
      }
      // the discharge of the river under the pointer, for the day on show
      var stage = this.cv.parentNode;
      this.tip = document.createElement("div");
      this.tip.className = "map-tip";
      this.tip.hidden = true;
      stage.appendChild(this.tip);
      this.boxes = RV.pts.map(function (pts) {
        var b = [Infinity, Infinity, -Infinity, -Infinity];
        pts.forEach(function (c) { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); });
        return b;
      });
      this.cv.addEventListener("pointermove", function (ev) {
        var r = self.cv.getBoundingClientRect();
        self.pointAt(ev.clientX - r.left, ev.clientY - r.top);
      });
      this.cv.addEventListener("pointerleave", function () { self.hit = null; self.tip.hidden = true; self.cv.style.cursor = ""; self.paint(); });
      this.resize();
      this.setPlaying(this.playing);
      var mq = matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", function () { self.paint(); });
    },
    pointAt: function (x, y) {
      var lon = this.lon0 + x * this.dpr / this.k, lat = this.lat0 - y * this.dpr / this.k, tol = 7 * this.dpr / this.k, best = null, bd = tol * tol;
      for (var i = 0; i < RV.n; i++) {
        var b = this.boxes[i];
        if (lon < b[0] - tol || lon > b[2] + tol || lat < b[1] - tol || lat > b[3] + tol) continue;
        var pts = RV.pts[i];
        for (var j = 1; j < pts.length; j++) {
          var ax = pts[j - 1][0], ay = pts[j - 1][1], dx = pts[j][0] - ax, dy = pts[j][1] - ay, L = dx * dx + dy * dy;
          var u = L ? clamp(((lon - ax) * dx + (lat - ay) * dy) / L, 0, 1) : 0, ex = ax + u * dx - lon, ey = ay + u * dy - lat;
          var d2 = ex * ex + ey * ey - RV.lvl[i] * tol * tol * 0.08;
          if (d2 < bd) { bd = d2; best = i; }
        }
      }
      this.hit = best;
      this.hitAt = [x, y];
      this.cv.style.cursor = best === null ? "" : "pointer";
      if (best === null) this.tip.hidden = true;
      this.paint();
    },
    // the day's discharge of reach r: finer for the larger rivers, otherwise its colour step
    discharge: function (r, day) {
      var F = RV.fine, i = F ? F.at[r] : -1;
      if (i >= 0) return { v: Math.pow(10, F.lo[i] + (F.hi[i] - F.lo[i]) * F.lv[i * RV.days + day] / F.steps), exact: true };
      return { v: Math.pow(10, RV.qlog[0] + (RV.qlog[1] - RV.qlog[0]) * RV.q[r * RV.days + day] / 255), exact: false };
    },
    showTip: function () {
      if (this.hit === null || this.hit === undefined) return;
      var day = Math.floor(this.day), q = this.discharge(this.hit, day), d = new Date(Date.UTC(YEAR, 0, 1 + day));
      var v = q.exact ? Number(q.v.toPrecision(3)) : Number(q.v.toPrecision(1));
      this.tip.innerHTML = "<b>" + (q.exact ? "" : "≈ ") + fmtInt(v) + " m³/s</b><span>daily mean discharge · " + d.getUTCDate() + " " + MONTHS_LONG[d.getUTCMonth()] + "</span>";
      this.tip.hidden = false;
      var w = this.cv.clientWidth, x = this.hitAt[0], left = x + 14 + this.tip.offsetWidth > w ? x - 14 - this.tip.offsetWidth : x + 14;
      this.tip.style.left = (this.cv.offsetLeft + left) + "px";
      this.tip.style.top = (this.cv.offsetTop + this.hitAt[1] - this.tip.offsetHeight - 10) + "px";
    },
    setPlaying: function (on) {
      this.playing = on;
      this.fig.classList.toggle("paused", !on);
      this.btn.setAttribute("aria-label", on ? "Pause" : "Play");
      if (on) this.loop(); else this.paint();
    },
    loop: function () {
      var self = this;
      if (this.raf || !this.playing) return;
      var last = null;
      function frame(ts) {
        self.raf = null;
        if (!self.playing || !self.visible) return;
        if (last !== null) self.day = (self.day + Math.min(0.1, (ts - last) / 1000) * self.speed) % RV.days;
        last = ts;
        self.paint();
        self.raf = requestAnimationFrame(frame);
      }
      this.raf = requestAnimationFrame(frame);
    },
    resize: function () {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = this.cv.clientWidth, h = w * (this.lat0 - this.lat1) / (this.lon1 - this.lon0);
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      this.k = this.cv.width / (this.lon1 - this.lon0);
      this.dpr = dpr;
      var sw = this.sp.clientWidth, sh = this.sp.clientHeight;
      this.sp.width = Math.round(sw * dpr); this.sp.height = Math.round(sh * dpr);
      this.paint();
    },
    dark: function () { return getComputedStyle(document.documentElement).getPropertyValue("--paper").trim().toLowerCase() !== "#ffffff"; },
    paint: function () {
      if (!this.cv) return;
      var ctx = this.cv.getContext("2d"), dark = this.dark(), W = this.cv.width, H = this.cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";
      var w0 = Math.floor(this.day), f = this.day - w0, w1 = (w0 + 1) % RV.days, NB = 14;
      var scale = Math.max(0.55, W / (1280 * this.dpr)) * this.dpr;
      var bins = [];
      for (var l = 0; l < 5; l++) { bins.push([]); for (var b = 0; b < NB; b++) bins[l].push([]); }
      for (var i = 0; i < RV.n; i++) {
        var v = (RV.q[i * RV.days + w0] * (1 - f) + RV.q[i * RV.days + w1] * f) / 255;
        bins[Math.min(4, RV.lvl[i])][Math.min(NB - 1, Math.floor(v * NB))].push(i);
      }
      for (l = 0; l < 5; l++) {
        for (b = 0; b < NB; b++) {
          var list = bins[l][b];
          if (!list.length) continue;
          var u = (b + 0.5) / NB;
          ctx.strokeStyle = ramp(u, dark);
          ctx.lineWidth = (0.35 + 0.45 * l) * scale * (0.7 + 0.8 * u);
          ctx.shadowBlur = dark && u > 0.6 ? 8 * this.dpr * (u - 0.5) : 0;
          ctx.shadowColor = dark ? "rgba(150, 200, 255, 0.8)" : "transparent";
          ctx.beginPath();
          for (var j = 0; j < list.length; j++) {
            var a = RV.pts[list[j]];
            ctx.moveTo((a[0][0] - this.lon0) * this.k, (this.lat0 - a[0][1]) * this.k);
            for (var m = 1; m < a.length; m++) ctx.lineTo((a[m][0] - this.lon0) * this.k, (this.lat0 - a[m][1]) * this.k);
          }
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      if (this.hit !== null && this.hit !== undefined) {
        var hp = RV.pts[this.hit];
        ctx.strokeStyle = dark ? "#ffffff" : "#0d0d0d";
        ctx.lineWidth = (1.4 + 0.5 * RV.lvl[this.hit]) * scale;
        ctx.beginPath();
        ctx.moveTo((hp[0][0] - this.lon0) * this.k, (this.lat0 - hp[0][1]) * this.k);
        for (var hm = 1; hm < hp.length; hm++) ctx.lineTo((hp[hm][0] - this.lon0) * this.k, (this.lat0 - hp[hm][1]) * this.k);
        ctx.stroke();
        this.showTip();
      }
      this.paintSpark(dark);
      var d0 = new Date(Date.UTC(YEAR, 0, 1 + w0)), label = d0.getUTCDate() + " " + MONTHS_LONG[d0.getUTCMonth()];
      setText("date", label);
      setText("year", "daily mean · " + YEAR);
      var sc = this.fig.querySelector(".scrub");
      sc.setAttribute("aria-valuenow", String(w0 + 1));
      sc.setAttribute("aria-valuetext", label + " " + YEAR);
      this.fig.querySelector(".knob").style.left = (100 * this.day / RV.days) + "%";
    },
    paintSpark: function (dark) {
      var ctx = this.sp.getContext("2d"), W = this.sp.width, H = this.sp.height, n = this.tot.length;
      var mx = Math.max.apply(null, this.tot) || 1, mid = H / 2;
      ctx.clearRect(0, 0, W, H);
      var css = getComputedStyle(document.documentElement);
      var tot = this.tot;
      function trace() {
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (var w = 0; w <= n; w++) ctx.lineTo(W * w / n, mid - (tot[w % n] / mx) * (H * 0.42));
        for (w = n; w >= 0; w--) ctx.lineTo(W * w / n, mid + (tot[w % n] / mx) * (H * 0.12));
        ctx.closePath();
      }
      ctx.fillStyle = css.getPropertyValue("--rule").trim() || "#ddd";
      trace(); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W * this.day / n, H); ctx.clip();
      ctx.fillStyle = css.getPropertyValue("--blue").trim() || "#1859c9";
      trace(); ctx.fill();
      ctx.restore();
    }
  };
  function fmtQ(lg) {
    var v = Math.pow(10, Math.round(lg));
    return v >= 1e6 ? (v / 1e6) + "M" : v >= 1e3 ? (v / 1e3) + "k" : String(v);
  }
  function ramp(u, dark) {
    // light: pale blue-grey to deep blue; dark: dim teal-blue to a bright glow
    var A = dark ? [[30, 48, 70], [62, 130, 230], [214, 236, 255]] : [[206, 214, 230], [24, 89, 201], [8, 34, 96]];
    var k = u < 0.5 ? 0 : 1, t = u < 0.5 ? u / 0.5 : (u - 0.5) / 0.5, a = A[k], b = A[k + 1];
    var alpha = dark ? 0.35 + 0.65 * u : 0.45 + 0.55 * u;
    return "rgba(" + Math.round(a[0] + (b[0] - a[0]) * t) + "," + Math.round(a[1] + (b[1] - a[1]) * t) + "," + Math.round(a[2] + (b[2] - a[2]) * t) + "," + alpha.toFixed(2) + ")";
  }
  function sub(x, y, cls, base, s2, anchor) {
    return '<text class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + base + '<tspan class="sm" dy="3">' + s2 + "</tspan></text>";
  }
  function setText(name, v) { var e = document.querySelector('[data-r="' + name + '"]'); if (e) e.textContent = v; }

  /* ------------------------------------------------------------ benchmark */
  // Kang et al. (2026): one simulated year (2000), seconds; null = out of GPU memory
  var BENCH = {
    res: ["15-arcmin", "6-arcmin", "3-arcmin", "1-arcmin"],
    rows: [
      { grp: "CPU · CaMa-Flood v4.23", lab: "48 cores", cpu: true, t: [139, 2911, 23341, ">14 d"] },
      { lab: "96 cores", cpu: true, t: [92, 1730, 14356, 712812] },
      { lab: "192 cores", cpu: true, ref: true, t: [71, 1117, 9919, 507500] },
      { grp: "GPU · CaMa-Flood-GPU", lab: "RTX 4070 Ti", sub: "workstation", t: [38, 406, 2922, null] },
      { lab: "V100", sub: "× 1", t: [141, 402, 2405, null] },
      { lab: "V100", sub: "× 2", t: [137, 266, 1267, null] },
      { lab: "V100", sub: "× 3", t: [143, 262, 898, 32518] },
      { lab: "V100", sub: "× 4", t: [144, 256, 707, 24696] },
      { lab: "A100", sub: "× 1", t: [74, 264, 1369, 48962] },
      { lab: "A100", sub: "× 2", t: [77, 178, 741, 24960] },
      { lab: "A100", sub: "× 3", t: [83, 155, 536, 17457] },
      { lab: "A100", sub: "× 4", t: [91, 154, 441, 13884] }
    ]
  };
  function fmtT(s) {
    if (typeof s === "string") return s.replace(" d", " days").replace(">", "> ");
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return h ? h + " h " + m + " min" : m ? m + " min " + sec + " s" : sec + " s";
  }
  function buildBench() {
    var tabs = document.querySelector(".bench .tabs"), chart = document.querySelector(".bench .chart");
    if (!tabs || !chart) return;
    var cur = 3, shown = false;
    function render(animate) {
      var r = cur, mx = 0, ref = BENCH.rows[2].t[r];
      BENCH.rows.forEach(function (row) { if (typeof row.t[r] === "number" && row.t[r] > mx) mx = row.t[r]; });
      var html = [];
      BENCH.rows.forEach(function (row) {
        if (row.grp) html.push('<p class="grp">' + row.grp + "</p>");
        var v = row.t[r], w = v === null ? 0 : typeof v === "string" ? 100 : 100 * v / mx;
        var sp = !row.cpu && typeof v === "number" && typeof ref === "number" ? ref / v : null;
        html.push('<div class="brow"><span class="lab">' + row.lab + (row.sub ? " <small>" + row.sub + "</small>" : "") + "</span>" +
          '<span class="track"><span class="bar' + (row.cpu ? " cpu" : "") + '" data-w="' + Math.max(w, v === null ? 0 : 0.6).toFixed(2) + '"></span></span>' +
          (v === null ? '<span class="na">exceeds GPU memory</span>' : '<span class="val">' + fmtT(v) + (sp ? "<em>" + (sp >= 10 ? Math.round(sp) : sp.toFixed(1)) + "×</em>" : "") + "</span>") + "</div>");
      });
      chart.innerHTML = html.join("");
      chart.setAttribute("aria-label", "Run time of one simulated year at " + BENCH.res[r] + " on CPUs and GPUs");
      var bars = chart.querySelectorAll(".bar");
      function grow() { Array.prototype.forEach.call(bars, function (b) { b.style.width = b.getAttribute("data-w") + "%"; }); }
      if (animate && !REDUCED) requestAnimationFrame(function () { requestAnimationFrame(grow); }); else grow();
      Array.prototype.forEach.call(tabs.children, function (b, i) { b.setAttribute("aria-selected", i === r ? "true" : "false"); b.tabIndex = i === r ? 0 : -1; });
    }
    BENCH.res.forEach(function (name, i) {
      var b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "tab"); b.textContent = name;
      b.addEventListener("click", function () { cur = i; render(true); });
      b.addEventListener("keydown", function (ev) {
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          cur = (cur + (ev.key === "ArrowRight" ? 1 : 3)) % 4; render(true); tabs.children[cur].focus(); ev.preventDefault();
        }
      });
      tabs.appendChild(b);
    });
    render(false);
    // the bars grow when the chart first scrolls into view
    if (typeof IntersectionObserver === "function" && !REDUCED) {
      Array.prototype.forEach.call(chart.querySelectorAll(".bar"), function (b) { b.style.width = "0"; });
      new IntersectionObserver(function (es, ob) {
        if (es[0].isIntersecting && !shown) { shown = true; render(true); ob.disconnect(); }
      }, { threshold: 0.3 }).observe(chart);
    }
  }

  /* ------------------------------------------------------------ giant title */
  function fitTitle() {
    var h = document.querySelector(".giant");
    if (!h) return;
    h.style.fontSize = "";
    var avail = h.clientWidth, w = h.scrollWidth;
    if (w > 0) h.style.fontSize = (parseFloat(getComputedStyle(h).fontSize) * avail / w * 0.995) + "px";
  }

  // daily means and monthly maxima at the Mekong at Mukdahan (07)
  var VALS = GAUGE.outflow.map(function (v) { return v === null || v === undefined || !isFinite(v) ? null : +v; });
  var NDAY = VALS.length || 366;
  var VMAX = Math.max.apply(null, VALS.filter(function (v) { return v !== null; }).concat([1]));
  function monthStart(m) { return Math.round((Date.UTC(YEAR, m, 1) - Date.UTC(YEAR, 0, 1)) / 864e5); }

  // 07 statistics windows on the GPU: daily means, and their monthly maximum
  var MONTHLY = (GAUGE.monthly_max || []).map(function (v) { return v === null || v === undefined ? null : +v; });
  FIGS.stats = {
    build: function (narrow) {
      var out = [], g;
      g = narrow
        ? { W: 380, cw: 380, cardH: 318, x0: 14, x1: 366, files: [[10, 350], [204, 350]], H: 430 }
        : { W: 620, cw: 420, cardH: 318, x0: 20, x1: 400, files: [[454, 70], [454, 196]], H: 326 };
      g.top = 92; g.base = 262; g.lane = 80;
      this.g = g;
      var Y = function (v) { return g.base - (g.base - g.top) * v / (VMAX * 1.18); };
      var X = function (d) { return g.x0 + (g.x1 - g.x0) * d / NDAY; };
      this.X = X; this.Y = Y;
      out.push(rect(0.75, 0.75, g.cw - 1.5, g.cardH - 1.5, "card", ' rx="16"'));
      out.push(txt(g.x0, 26, "bl strong", "GPU") + txt(g.x0 + 34, 26, "sm mut", narrow ? "statistics in device memory" : "statistics accumulate in device memory"));
      out.push(txt(g.x0, 52, "ital", "daily mean discharge") + txt(g.x0 + 146, 52, "ital or", "and its monthly maximum"));
      var d = "", open = false;
      for (var i = 0; i < NDAY; i++) {
        var v = VALS[i];
        if (v === null) { if (open) { d += "V" + g.base + "Z"; open = false; } continue; }
        if (!open) { d += "M" + f1(X(i)) + " " + g.base; open = true; }
        d += "V" + f1(Y(v)) + "H" + f1(X(i + 1));
      }
      if (open) d += "V" + g.base + "Z";
      out.push('<defs><clipPath id="jr-rev"><rect data-r="rev" x="' + g.x0 + '" y="0" width="0" height="' + g.cardH + '"/></clipPath></defs>');
      out.push('<path class="ghost" d="' + d + '"/><g clip-path="url(#jr-rev)"><path class="area" d="' + d + '"/></g>');
      out.push(line(g.x0, g.base + 0.5, g.x1, g.base + 0.5, "ln"));
      for (var m = 0; m < 12; m++) {
        var a = monthStart(m), b = monthStart(m + 1);
        if (m) out.push(line(X(a), g.top - 4, X(a), g.base, "ln-3 dash"));
        out.push(txt((X(a) + X(b)) / 2, g.base + 16, "sm mut", MONTHS[m].charAt(0), "middle"));
      }
      out.push(txt(g.x0, g.cardH - 14, "sm mut", narrow ? "a window a day, a window a month" : "inner window: one day · outer window: one month"));
      return { vb: "0 0 " + g.W + " " + g.H, s: out.join("") };
    },
    after: function (svg) { this.rev = svg.querySelector('[data-r="rev"]'); },
    file: function (x, y, empty, l1, l2, l3) {
      return '<path class="file' + (empty ? " empty" : "") + '" d="M' + x + " " + y + "h24l8 8v34h-32z\"/>" +
        '<path class="file' + (empty ? " empty" : "") + '" style="fill:none" d="M' + (x + 24) + " " + y + "v8h8\"/>" +
        line(x + 5, y + 12, x + 19, y + 12, "ln-3") + line(x + 5, y + 17, x + 26, y + 17, "ln-3") +
        txt(x + 16, y + 34, "nc", ".nc", "middle") +
        (NARROW
          ? txt(x + 40, y + 12, "sm strong", l1) + txt(x + 40, y + 25, "sm", l2) + txt(x + 40, y + 38, "sm mut", l3)
          : txt(x, y + 58, "sm strong", l1) + txt(x, y + 71, "sm", l2) + txt(x, y + 84, "sm mut", l3));
    },
    draw: function (p) {
      var g = this.g, X = this.X, Y = this.Y, out = [], travel = 9;
      var dd = smooth(p, 0.03, 0.95) * (NDAY + travel * 1.5), nPub = Math.min(NDAY, Math.floor(dd));
      if (this.rev) this.rev.setAttribute("width", f1(X(nPub) - g.x0));
      // the open day
      if (nPub < NDAY && VALS[nPub] !== null) {
        var y = Y(VALS[nPub] * Math.min(1, (dd - nPub) * 1.2 + 0.2));
        out.push(rect(X(nPub), y, Math.max(1.2, X(nPub + 1) - X(nPub)), g.base - y, "blue-s dash", ' style="fill: var(--blue-soft)"'));
      }
      function route(x0, y0, f) {
        return NARROW
          ? [[x0, y0], [x0, g.lane], [g.cw - 8, g.lane], [g.cw - 8, g.cardH + 8], [f[0] + 16, f[1] - 6], [f[0] + 16, f[1]]]
          : [[x0, y0], [x0, g.lane], [g.cw - 10, g.lane], [g.cw + 8, f[1] + 20], [f[0] - 4, f[1] + 20]];
      }
      function dot(pts, u, cls, r) {
        var pt = along(pts, 1 - Math.pow(1 - u, 2));
        return '<circle class="' + cls + '" cx="' + f1(pt[0]) + '" cy="' + f1(pt[1]) + '" r="' + r + '"/>';
      }
      // finished days leave for the daily file
      var days = 0;
      for (var dday = 0; dday < nPub; dday++) {
        if (VALS[dday] === null) continue;
        var u = (dd - (dday + 1)) / travel;
        if (u >= 1) days++;
        else if (u >= 0 && dday >= nPub - 12) out.push(dot(route(X(dday + 0.5), Y(VALS[dday]), g.files[0]), u, "blue-f", 2.4));
      }
      // the month's maximum of daily means, kept on the GPU until the month closes
      var months = 0;
      for (var m = 0; m < 12; m++) {
        var a = monthStart(m), b = Math.min(NDAY, monthStart(m + 1));
        if (nPub <= a) break;
        var best = -1;
        for (var i = a; i < Math.min(b, nPub); i++) if (VALS[i] !== null && (best < 0 || VALS[i] > VALS[best])) best = i;
        if (best < 0) continue;
        var closed = nPub >= b, my = Y(closed && MONTHLY[m] !== null && MONTHLY[m] !== undefined ? MONTHLY[m] : VALS[best]);
        out.push(line(X(a) + 1, my, X(closed ? b : nPub) - 1, my, "or-s" + (closed ? "" : " dash")));
        out.push('<circle class="or-f" cx="' + f1(X(best + 0.5)) + '" cy="' + f1(my) + '" r="3.5" style="stroke: var(--paper); stroke-width: 1.5"/>');
        if (!closed) {
          var right = X(nPub) + 90 < g.x1;
          out.push(txt(right ? X(nPub) + 6 : X(a) - 6, my - 6, "sm or halo", "max so far", right ? null : "end"));
          continue;
        }
        var w = (dd - b) / (travel * 1.5);
        if (w >= 1) months++;
        else if (w >= 0) out.push(dot(route(X(best + 0.5), my, g.files[1]), w, "or-f", 3));
      }
      out.push(this.file(g.files[0][0], g.files[0][1], days === 0, "total_outflow_mean", "rank0.nc · time " + days + " / " + NDAY, NARROW ? "daily" : "daily means"));
      out.push(this.file(g.files[1][0], g.files[1][1], months === 0, "total_outflow_max_mean", "rank0.nc · time " + months + " / 12", NARROW ? "monthly" : "monthly maxima"));
      return out.join("");
    }
  };

  /* ------------------------------------------------------------ engine */
  var steps = [], figEls = {}, svgs = {}, dyn = {}, active = null, running = false;

  function build() {
    NARROW = typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
    Object.keys(FIGS).forEach(function (k) {
      var fig = FIGS[k], svg = svgs[k];
      if (!svg) return;
      var r = fig.build(NARROW);
      svg.setAttribute("viewBox", r.vb);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.innerHTML = r.s + '<g data-r="dyn"></g>';
      dyn[k] = svg.querySelector('[data-r="dyn"]');
      if (fig.after) fig.after(svg);
      if (fig.keep) fig.shown = null;
      dyn[k].innerHTML = fig.draw(0, performance.now()) || "";
    });
    paint(performance.now());
  }

  function request() { if (!running) { running = true; requestAnimationFrame(frame); } }
  function frame(now) {
    running = false;
    paint(now);
    if (active && FIGS[active] && FIGS[active].animated && !REDUCED) {
      var r = figEls[active].getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) request();
    }
  }

  function paint(now) {
    var vh = innerHeight, ref = NARROW ? vh * 0.86 : vh * 0.55, act = null, prog = 0;
    for (var i = 0; i < steps.length; i++) {
      var r = steps[i].getBoundingClientRect();
      if (r.top <= ref && r.bottom > ref) { act = steps[i]; prog = clamp((ref - r.top) / r.height, 0, 1); }
    }
    if (!act) {
      // between chapters: the first step of the nearest chapter below, or the last one above
      for (i = 0; i < steps.length; i++) {
        var rr = steps[i].getBoundingClientRect();
        if (rr.top > ref) { act = steps[i]; prog = 0; break; }
        act = steps[i]; prog = 1;
      }
    }
    if (!act) return;
    var name = act.getAttribute("data-fig");
    if (name !== active) {
      active = name;
      steps.forEach(function (s) { s.classList.toggle("on", s === act); });
      var stage = figEls[name] && figEls[name].parentElement;
      if (stage) Array.prototype.forEach.call(stage.querySelectorAll(".fig"), function (f) { f.classList.toggle("on", f === figEls[name]); });
    }
    var fig = FIGS[name];
    if (fig && dyn[name]) {
      var s = fig.draw(prog, now);
      if (!fig.keep || s) dyn[name].innerHTML = s;
    }
  }

  function init() {
    steps = Array.prototype.slice.call(document.querySelectorAll(".step"));
    Array.prototype.forEach.call(document.querySelectorAll(".fig"), function (f) {
      var k = f.getAttribute("data-fig");
      figEls[k] = f;
      svgs[k] = f.querySelector("svg");
    });
    // each stage starts on its first figure
    Array.prototype.forEach.call(document.querySelectorAll(".stage"), function (st) {
      var f = st.querySelector(".fig"); if (f) f.classList.add("on");
    });
    fitTitle();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTitle);
    HERO.init();
    buildBench();
    build();
    addEventListener("scroll", request, { passive: true });
    var lastNarrow = NARROW, rt = null;
    addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        fitTitle();
        if (HERO.cv) HERO.resize();
        var n = matchMedia("(max-width: 860px)").matches;
        if (n !== lastNarrow) { lastNarrow = n; build(); } else request();
      }, 120);
    });
    request();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.homeExample = EX;
})();
