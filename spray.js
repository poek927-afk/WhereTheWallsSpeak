// Spray paint over any page (every page but the title page), with a vertical
// toolbar on the left (see spray.css). The spray-can button turns spray mode
// on and off; the paint stays when it is off, and the page works normally
// again. The spray itself is the same as the Do It Yourself page: a soft
// cloud of paint plus droplets, sprayed every frame while the button is held,
// with drips if you hold still.
//
// Where the paint goes: each column keeps its own paint in a canvas inside
// it, drawn at the column's width when the page loaded and scaled to its
// current width, so it scrolls, grows and shrinks with the column like the
// rest of its content. Anything outside the columns (like a heading across
// the top) goes on one canvas over the whole page. A clear layer over the
// screen takes the strokes and sends each puff of paint to every canvas it
// touches, so strokes run across the whole screen without being cut off.
(function () {
  var root = document.documentElement;
  var MAX_UNDO = 10;

  // ---------- paint surfaces
  function makeCanvas(cls) {
    var c = document.createElement('canvas');
    c.className = cls;
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  // The page canvas sits in a box sized to the page's content, so the
  // canvas (which only grows) never makes the page itself taller.
  var page = { box: document.createElement('div'), canvas: makeCanvas('spray-page'), k: 1 };
  page.box.className = 'spray-pagebox';
  page.box.setAttribute('aria-hidden', 'true');
  page.ctx = page.canvas.getContext('2d');
  page.box.appendChild(page.canvas);
  document.body.appendChild(page.box);

  var cols = Array.prototype.map.call(document.querySelectorAll('.col'), function (host) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var box = document.createElement('div');
    box.className = 'spray-box';
    box.setAttribute('aria-hidden', 'true');
    var canvas = makeCanvas('spray-col');
    box.appendChild(canvas);
    host.appendChild(box);
    return { host: host, box: box, canvas: canvas, ctx: canvas.getContext('2d'), base: host.clientWidth || 1, k: 1 };
  });
  var surfaces = [page].concat(cols);

  // Takes the strokes while spray mode is on.
  var input = document.createElement('div');
  input.className = 'spray-input';
  input.setAttribute('aria-hidden', 'true');
  document.body.appendChild(input);

  var nozzle = document.createElement('div');
  nozzle.className = 'spray-nozzle';
  nozzle.setAttribute('aria-hidden', 'true');

  var COLORS = [
    ['#4dff4d', 'Green'], ['#f22ef2', 'Magenta'], ['#f4d84a', 'Yellow'],
    ['#2f8cff', 'Blue'], ['#d7262e', 'Red'], ['#ffffff', 'White'], ['#0b0b0b', 'Black']
  ];
  var CAN =
    '<svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<g fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round">' +
        '<path d="M26 4h7l1 7h-9z"/><rect x="22" y="12" width="16" height="3" rx="1.5"/>' +
        '<path d="M21 22c0-4.5 4-6.5 9-6.5s9 2 9 6.5z"/><rect x="19" y="23" width="22" height="3" rx="1.5"/>' +
        '<rect x="20" y="27" width="20" height="31"/><rect x="19" y="58.5" width="22" height="3" rx="1.5"/>' +
      '</g>' +
      '<g fill="#0b0b0b">' +
        '<path d="M26 4h7l1 7h-9z"/><rect x="22" y="12" width="16" height="3" rx="1.5"/>' +
        '<path d="M21 22c0-4.5 4-6.5 9-6.5s9 2 9 6.5z"/><rect x="19" y="23" width="22" height="3" rx="1.5"/>' +
        '<rect x="20" y="27" width="20" height="31"/><rect x="19" y="58.5" width="22" height="3" rx="1.5"/>' +
      '</g>' +
      '<circle cx="28" cy="7.3" r="1.4" fill="#fff"/>' +
      '<g class="spray-x" stroke-linecap="round">' +
        '<path d="M8 10 56 58M56 10 8 58" stroke="#fff" stroke-width="10"/>' +
        '<path d="M8 10 56 58M56 10 8 58" stroke="#e0242c" stroke-width="6"/>' +
      '</g>' +
    '</svg>';

  var tools = document.createElement('div');
  tools.className = 'spray-tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Spray paint');
  tools.setAttribute('aria-orientation', 'vertical');
  tools.innerHTML =
    '<button class="spray-toggle" type="button" aria-pressed="false" title="Spray paint">' + CAN +
      '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Spray paint</span></button>' +
    '<div class="spray-extra">' +
      '<fieldset class="spray-swatches" aria-label="Paint colour">' +
        COLORS.map(function (c, i) {
          return '<button class="spray-swatch" type="button" style="--c:' + c[0] + '" data-color="' + c[0] +
            '" aria-label="' + c[1] + '" aria-pressed="' + (i === 0) + '"></button>';
        }).join('') +
      '</fieldset>' +
      '<label class="spray-size">Size<input type="range" min="12" max="90" value="34" aria-label="Spray size"></label>' +
      '<button class="spray-btn" type="button" data-action="undo" disabled>Undo</button>' +
      '<button class="spray-btn" type="button" data-action="clear">Clear</button>' +
    '</div>';

  document.body.appendChild(nozzle);
  document.body.appendChild(tools);

  var toggle = tools.querySelector('.spray-toggle');
  var sizeInput = tools.querySelector('.spray-size input');
  var undoBtn = tools.querySelector('[data-action="undo"]');
  var clearBtn = tools.querySelector('[data-action="clear"]');
  var swatches = tools.querySelectorAll('.spray-swatch');

  // ---------- state
  var color = COLORS[0][0];
  var radius = +sizeInput.value;
  var spraying = false;
  var client = null;  // where the pointer is on screen
  var last = null;    // where it was last frame
  var wet = 0;        // paint built up at one spot; drips past a point
  var drips = [];
  var history = [];
  var step = null;    // the undo step for the stroke being sprayed

  // ---------- on / off
  function setMode(on) {
    root.classList.toggle('spray-on', on);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.title = on ? 'Turn spray paint off' : 'Spray paint';
    if (!on) stop();
  }
  toggle.addEventListener('click', function () {
    setMode(!root.classList.contains('spray-on'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.classList.contains('spray-on')) setMode(false);
  });

  // ---------- sizes. Canvases only ever grow, so painting is kept
  // (1 pixel per CSS pixel to keep memory down).
  function grow(s, w, h) {
    var c = s.canvas;
    if (w <= c.width && h <= c.height) return;
    var old = null;
    if (c.width && c.height) {
      old = document.createElement('canvas');
      old.width = c.width;
      old.height = c.height;
      old.getContext('2d').drawImage(c, 0, 0);
    }
    c.width = Math.max(w, c.width);
    c.height = Math.max(h, c.height);
    c.style.width = c.width + 'px';
    c.style.height = c.height + 'px';
    if (old) s.ctx.drawImage(old, 0, 0);
  }
  function fitCol(s) {
    s.k = (s.host.clientWidth || s.base) / s.base;
    s.canvas.style.transform = 'scale(' + s.k + ')';
    // The box covers all of the column's content, scrolled or not, and
    // hides any paint past its edges.
    s.box.style.height = '0px';
    var h = s.host.scrollHeight;
    s.box.style.height = h + 'px';
    grow(s, s.base, Math.ceil(h / s.k));
  }
  function fitPage() {
    page.box.style.height = '0px';
    var h = Math.max(root.scrollHeight, window.innerHeight);
    page.box.style.height = h + 'px';
    grow(page, root.clientWidth, h);
  }
  function resize() { fitPage(); cols.forEach(fitCol); }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('load', resize);
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(resize);
    ro.observe(document.body);
    cols.forEach(function (s) { ro.observe(s.host); });
  }

  // Where everything is on screen right now (worked out once per frame).
  var where = null;
  function measure() {
    where = surfaces.map(function (s) {
      return {
        s: s,
        canvas: s.canvas.getBoundingClientRect(),
        show: s.host ? s.host.getBoundingClientRect() : null
      };
    });
  }

  // ---------- the spray itself
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // Most droplets land near the middle; a few fly past the edge.
  function scatter(r) {
    var d = Math.sqrt(-2 * Math.log(1 - Math.random() * 0.999)) * r * 0.42;
    return Math.min(d, r * 1.5);
  }
  function puff(ctx, x, y, r, strength) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, 0.22 * strength));
    g.addColorStop(0.55, rgba(color, 0.12 * strength));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    var n = Math.round(r * 2.2 * strength);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var d = scatter(r);
      var s = Math.random() < 0.06 ? 1.2 + Math.random() * 1.6 : 0.4 + Math.random() * 0.9;
      ctx.globalAlpha = d > r ? 0.5 : 0.85;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function hits(box, x, y, R) {
    return x + R > box.left && x - R < box.right && y + R > box.top && y - R < box.bottom;
  }
  function inside(box, x, y, R) {
    return x - R >= box.left && x + R <= box.right && y - R >= box.top && y + R <= box.bottom;
  }

  // One puff at a point on screen, sent to every canvas it touches. Each
  // column gets it in its own (scaled) units; the page canvas gets it with
  // the columns cut out, so nothing is painted twice.
  function puffAt(x, y, strength) {
    var R = radius * 1.6;
    where.forEach(function (w) {
      var s = w.s;
      if (s === page) {
        if (where.some(function (o) { return o.show && inside(o.show, x, y, R); })) return;
        touch(s);
        var ctx = s.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, s.canvas.width, s.canvas.height);
        where.forEach(function (o) {
          if (o.show) ctx.rect(o.show.left - w.canvas.left, o.show.top - w.canvas.top, o.show.width, o.show.height);
        });
        ctx.clip('evenodd');
        puff(ctx, x - w.canvas.left, y - w.canvas.top, radius, strength);
        ctx.restore();
      } else if (hits(w.show, x, y, R)) {
        touch(s);
        puff(s.ctx, (x - w.canvas.left) / s.k, (y - w.canvas.top) / s.k, radius / s.k, strength);
      }
    });
  }

  function sprayAlong(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.hypot(dx, dy);
    var steps = Math.max(1, Math.ceil(dist / Math.max(2, radius * 0.22)));
    // Moving fast lays down less paint per spot, like a real can.
    var strength = Math.max(0.35, 1 - dist / (radius * 6));
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      puffAt(a.x + dx * t, a.y + dy * t, strength);
    }
    return dist;
  }

  // ---------- drips run down whichever canvas they start on
  function startDrip(x, y) {
    var w = where.filter(function (o) { return o.show && inside(o.show, x, y, 0); })[0] ||
            where.filter(function (o) { return o.s === page; })[0];
    var k = w.s.k;
    drips.push({
      s: w.s,
      x: (x + (Math.random() - 0.5) * radius * 0.8 - w.canvas.left) / k,
      y: (y + radius * 0.35 - w.canvas.top) / k,
      w: Math.max(2, radius * (0.08 + Math.random() * 0.06)) / k,
      left: radius * (1.2 + Math.random() * 2.5) / k,
      speed: (1.6 + Math.random() * 1.4) / k,
      color: color
    });
  }
  function runDrips() {
    for (var i = drips.length - 1; i >= 0; i--) {
      var d = drips[i];
      var c = d.s.ctx;
      var move = Math.min(d.speed, d.left);
      c.strokeStyle = d.color;
      c.lineWidth = d.w;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(d.x, d.y);
      c.lineTo(d.x, d.y + move);
      c.stroke();
      d.y += move;
      d.left -= move;
      d.speed *= 0.985;
      d.w *= 0.996;
      if (d.left <= 0 || d.speed < 0.15 / d.s.k) {
        c.fillStyle = d.color;
        c.beginPath();
        c.arc(d.x, d.y, d.w * 0.9, 0, Math.PI * 2);
        c.fill();
        drips.splice(i, 1);
      }
    }
  }

  // ---------- main loop: keeps spraying while the button is held
  var looping = false;
  function frame() {
    if (spraying && client) {
      measure();
      var moved = sprayAlong(last || client, client);
      last = { x: client.x, y: client.y };
      if (moved < radius * 0.15) {
        wet += 1;
        if (wet > 28 && Math.random() < 0.08) { startDrip(client.x, client.y); wet = 14; }
      } else {
        wet = Math.max(0, wet - 2);
      }
    }
    if (drips.length) runDrips();
    if (spraying || drips.length) requestAnimationFrame(frame);
    else looping = false;
  }
  function loop() {
    if (!looping) { looping = true; requestAnimationFrame(frame); }
  }

  // ---------- undo / clear. A stroke saves each canvas just before it
  // first paints on it, so one undo takes back the whole stroke.
  function grab(s) {
    return { s: s, img: s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height) };
  }
  function remember(st) {
    history.push(st);
    if (history.length > MAX_UNDO) history.shift();
    undoBtn.disabled = false;
  }
  function touch(s) {
    if (!step) { step = []; remember(step); }
    if (!step.some(function (g) { return g.s === s; })) step.push(grab(s));
  }
  function undo() {
    var st = history.pop();
    if (st) {
      drips = [];
      st.forEach(function (g) { g.s.ctx.putImageData(g.img, 0, 0); });
    }
    undoBtn.disabled = history.length === 0;
  }
  undoBtn.addEventListener('click', undo);
  clearBtn.addEventListener('click', function () {
    remember(surfaces.map(grab));
    drips = [];
    surfaces.forEach(function (s) { s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height); });
  });

  // ---------- pointer input. One finger sprays; two fingers scroll.
  // Whatever is under the pointer (a column or the page) scrolls, since the
  // input layer sits over everything.
  function scrollerAt(x, y) {
    input.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);
    input.style.pointerEvents = '';
    while (el && el !== document.body && el !== root) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return window;
  }

  var touches = new Map();
  var panY = null;
  var panTarget = null;
  function avgY() {
    var sum = 0;
    touches.forEach(function (p) { sum += p.y; });
    return sum / touches.size;
  }
  function stop() { spraying = false; client = null; last = null; step = null; }

  input.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // Second finger: this is a scroll, so take back the first finger's paint.
        if (spraying) { var had = step; stop(); if (had) undo(); }
        panY = avgY();
        panTarget = scrollerAt(e.clientX, e.clientY);
        return;
      }
      if (touches.size > 2) return;
    }
    input.setPointerCapture(e.pointerId);
    resize();
    step = null;
    spraying = true;
    client = { x: e.clientX, y: e.clientY };
    last = null;
    wet = 0;
    loop();
  });
  input.addEventListener('pointermove', function (e) {
    nozzle.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    if (e.pointerType === 'mouse') nozzle.classList.add('is-on');
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (panY !== null) {
        var y = avgY();
        panTarget.scrollBy(0, panY - y);
        panY = y;
        return;
      }
    }
    if (spraying) client = { x: e.clientX, y: e.clientY };
  });
  function up(e) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (panY !== null) { panY = touches.size >= 2 ? avgY() : null; return; }
    }
    stop();
  }
  input.addEventListener('pointerup', up);
  input.addEventListener('pointercancel', up);
  input.addEventListener('pointerleave', function () { nozzle.classList.remove('is-on'); });

  // Mouse wheel / trackpad: scroll whatever is under the pointer.
  input.addEventListener('wheel', function (e) {
    var t = scrollerAt(e.clientX, e.clientY);
    if (t !== window) {
      t.scrollBy(e.deltaX, e.deltaY);
      e.preventDefault();
    }
  }, { passive: false });

  // ---------- colour and size
  function setNozzle() {
    nozzle.style.setProperty('--d', radius * 2 + 'px');
    nozzle.style.setProperty('--paint', color);
  }
  swatches.forEach(function (s) {
    s.addEventListener('click', function () {
      color = s.dataset.color;
      swatches.forEach(function (o) { o.setAttribute('aria-pressed', String(o === s)); });
      setNozzle();
    });
  });
  sizeInput.addEventListener('input', function () {
    radius = +sizeInput.value;
    setNozzle();
  });
  setNozzle();
})();
