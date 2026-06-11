const API = '/api';

// ─── State ────────────────────────────────────────────────────────────────────
let scale = 0.72, ox = 0, oy = 0;
let dragging = false, sx, sy, sox, soy;
let allCards = [];
let cardPositions = {};   // title -> { x, y, w, h }
let activeTypes = new Set();
let hoveredTitle = null;

// ─── Elements ─────────────────────────────────────────────────────────────────
const wrap       = document.getElementById('canvas-wrap');
const canvas     = document.getElementById('canvas');
const hint       = document.getElementById('hint');
const genBtn     = document.getElementById('gen-btn');
const textInput  = document.getElementById('text-input');
const pdfInput   = document.getElementById('pdf-input');
const loadingEl  = document.getElementById('loading-overlay');
const loadingMsg = document.getElementById('loading-msg');
const docName    = document.getElementById('doc-name');
const explPanel  = document.getElementById('explain-panel');
const explTitle  = document.getElementById('explain-title');
const explBody   = document.getElementById('explain-body');
const filterEl   = document.getElementById('filter-pills');

// ─── Canvas pan / zoom ────────────────────────────────────────────────────────
function applyT() {
  canvas.style.transform = `translate(${ox}px,${oy}px) scale(${scale})`;
}
applyT();

function centerOnMain() {
  if (placedCache.length === 0) return;
  const rect = wrap.getBoundingClientRect();

  // Compute bounding box of all placed cards
  const minX = Math.min(...placedCache.map(c => c.x));
  const minY = Math.min(...placedCache.map(c => c.y));
  const maxX = Math.max(...placedCache.map(c => c.x + (c.w || CARD_W)));
  const maxY = Math.max(...placedCache.map(c => c.y + (c.h || 160)));

  const contentW = maxX - minX;
  const contentH = maxY - minY;

  // Fit to viewport with padding
  const PAD = 80;
  const fitScale = Math.min(
    (rect.width - PAD * 2) / contentW,
    (rect.height - PAD * 2) / contentH,
    1.0
  );
  scale = Math.max(0.25, fitScale);

  ox = (rect.width - contentW * scale) / 2 - minX * scale;
  oy = (rect.height - contentH * scale) / 2 - minY * scale;
  applyT();
}

wrap.addEventListener('mousedown', e => {
  if (e.target === wrap || e.target === canvas || e.target.tagName === 'svg' || e.target.tagName === 'line') {
    dragging = true; sx = e.clientX; sy = e.clientY; sox = ox; soy = oy;
  }
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  ox = sox + e.clientX - sx;
  oy = soy + e.clientY - sy;
  applyT();
});
window.addEventListener('mouseup', () => dragging = false);
wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = wrap.getBoundingClientRect();
  
  // Center of the visible area (viewport center)
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  const prevScale = scale;
  scale = Math.max(0.3, Math.min(2.5, scale - e.deltaY * 0.001));

  // Zoom toward the center of the screen
  ox = centerX - (centerX - ox) * (scale / prevScale);
  oy = centerY - (centerY - oy) * (scale / prevScale);

  applyT();
}, { passive: false });

document.getElementById('reset-btn').onclick = () => { centerOnMain(); };

// ─── Card type config — built dynamically ────────────────────────────────────
const PALETTE = [
  '#7F77DD', '#EF9F27', '#1D9E75', '#E24B4A',
  '#888780', '#4A9ED4', '#C45AB3', '#5B8C5A',
  '#D4763B', '#6B7FD4',
];

let TYPE_META = {};

// ─── Formula rendering ────────────────────────────────────────────────────────
function renderSummary(text) {
  if (!text) return '';
  const parts = text.split(/(\[\[formula\]\][\s\S]*?\[\[\/formula\]\])/g);
  return parts.map(part => {
    const match = part.match(/^\[\[formula\]\]([\s\S]*?)\[\[\/formula\]\]$/);
    if (match) {
      const latex = match[1].trim();
      try {
        return katex.renderToString(latex, { throwOnError: false, displayMode: false });
      } catch (e) {
        return `<code class="formula-fallback">${latex}</code>`;
      }
    }
    // Escape HTML for plain text parts
    return part.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }).join('');
}

function buildTypeMeta(cards) {
  const types = [...new Set(cards.map(c => c.type))];
  TYPE_META = {};
  types.forEach((type, i) => {
    TYPE_META[type] = {
      label: type.charAt(0).toUpperCase() + type.slice(1),
      color: PALETTE[i % PALETTE.length],
    };
  });
}

