/* sabatiniartstudio — scroll-driven pixelation (see docs/scroll-effect.md)
   Images and text break into blocks as they near the top or bottom of the window. Inside
   the centre band nothing is drawn over them, so what shows is the original <img> or text.
   Text is handled line by line: only the lines near an edge break. The two marks are
   revealed in steps instead (MARK_STEPS). */
(function () {
  'use strict';

  /* ---------- Tuning ---------- */

  var BAND = 0.4;                  // centre band, as a fraction of the window height; sharp inside it
  var MAX_BLOCK = 1 / 24;          // largest block, as a fraction of the image's displayed width
  var MARK_CURVE = 1;              // marks step through their reveal evenly with distance from the band

  /* The mark's reveal (favicon_05 -> favicon_01): cells of the mark's 4 x 4 grid, each the size of
     the cut-out, that turn black at each step out from the band. [column, row] from the top left.
     At the window edge only [0, 0] and [3, 2] are still white. */
  var MARK_STEPS = [
    [[2, 2], [0, 1], [1, 0]],
    [[1, 3], [2, 1], [3, 0]],
    [[2, 3], [0, 2], [1, 1], [3, 1]],
    [[0, 3], [1, 2], [2, 0]]
  ];
  var CURVE = 3;                   // how block size grows outside the band: 1 = linear, higher = sharpens sooner
  var SMALL_SCREEN = 900;          // below this window width...
  var SMALL_SCREEN_SOURCE = 1000;  // ...the pixelation source is capped at this many pixels wide
  var RESIZE_DELAY = 150;          // ms to wait after the last resize before re-measuring

  var TEXT_MAX_BLOCK = 0.3;        // largest block for text, as a fraction of the line's font size
  var TEXT_INK = 2;                // layers of reduced text before scaling up: 1 = plain average (fades to
                                   // grey), 2+ keeps thin strokes and the red full stop from fading into black

  var TARGETS = '.sas-art__img, .sas-break__img';      // all lists skip the light ground (onDark)
  var MARK_TARGETS = '.sas-mark';
  var TEXT_TARGETS = '.sas-hero__lines, .sas-hero__name, .sas-title, .sas-art__collection, .sas-body, ' +
    '.sas-credit, .sas-edition, .sas-break__label, .sas-break__caption';   // everything but the menu

  /* ---------- State ---------- */

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var items = [];
  var texts = [];
  var running = false;
  var started = false;             // nothing is broken on load; the effect starts with the first scroll or resize
  var ticking = false;
  var resizeTimer = null;
  var scratch = null;              // shared offscreen canvas for the small pass
  var scratchCtx = null;

  /* The effect runs only on the black sections; nothing on the light ground is touched. */
  function onDark(el) {
    return !el.closest('.sas-light');
  }

  function createCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /* ---------- Setup ---------- */

  /* The element carrying the image's 1px frame: the figure for the artworks, the img for the hands. */
  function frameOf(el) {
    var candidates = [el, el.parentElement];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c) continue;
      var cs = getComputedStyle(c);
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') {
        return { el: c, color: cs.borderTopColor, background: cs.backgroundColor };
      }
    }
    return null;
  }

  function setup(el) {
    var host = el.parentElement;
    var canvas = document.createElement('canvas');
    canvas.className = 'sas-pixelate-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.classList.add('sas-pixelate-host');
    el.insertAdjacentElement('afterend', canvas);

    return {
      el: el,
      host: host,
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      frame: frameOf(el),          // the image and its border break together
      inner: null,                 // where the image sits inside the canvas, CSS px
      cssW: 0,
      res: 0,                      // width in pixels that block sizes are measured against
      resH: 0,
      sizeKey: '',
      levels: null,                // downscaled copies of the image: [full, 1/2, 1/4, ...]
      lastN: -1,                   // blocks across at the last draw; -1 = nothing drawn
      active: false,
      failed: false,
      waiting: false
    };
  }

  /* Place the canvas over the image and its frame (or the mark) and size its backing store. */
  function measure(item) {
    var el = item.el;
    var r = el.getBoundingClientRect();
    var h = item.host.getBoundingClientRect();
    var ix = r.left + (el.clientLeft || 0), iy = r.top + (el.clientTop || 0);      // image content box
    var iw = el.clientWidth;
    var ih = el.clientHeight;
    var box = item.frame ? item.frame.el.getBoundingClientRect() : { left: ix, top: iy, width: iw, height: ih };
    var w = box.width, ht = box.height;
    var left = box.left - h.left - item.host.clientLeft;
    var top = box.top - h.top - item.host.clientTop;
    var style = item.canvas.style;
    item.inner = { x: ix - box.left, y: iy - box.top, w: iw, h: ih };
    item.cssW = w;

    style.left = left + 'px';
    style.top = top + 'px';
    style.width = w + 'px';
    style.height = ht + 'px';

    var dpr = window.devicePixelRatio || 1;
    item.dpr = dpr;
    var key = w + 'x' + ht + '@' + dpr + (window.innerWidth < SMALL_SCREEN ? 's' : '');
    if (key === item.sizeKey || !w || !ht) return;

    item.sizeKey = key;
    item.canvas.width = Math.max(1, Math.round(w * dpr));
    item.canvas.height = Math.max(1, Math.round(ht * dpr));

    var res = item.canvas.width;
    if (item.el.naturalWidth) res = Math.min(res, Math.round(item.el.naturalWidth * w / iw));
    if (window.innerWidth < SMALL_SCREEN) res = Math.min(res, SMALL_SCREEN_SOURCE);
    item.res = res;
    item.resH = Math.max(1, Math.round(res * ht / w));
    item.levels = null;
    item.lastN = -1;
  }

  /* Downscale the image once to the working size, then keep halving it, so each frame's
     reduction is at most 2:1 and a plain bilinear draw still averages every pixel. */
  function ensureSource(item) {
    if (item.levels) return true;
    var img = item.el;

    if (!img.complete || !img.naturalWidth) {
      if (!item.waiting) {
        item.waiting = true;
        img.addEventListener('load', function () {
          item.waiting = false;
          item.sizeKey = '';
          measure(item);
          request();
        }, { once: true });
      }
      return false;
    }

    if (!item.res) measure(item);

    try {
      var base = createCanvas(item.res, item.resH);
      var ctx = base.getContext('2d');
      var s = item.res / item.cssW, f = item.frame, inner = item.inner;
      if (f) {
        // The frame as it looks on the page: its background, then the border colour over it.
        ctx.fillStyle = f.background;
        ctx.fillRect(0, 0, item.res, item.resH);
        ctx.fillStyle = f.color;
        ctx.fillRect(0, 0, item.res, item.resH);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, inner.x * s, inner.y * s, inner.w * s, inner.h * s);
      ctx.getImageData(0, 0, 1, 1);  // throws if the canvas is tainted

      var levels = [base];
      var prev = base;
      while (prev.width > 16 && prev.height > 16) {
        var next = createCanvas(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
        var nctx = next.getContext('2d');
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = 'high';
        nctx.drawImage(prev, 0, 0, next.width, next.height);
        levels.push(next);
        prev = next;
      }
      item.levels = levels;
      return true;
    } catch (e) {
      fail(item);
      return false;
    }
  }

  /* Anything unreadable falls back to the plain element for good. */
  function fail(item) {
    item.failed = true;
    item.levels = null;
    if (item.frame) item.frame.el.classList.remove('sas-pixelate-frame-hidden');
    if (item.canvas.parentNode) item.canvas.parentNode.removeChild(item.canvas);
  }

  /* While the canvas shows, the CSS border is hidden: the canvas draws the frame itself. */
  function setActive(item, on) {
    if (item.active === on) return;
    item.active = on;
    item.canvas.classList.toggle('is-active', on);
    if (item.frame) item.frame.el.classList.toggle('sas-pixelate-frame-hidden', on);
  }

  /* ---------- Drawing ---------- */

  function draw(item, n) {
    var m = Math.max(1, Math.round(n * item.resH / item.res));

    growScratch(n, m);

    var levels = item.levels;
    var src = levels[0];
    for (var i = 1; i < levels.length && levels[i].width >= n && levels[i].height >= m; i++) src = levels[i];
    scratchCtx.imageSmoothingEnabled = true;
    scratchCtx.imageSmoothingQuality = 'low';
    scratchCtx.drawImage(src, 0, 0, src.width, src.height, 0, 0, n, m);

    var ctx = item.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, n, m, 0, 0, item.canvas.width, item.canvas.height);
  }

  /* ---------- Marks ----------
     Each mark is revealed in steps: black squares the size of its cut-out appear over it, a
     few more at each step, as it moves from the band to the window edge (MARK_STEPS). They
     are plain SVG squares added inside the mark, so the mark stays pure white and black. */

  var marks = [];

  function setupMark(svg) {
    var ns = 'http://www.w3.org/2000/svg';
    var group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'sas-mark__cells');
    var steps = MARK_STEPS.map(function (cells) {
      return cells.map(function (c) {
        var rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', c[0]);
        rect.setAttribute('y', c[1]);
        rect.setAttribute('width', 1);
        rect.setAttribute('height', 1);
        rect.setAttribute('fill', '#000');
        rect.setAttribute('visibility', 'hidden');
        group.appendChild(rect);
        return rect;
      });
    });
    svg.appendChild(group);
    return { el: svg, group: group, steps: steps, level: 0, failed: false };
  }

  function tickMark(mark, vh) {
    var r = mark.el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || !r.width) return;      // entirely off screen
    var s = strength(r.top + r.height / 2, vh, MARK_CURVE);
    // Band = the whole mark; each further step covers an equal share of the way to the edge.
    var level = Math.min(MARK_STEPS.length, Math.floor(s * (MARK_STEPS.length + 1)));
    if (level === mark.level) return;
    mark.level = level;
    for (var i = 0; i < mark.steps.length; i++) {
      for (var j = 0; j < mark.steps[i].length; j++) {
        mark.steps[i][j].setAttribute('visibility', i < level ? 'visible' : 'hidden');
      }
    }
  }

  function removeMark(mark) {
    if (mark.group.parentNode) mark.group.parentNode.removeChild(mark.group);
  }

  /* ---------- Text ----------
     Each text element gets a canvas, appended to its section so no sibling selectors are
     affected. Each line is drawn once, crisply, from its words at their measured positions
     (kept only while the element is near the window). A line that needs blocks is covered
     with black and redrawn from that copy exactly like an image. Lines inside the band are
     left as real text. */

  var TEXT_KEEP = 1;               // keep line copies for elements within this many window heights
  var TEXT_BUILD_BUDGET = 3;       // ms per frame spent preparing lines ahead of the window

  var styleCache = null;

  function textStyle(el) {
    var cached = styleCache.get(el);
    if (cached) return cached;
    var cs = getComputedStyle(el);
    var px = parseFloat(cs.fontSize);
    // Bodoni is set at a fixed optical size; draw at that size and scale up so the letterforms match.
    var opsz = /"opsz"\s+([\d.]+)/.exec(cs.fontVariationSettings || '');
    var drawPx = opsz ? parseFloat(opsz[1]) : px;
    var font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + drawPx + 'px ' + cs.fontFamily;
    var ls = parseFloat(cs.letterSpacing) || 0;
    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.font = font;
    var ascent = scratchCtx.measureText('Hg').fontBoundingBoxAscent;
    var style = {
      font: font,
      color: cs.color,
      px: px,
      k: px / drawPx,
      ls: ls ? (ls * drawPx / px) + 'px' : '0px',
      ascent: ascent * px / drawPx
    };
    styleCache.set(el, style);
    return style;
  }

  function setupText(el) {
    var section = el.closest('.sas-section') || el.parentElement;
    var canvas = document.createElement('canvas');
    canvas.className = 'sas-pixelate-text';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = 0;
    canvas.height = 0;
    section.classList.add('sas-pixelate-host');
    section.appendChild(canvas);
    return { el: el, host: section, canvas: canvas, ctx: canvas.getContext('2d'), lines: [], allocated: false, failed: false };
  }

  /* Find every word's box, group the words into lines, and place the canvas over the element. */
  function measureText(item) {
    var el = item.el;
    var er = el.getBoundingClientRect();
    var hr = item.host.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var em = parseFloat(getComputedStyle(el).fontSize) || 16;
    var padX = Math.ceil(em * 0.25);
    var padY = Math.ceil(em * 0.3);
    var style = item.canvas.style;

    style.left = (er.left - hr.left - item.host.clientLeft - padX) + 'px';
    style.top = (er.top - hr.top - item.host.clientTop - padY) + 'px';
    style.width = (er.width + 2 * padX) + 'px';
    style.height = (er.height + 2 * padY) + 'px';
    item.devW = Math.round((er.width + 2 * padX) * dpr);
    item.devH = Math.round((er.height + 2 * padY) * dpr);
    item.dpr = dpr;
    release(item);

    var ox = er.left - padX, oy = er.top - padY;   // canvas origin, viewport px
    var range = document.createRange();
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var lines = [], line = null, node, match, re = /\S+/g;

    while ((node = walker.nextNode())) {
      var st = textStyle(node.parentElement);
      re.lastIndex = 0;
      while ((match = re.exec(node.data))) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        var r = rects[0];
        if (!line || Math.abs(r.top - line.top) > 2) {
          line = { top: r.top, words: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, px: 0 };
          lines.push(line);
        }
        line.words.push({ text: match[0], x: r.left - ox, baseline: r.top - oy + st.ascent, style: st });
        line.x0 = Math.min(line.x0, r.left - ox);
        line.x1 = Math.max(line.x1, r.right - ox);
        line.y0 = Math.min(line.y0, r.top - oy);
        line.y1 = Math.max(line.y1, r.bottom - oy);
        line.px = Math.max(line.px, st.px);
      }
    }

    item.lines = lines.map(function (l) {
      var bleed = l.px * 0.08;
      var dx = Math.max(0, Math.floor((l.x0 - bleed) * dpr));
      var dy = Math.max(0, Math.floor((l.y0 - 1) * dpr));
      var dw = Math.min(item.devW, Math.ceil((l.x1 + bleed) * dpr)) - dx;
      var dh = Math.min(item.devH, Math.ceil((l.y1 + 1) * dpr)) - dy;
      return {
        words: l.words,
        centre: (l.y0 + l.y1) / 2 - padY,      // from the element's top edge, CSS px
        maxBlock: Math.max(1, TEXT_MAX_BLOCK * l.px * dpr),
        dx: dx, dy: dy, dw: dw, dh: dh,
        n: 0, m: 0                              // blocks across and down; 0 = sharp
      };
    });
  }

  function release(item) {
    if (!item.allocated) return;
    item.canvas.width = 0;
    item.canvas.height = 0;
    item.small = item.smallCtx = null;
    item.allocated = false;
    for (var i = 0; i < item.lines.length; i++) item.lines[i].n = 0;
  }

  function failText(item) {
    item.failed = true;
    if (item.canvas.parentNode) item.canvas.parentNode.removeChild(item.canvas);
  }

  /* A crisp copy of the line at device resolution, plus halved copies for cheap averaging. */
  function buildLine(item, line) {
    var dpr = item.dpr, lx = line.dx / dpr, ly = line.dy / dpr;
    var base = createCanvas(line.dw, line.dh);
    var ctx = base.getContext('2d'), font = null, color = null;
    ctx.textBaseline = 'alphabetic';
    for (var i = 0; i < line.words.length; i++) {
      var w = line.words[i], st = w.style;
      if (st.font !== font) { ctx.font = font = st.font; if ('letterSpacing' in ctx) ctx.letterSpacing = st.ls; }
      if (st.color !== color) ctx.fillStyle = color = st.color;
      ctx.setTransform(dpr * st.k, 0, 0, dpr * st.k, dpr * (w.x - lx), dpr * (w.baseline - ly));
      ctx.fillText(w.text, 0, 0);
    }
    var levels = [base], prev = base;
    while (prev.width > 16 && prev.height > 4) {
      var next = createCanvas(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
      var nctx = next.getContext('2d');
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(prev, 0, 0, next.width, next.height);
      levels.push(next);
      prev = next;
    }
    line.levels = levels;
  }

  function buildLines(item, deadline) {
    for (var i = 0; i < item.lines.length; i++) {
      if (!item.lines[i].levels) {
        if (deadline && performance.now() > deadline) return false;
        buildLine(item, item.lines[i]);
      }
    }
    item.built = true;
    return true;
  }

  function dropLines(item) {
    if (!item.built && !item.lines.some(function (l) { return l.levels; })) return;
    for (var i = 0; i < item.lines.length; i++) item.lines[i].levels = null;
    item.built = false;
  }

  /* Reduce every breaking line into the element's own small canvas, stacked, then scale them
     all up in a second pass. Reading a canvas after writing to it makes the browser copy it,
     so writing everything first means one copy per element per frame, not one per line. */
  function drawLines(item, list) {
    var w = 0, h = 0, i, line;
    for (i = 0; i < list.length; i++) {
      w = Math.max(w, list[i].n);
      h += list[i].m;
    }
    if (!item.small) {
      item.small = createCanvas(w, h);
      item.smallCtx = item.small.getContext('2d');
    } else if (item.small.width < w || item.small.height < h) {
      item.small.width = Math.max(item.small.width, w);
      item.small.height = Math.max(item.small.height, h);
    }

    var sctx = item.smallCtx, y = 0;
    sctx.clearRect(0, 0, w, h);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'low';
    for (i = 0; i < list.length; i++) {
      line = list[i];
      if (!line.levels) buildLine(item, line);
      var levels = line.levels, src = levels[0];
      for (var j = 1; j < levels.length && levels[j].width >= line.n && levels[j].height >= line.m; j++) src = levels[j];
      sctx.globalAlpha = 1;
      sctx.drawImage(src, 0, 0, src.width, src.height, 0, y, line.n, line.m);
      sctx.globalAlpha = line.s;          // extra ink grows with the block size, so near-sharp lines keep their weight
      for (var k = 1; k < TEXT_INK; k++) sctx.drawImage(src, 0, 0, src.width, src.height, 0, y, line.n, line.m);
      line.sy = y;
      y += line.m;
    }

    sctx.globalAlpha = 1;
    var ctx = item.ctx;
    ctx.imageSmoothingEnabled = false;
    for (i = 0; i < list.length; i++) {
      line = list[i];
      ctx.drawImage(item.small, 0, line.sy, line.n, line.m, line.dx, line.dy, line.dw, line.dh);
    }
  }

  function tickText(item, vh, deadline) {
    if (!item.lines.length) return;
    var r = item.el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || !r.width) {        // entirely off screen: free the canvas
      release(item);
      var away = r.bottom <= 0 ? -r.bottom : r.top - vh;
      if (away > (TEXT_KEEP + 1) * vh) dropLines(item);     // far away: free the line copies too
      else if (!item.built && away < TEXT_KEEP * vh) buildLines(item, deadline);   // coming up: prepare
      return;
    }

    var changed = false, any = false, i, line;
    for (i = 0; i < item.lines.length; i++) {
      line = item.lines[i];
      var s = strength(r.top + line.centre, vh);
      var block = 1 + (line.maxBlock - 1) * s;
      line.s = s;
      var n = Math.max(1, Math.round(line.dw / block));
      var m = Math.max(1, Math.round(line.dh / block));
      if (n >= line.dw) n = m = 0;                          // block size 1: leave the real text
      if (n !== line.n || m !== line.m) { line.n = n; line.m = m; changed = true; }
      if (n) any = true;
    }
    if (!changed) return;
    if (!any) { release(item); return; }

    if (!item.allocated) {
      item.canvas.width = item.devW;
      item.canvas.height = item.devH;
      item.allocated = true;
    }
    // Redraw the whole element: neighbouring lines' boxes can overlap.
    var ctx = item.ctx, list = [];
    ctx.clearRect(0, 0, item.devW, item.devH);
    ctx.fillStyle = '#000';
    for (i = 0; i < item.lines.length; i++) {
      line = item.lines[i];
      if (line.n) {
        ctx.fillRect(line.dx, line.dy, line.dw, line.dh);
        list.push(line);
      }
    }
    drawLines(item, list);
  }

  function setupTexts() {
    if (!running || texts.length) return;
    if (!scratch) { scratch = createCanvas(1, 1); scratchCtx = scratch.getContext('2d'); }
    styleCache = new Map();
    texts = Array.prototype.slice.call(document.querySelectorAll(TEXT_TARGETS)).filter(onDark).map(setupText);
    texts.forEach(function (item) {
      try { measureText(item); } catch (e) { failText(item); }
    });
    request();
  }

  function remeasureTexts() {
    styleCache = new Map();
    texts.forEach(function (item) {
      if (item.failed) return;
      try { measureText(item); } catch (e) { failText(item); }
    });
  }

  function growScratch(n, m) {
    if (!scratch) {
      scratch = createCanvas(n, m);
      scratchCtx = scratch.getContext('2d');
    }
    if (scratch.width < n || scratch.height < m) {
      scratch.width = Math.max(scratch.width, n);
      scratch.height = Math.max(scratch.height, m);
    }
  }

  /* ---------- Frame ---------- */

  /* 0 inside the centre band, rising to 1 at the window edge along CURVE. */
  function strength(centre, vh, curve) {
    if (!started) return 0;
    var reach = vh * (1 - BAND) / 2;      // distance from the band's edge to the window's edge
    var t = Math.min(1, Math.max(0, reach - centre, centre - (vh - reach)) / reach);
    return Math.pow(t, curve || CURVE);
  }

  function tick() {
    ticking = false;
    if (!running) return;

    var vh = window.innerHeight;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.failed || !item.res) continue;

      var r = item.el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || !r.width) continue;   // entirely off screen

      var maxBlock = Math.max(1, item.res * MAX_BLOCK);
      var block = 1 + (maxBlock - 1) * strength(r.top + r.height / 2, vh);
      var n = Math.max(1, Math.round(item.res / block));

      if (n >= item.res) {                 // block size 1: show the original <img>
        setActive(item, false);
        item.lastN = -1;
        continue;
      }
      if (n === item.lastN) continue;      // same block size as the last frame
      if (!ensureSource(item)) continue;

      try {
        draw(item, n);
      } catch (e) {
        fail(item);
        continue;
      }
      item.lastN = n;
      setActive(item, true);
    }

    for (var q = 0; q < marks.length; q++) {
      if (marks[q].failed) continue;
      try {
        tickMark(marks[q], vh);
      } catch (e) {
        marks[q].failed = true;
        removeMark(marks[q]);
      }
    }

    var deadline = performance.now() + TEXT_BUILD_BUDGET;
    for (var j = 0; j < texts.length; j++) {
      if (!texts[j].failed) {
        try {
          tickText(texts[j], vh, deadline);
        } catch (e) {
          failText(texts[j]);
        }
      }
    }
  }

  function request() {
    if (!ticking && running) {
      ticking = true;
      window.requestAnimationFrame(tick);
    }
  }

  /* ---------- Events ---------- */

  function onScroll() {
    started = true;
    request();
  }

  function onResize() {
    started = true;
    request();
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      items.forEach(function (item) { if (!item.failed) measure(item); });
      remeasureTexts();
      request();
    }, RESIZE_DELAY);
  }

  function remeasure() {
    if (!running) return;
    items.forEach(function (item) { if (!item.failed) measure(item); });
    remeasureTexts();
    request();
  }

  /* Build image sources ahead of time, off the scroll path. */
  function prepare() {
    var idle = window.requestIdleCallback || function (fn) { return window.setTimeout(fn, 200); };
    items.forEach(function (item) {
      idle(function () {
        if (running && !item.failed && !item.levels) ensureSource(item);
      });
    });
  }

  function start() {
    if (running || !window.HTMLCanvasElement) return;
    running = true;
    items = Array.prototype.slice.call(document.querySelectorAll(TARGETS)).filter(onDark).map(setup);
    marks = [];
    Array.prototype.filter.call(document.querySelectorAll(MARK_TARGETS), onDark).forEach(function (svg) {
      try { marks.push(setupMark(svg)); } catch (e) { /* the plain mark stays */ }
    });
    items.forEach(measure);

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('load', remeasure);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { remeasure(); setupTexts(); });
    } else {
      window.addEventListener('load', setupTexts);
    }

    prepare();
    request();
  }

  function stop() {
    if (!running) return;
    running = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('load', remeasure);
    items.concat(texts).forEach(function (item) {
      if (item.frame) item.frame.el.classList.remove('sas-pixelate-frame-hidden');
      if (item.canvas.parentNode) item.canvas.parentNode.removeChild(item.canvas);
    });
    marks.forEach(removeMark);
    items = [];
    texts = [];
    marks = [];
  }

  function onMotionPreference() {
    if (reduceMotion.matches) stop();
    else start();
  }

  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionPreference);
  else if (reduceMotion.addListener) reduceMotion.addListener(onMotionPreference);

  if (!reduceMotion.matches) start();
})();