// ─── Layout — radial placement + angle-based collision resolution ─────────────
const CARD_W = 200;
const MAIN_W = 230, SUB_W = 200, DETAIL_W = 178;

// Padding used only for collision detection — rectangular, scales with card height
const PADDING = 30;

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// AABB overlap test using real w/h + rectangular padding
function overlaps(a, b) {
  const pad = PADDING;
  return (
    a.x         < b.x + b.w + pad &&
    a.x + a.w + pad > b.x         &&
    a.y         < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

// Check card c against all cards in the `placed` array (by index up to `count`)
function overlapsAny(c, placed, count) {
  for (let i = 0; i < count; i++) {
    if (placed[i] === c) continue;
    if (overlaps(c, placed[i])) return true;
  }
  return false;
}

// ── Phase 1: radial placement (stores angle on every card) ───────────────────
function scatterPositions(cards) {
  const mains   = cards.filter(c => c.level === 'main');
  const subs    = cards.filter(c => c.level === 'sub');
  const details = cards.filter(c => c.level === 'detail');
  const rest    = cards.filter(c => !['main','sub','detail'].includes(c.level));

  const positioned = [];
  const posMap = {};  // title -> { cx, cy }

  // 1. Compact horizontal placement for mains (packed close together)
  // We deliberately start them tight so the layout feels dense instead of spread out.
  const CY_BASE = 520;
  let curX = 60;                    // left margin
  const MAIN_GAP = 300;              // gap between edges of adjacent mains (resolver will push if needed)

  const mainClusters = mains.map(main => {
    const subsCount = subs.filter(s => (s.relatedTo || [])[0] === main.title).length;
    const detailsCount = details.filter(d => {
      const ps = subs.find(s => s.title === (d.relatedTo || [])[0]);
      return ps && (ps.relatedTo || [])[0] === main.title;
    }).length;
    const weight = 1 + subsCount * 1.2 + detailsCount * 0.6;
    return { main, weight: Math.max(weight, 1.5), subsCount };
  });

  mainClusters.forEach(cluster => {
    const h = hash(cluster.main.title);
    const yRange = 140 - Math.min(cluster.subsCount * 14, 90);
    const yOff = ((h % 1000) / 1000 - 0.5) * yRange;

    const cx = curX + MAIN_W / 2;
    const cy = CY_BASE + yOff;

    posMap[cluster.main.title] = { cx, cy };
    positioned.push({
      ...cluster.main,
      x: cx - MAIN_W / 2,
      y: cy - 82,
      w: MAIN_W,
      h: 170,
      angle: 0,
    });
    curX += MAIN_W + MAIN_GAP;
  });

  // 2. Subs orbit their main — full 360° with strong jitter so they actually scatter
  const subsByParent = {};
  subs.forEach(card => {
    const parent = (card.relatedTo || [])[0] || (mains[0]?.title || '__none__');
    if (!subsByParent[parent]) subsByParent[parent] = [];
    subsByParent[parent].push(card);
  });

  Object.entries(subsByParent).forEach(([parentTitle, group]) => {
    const pc = posMap[parentTitle] || { cx: 200, cy: CY_BASE };
    const count = group.length;
    const baseRadius = 310 + count * 38;
    const arcSpread = Math.PI * 2;

    // Random starting angle so the pattern doesn't always align to axes
    const startAngle = ((hash(parentTitle + 'ang') % 628) / 100) - Math.PI;

    group.forEach((card, i) => {
      const t = count === 1 ? 0.5 : i / count;
      const baseAngle = startAngle + arcSpread * t;

      const h = hash(card.title);
      const rJitter = ((h & 0xFF) / 255 - 0.5) * 150;
      const aJitter = (((h >> 8) & 0xFF) / 255 - 0.5) * 1.1; // stronger jitter to break cross patterns
      const angle   = baseAngle + aJitter;
      const r       = baseRadius + rJitter;

      const cx = pc.cx + r * Math.cos(angle);
      const cy = pc.cy + r * Math.sin(angle);

      posMap[card.title] = { cx, cy };
      positioned.push({
        ...card,
        x: cx - SUB_W / 2,
        y: cy - 77,
        w: SUB_W,
        h: 155,
        angle,
      });
    });
  });

  // 3. Details orbit their sub — now full 180° outward spread + stronger jitter
  const detailsByParent = {};
  details.forEach(card => {
    const parent = (card.relatedTo || [])[0] || '__none__';
    if (!detailsByParent[parent]) detailsByParent[parent] = [];
    detailsByParent[parent].push(card);
  });

  Object.entries(detailsByParent).forEach(([parentTitle, group]) => {
    const pc = posMap[parentTitle];
    if (!pc) return;

    const parentSub  = subs.find(s => s.title === parentTitle);
    const mainTitle  = parentSub ? (parentSub.relatedTo || [])[0] : null;
    const mc         = mainTitle ? posMap[mainTitle] : null;

    const outward = mc
      ? Math.atan2(pc.cy - mc.cy, pc.cx - mc.cx)
      : Math.atan2(pc.cy - CY_BASE, pc.cx);

    const count = group.length;
    const baseRadius = 255 + count * 26;
    const spread = Math.PI; // 180° — changed from ~153° (0.85π)

    // Small random offset so details don't always start at the exact outward ray
    const startOffset = ((hash(parentTitle + 'd') % 200) / 100 - 1) * 0.6;

    group.forEach((card, i) => {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const baseAngle = outward + startOffset + (spread * (t - 0.5));

      const h = hash(card.title);
      const rJitter = ((h & 0xFF) / 255 - 0.5) * 110;
      const aJitter = (((h >> 8) & 0xFF) / 255 - 0.5) * 0.9;
      const angle   = baseAngle + aJitter;
      const r       = baseRadius + rJitter;

      const cx = pc.cx + r * Math.cos(angle);
      const cy = pc.cy + r * Math.sin(angle);

      posMap[card.title] = { cx, cy };
      positioned.push({
        ...card,
        x: cx - DETAIL_W / 2,
        y: cy - 70,
        w: DETAIL_W,
        h: 140,
        angle,
      });
    });
  });

  // Orphans / rest
  const maxY = positioned.reduce((m, c) => Math.max(m, c.y + c.h), 0);
  let ox2 = 60;
  [...subs.filter(s => !mains.find(m => m.title === (s.relatedTo||[])[0])),
   ...details.filter(d => !subs.find(s => s.title === (d.relatedTo||[])[0])),
   ...rest
  ].forEach((card, i) => {
    positioned.push({ ...card, x: ox2, y: maxY + 90, w: SUB_W, h: 155, angle: 0 });
    ox2 += SUB_W + 28;
  });

  return positioned;
}

// ── Phase 2: angle-based collision resolver (runs after DOM heights known) ────
const RESOLVE_STEP = 14;  // px to move per step along angle
const DEG = Math.PI / 180;

function resolveCollisions(cards) {
  // Process order: mains are anchors (skip), then subs, then details
  const order = [
    ...cards.filter(c => c.level === 'main'),
    ...cards.filter(c => c.level === 'sub'),
    ...cards.filter(c => c.level === 'detail'),
    ...cards.filter(c => !['main','sub','detail'].includes(c.level)),
  ];

  // Index into `order` for fast lookup — mains are frozen
  const frozen = new Set(cards.filter(c => c.level === 'main').map(c => c.title));

  for (let ci = 0; ci < order.length; ci++) {
    const card = order[ci];
    if (frozen.has(card.title)) continue;  // mains don't move

    const settled = order.slice(0, ci);   // already-resolved cards
    if (!overlapsAny(card, settled, settled.length)) continue;  // already clear

    // Search outward along original angle, trying ±delta offsets
    // Increase distance ring when all angles at current ring are blocked
    let found = false;
    const origAngle = card.angle || 0;
    const origX = card.x, origY = card.y;

    outer:
    for (let ring = 1; ring <= 120; ring++) {
      const dist = ring * RESOLVE_STEP;
      for (let deltaSteps = 0; deltaSteps <= 18; deltaSteps++) {
        const delta = deltaSteps * 10 * DEG;
        const tries = delta === 0 ? [origAngle] : [origAngle + delta, origAngle - delta];

        for (const a of tries) {
          card.x = origX + Math.cos(a) * dist;
          card.y = origY + Math.sin(a) * dist;
          if (!overlapsAny(card, settled, settled.length)) {
            found = true;
            break outer;
          }
        }
      }
    }

    if (!found) {
      // Exhausted — place at a safe fallback distance straight outward
      card.x = origX + Math.cos(origAngle) * 120 * RESOLVE_STEP;
      card.y = origY + Math.sin(origAngle) * 120 * RESOLVE_STEP;
    }
  }
}

// ─── SVG lines layer ──────────────────────────────────────────────────────────
let svgEl = null;

function ensureSVG(w, h) {
  if (svgEl) svgEl.remove();
  svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible';
  svgEl.setAttribute('width', w);
  svgEl.setAttribute('height', h);
  canvas.insertBefore(svgEl, canvas.firstChild);
  return svgEl;
}

function drawLines(highlight, related) {
  if (!svgEl) return;
  svgEl.innerHTML = '';

  // Always draw all parent->child tree lines
  placedCache.forEach(card => {
    (card.relatedTo || []).forEach(parentTitle => {
      const parent = placedCache.find(c => c.title === parentTitle);
      if (!parent) return;

      const isActive = highlight && (related?.has(card.title) || related?.has(parentTitle));
      const color = TYPE_META[parent.type]?.color || '#7F77DD';
      const ph = cardPositions[parent.title]?.h || 150;
      const ch = cardPositions[card.title]?.h || 140;
      const pw = parent.level === 'main' ? 230 : 200;
      const cw = card.level === 'detail' ? 178 : 200;

      const x1 = parent.x + pw / 2;
      const y1 = parent.y + ph / 2;
      const x2 = card.x + cw / 2;
      const y2 = card.y + ch / 2;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', isActive ? '2' : '1');
      line.setAttribute('opacity', isActive ? '0.85' : '0.18');
      svgEl.appendChild(line);
    });
  });
}


// ─── Render ───────────────────────────────────────────────────────────────────
let placedCache = [];

function renderWall(cards) {
  canvas.innerHTML = '';
  hint.style.display = 'none';
  cardPositions = {};

  const visible = cards.filter(c => activeTypes.has(c.type));
  const placed = scatterPositions(visible);
  if (!placed || placed.length === 0) {
    hint.style.display = 'block';
    hint.textContent = 'No cards to display';
    return;
  }

  // ── Step 1: render all cards hidden to measure real heights ──────────────
  const allEls = [];
  placed.forEach(card => {
    const el = makeCardEl(card);
    el.style.visibility = 'hidden';
    el.style.position   = 'absolute';
    el.style.left       = '-9999px';
    el.style.top        = '0px';
    canvas.appendChild(el);
    allEls.push({ card, el });
  });

  // Force layout so offsetHeight is accurate
  void canvas.offsetHeight;

  // ── Step 2: write real heights back into placed cards ────────────────────
  allEls.forEach(({ card, el }) => {
    card.h = el.offsetHeight || card.h;
    card.w = el.offsetWidth  || card.w;
  });

  // ── Step 3: run angle-based collision resolver with real dimensions ───────
  resolveCollisions(placed);

  // Safety clamp — no NaN positions
  placed.forEach(card => {
    if (!isFinite(card.x)) card.x = 0;
    if (!isFinite(card.y)) card.y = 0;
  });

  placedCache = placed;

  // ── Step 4: size SVG canvas to fit everything ────────────────────────────
  const maxX = Math.max(...placed.map(c => c.x + c.w)) + 300;
  const maxY = Math.max(...placed.map(c => c.y + c.h)) + 300;
  ensureSVG(maxX, maxY);

  // ── Step 5: move cards to final resolved positions ────────────────────────
  allEls.forEach(({ card, el }) => {
    cardPositions[card.title] = { x: card.x, y: card.y, w: card.w, h: card.h };
    el.style.visibility = '';
    el.style.left = card.x + 'px';
    el.style.top  = card.y + 'px';
  });

  // Draw all parent lines faintly by default
  drawLines(null, null);

  // Auto-fit view to all cards
  centerOnMain();
}

function makeCardEl(card) {
  const meta = TYPE_META[card.type] || { label: card.type, color: '#888780' };
  const el = document.createElement('div');
  el.className = 'card';
  // Size by level
  const levelW = card.level === 'main' ? 230 : card.level === 'sub' ? 200 : 178;
  el.style.width = levelW + 'px';
  el.style.borderLeft = `${card.level === 'main' ? 4 : 3}px solid ${meta.color}`;
  el.style.borderRadius = `0 var(--radius) var(--radius) 0`;
  el.style.opacity = card.level === 'detail' ? '0.92' : '1';
  el.dataset.title = card.title;
  el.dataset.level = card.level || 'detail';
  el.innerHTML = `
    <div class="card-type" style="color:${meta.color};font-size:${card.level === 'main' ? '11px' : '10px'}">${meta.label} · ${card.level || ''}</div>
    <div class="card-title" style="font-size:${card.level === 'main' ? '14px' : card.level === 'sub' ? '13px' : '12px'}">${card.title}</div>
    <div class="card-body formula-body">${renderSummary(card.summary)}</div>
    <button class="card-explain">✦ Explain more</button>
  `;
  el.addEventListener('mouseenter', () => {
    hoveredTitle = card.title;
    // Collect direct links: cards this card points to + cards that point to this card
    const outgoing = card.relatedTo || [];
    const incoming = placedCache.filter(c => (c.relatedTo || []).includes(card.title)).map(c => c.title);
    const related = new Set([card.title, ...outgoing, ...incoming]);
    // Reset all first then dim unrelated
    document.querySelectorAll('.card').forEach(c => {
      c.style.opacity = related.has(c.dataset.title) ? '1' : '0.25';
      c.style.transition = 'opacity 0.15s';
    });
    drawLines(card.title, related);
  });
  el.addEventListener('mouseleave', () => {
    hoveredTitle = null;
    document.querySelectorAll('.card').forEach(c => {
      c.style.opacity = '1';
    });
    drawLines(null, null);
  });
  el.querySelector('.card-explain').addEventListener('click', e => {
    e.stopPropagation();
    openExplain(card.title, card.summary);
  });
  return el;
}

// ─── Show skeletons ───────────────────────────────────────────────────────────
function showSkeletons() {
  canvas.innerHTML = '';
  hint.style.display = 'none';
  const positions = [
    {x:80,y:80},{x:310,y:80},{x:540,y:80},
    {x:80,y:300},{x:310,y:300},{x:540,y:300},
  ];
  positions.forEach(p => {
    const el = document.createElement('div');
    el.className = 'skeleton';
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    el.innerHTML = `
      <div class="skel-bar" style="width:55%;margin-bottom:10px"></div>
      <div class="skel-bar" style="width:90%"></div>
      <div class="skel-bar" style="width:72%;margin-top:4px"></div>
    `;
    canvas.appendChild(el);
  });
}

// ─── Filter pills ─────────────────────────────────────────────────────────────
function buildFilterPills() {
  filterEl.innerHTML = '';
  for (const [type, meta] of Object.entries(TYPE_META)) {
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.textContent = meta.label + 's';
    pill.style.background = meta.color + '22';
    pill.style.borderColor = meta.color + '66';
    pill.style.color = meta.color;
    pill.dataset.type = type;
    pill.addEventListener('click', () => {
      if (activeTypes.has(type)) activeTypes.delete(type);
      else activeTypes.add(type);
      pill.classList.toggle('off', !activeTypes.has(type));
      renderWall(allCards);
    });
    filterEl.appendChild(pill);
  }
}

// ─── Loading helpers ──────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingMsg.textContent = msg;
  loadingEl.classList.add('show');
}
function hideLoading() {
  loadingEl.classList.remove('show');
}

// ─── Generate from text ───────────────────────────────────────────────────────
genBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) return;
  genBtn.disabled = true;
  showLoading('Generating your wall…');
  showSkeletons();
  try {
    const res = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    allCards = data.cards;
    docName.textContent = '';
    buildTypeMeta(allCards);
    activeTypes = new Set(Object.keys(TYPE_META));
    buildFilterPills();
    scale = 0.72; applyT();
    renderWall(allCards);
  } catch (err) {
    canvas.innerHTML = '';
    hint.textContent = 'Something went wrong: ' + err.message;
    hint.style.display = 'block';
  }
  hideLoading();
  genBtn.disabled = false;
});

// ─── Upload PDF ───────────────────────────────────────────────────────────────
pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files[0];
  if (!file) return;
  genBtn.disabled = true;
  showLoading('Reading PDF…');
  showSkeletons();
  docName.textContent = file.name;
  const formData = new FormData();
  formData.append('pdf', file);
  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    allCards = data.cards;
    buildTypeMeta(allCards);
    activeTypes = new Set(Object.keys(TYPE_META));
    buildFilterPills();
    scale = 0.72; applyT();
    renderWall(allCards);
  } catch (err) {
    canvas.innerHTML = '';
    hint.textContent = 'Something went wrong: ' + err.message;
    hint.style.display = 'block';
  }
  hideLoading();
  genBtn.disabled = false;
  pdfInput.value = '';
});

// ─── Explain panel ────────────────────────────────────────────────────────────
async function openExplain(title, summary) {
  explTitle.textContent = title;
  explBody.textContent = 'Loading…';
  explPanel.classList.add('open');
  try {
    const res = await fetch(`${API}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, summary }),
    });
    const data = await res.json();
    explBody.textContent = data.explanation || data.error;
  } catch (err) {
    explBody.textContent = 'Could not load explanation.';
  }
}

document.getElementById('explain-close').onclick = () => {
  explPanel.classList.remove('open');
};

// Auto-grow textarea
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 80) + 'px';
});

// Enter to generate
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); genBtn.click(); }
});