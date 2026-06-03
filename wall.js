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
  // Find main card position and center the viewport on it
  const main = allCards.find(c => c.level === 'main');
  if (!main) return;
  const pos = placedCache.find(c => c.title === main.title);
  if (!pos) return;
  const rect = wrap.getBoundingClientRect();
  const CX = 900, CY = 700; // matches layout center
  ox = rect.width / 2 - CX * scale;
  oy = rect.height / 2 - CY * scale;
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

document.getElementById('reset-btn').onclick = () => { scale = 0.72; ox = 0; oy = 0; applyT(); centerOnMain(); };

// ─── Card type config — built dynamically ────────────────────────────────────
const PALETTE = [
  '#7F77DD', '#EF9F27', '#1D9E75', '#E24B4A',
  '#888780', '#4A9ED4', '#C45AB3', '#5B8C5A',
  '#D4763B', '#6B7FD4',
];

let TYPE_META = {};

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

// ─── Layout — tree-based positioning ─────────────────────────────────────────
const CARD_W = 200;

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

function scatterPositions(cards) {
  const mains   = cards.filter(c => c.level === 'main');
  const subs    = cards.filter(c => c.level === 'sub');
  const details = cards.filter(c => c.level === 'detail');
  const rest    = cards.filter(c => !['main','sub','detail'].includes(c.level));

  const positioned = [];
  const posMap = {}; // title -> center {x, y}

  const MAIN_W = 230, SUB_W = 200, DETAIL_W = 178;
  const MAIN_H = 160, SUB_H = 150, DETAIL_H = 140;

  // ── Center of canvas ──
  const CX = 900, CY = 700;

  // ── Place mains in center (side by side if >1) ──
  const mainGap = 260;
  mains.forEach((card, i) => {
    const offset = (i - (mains.length - 1) / 2) * mainGap;
    const x = CX + offset - MAIN_W / 2;
    const y = CY - MAIN_H / 2;
    posMap[card.title] = { cx: CX + offset, cy: CY };
    positioned.push({ ...card, x, y });
  });

  // ── Place subs radially around their parent main ──
  const SUB_RADIUS = 420;
  const subsByParent = {};
  subs.forEach(card => {
    const parent = (card.relatedTo || [])[0] || (mains[0]?.title || '__none__');
    if (!subsByParent[parent]) subsByParent[parent] = [];
    subsByParent[parent].push(card);
  });

  Object.entries(subsByParent).forEach(([parentTitle, group]) => {
    const parentCenter = posMap[parentTitle] || { cx: CX, cy: CY };
    const count = group.length;
    group.forEach((card, i) => {
      const angle = (2 * Math.PI * i / count) - Math.PI / 2;
      // Add radius jitter so subs aren't perfectly equidistant
      const h = hash(card.title);
      const rJitter = ((h & 0xFF) / 255 - 0.5) * 80;
      const aJitter = (((h >> 8) & 0xFF) / 255 - 0.5) * 0.25;
      const r = SUB_RADIUS + rJitter;
      const cx = parentCenter.cx + r * Math.cos(angle + aJitter);
      const cy = parentCenter.cy + r * Math.sin(angle + aJitter);
      posMap[card.title] = { cx, cy };
      positioned.push({ ...card, x: cx - SUB_W / 2, y: cy - SUB_H / 2 });
    });
  });

  // ── Place details radially around their parent sub ──
  const DETAIL_RADIUS = 300;
  const detailsByParent = {};
  details.forEach(card => {
    const parent = (card.relatedTo || [])[0] || '__none__';
    if (!detailsByParent[parent]) detailsByParent[parent] = [];
    detailsByParent[parent].push(card);
  });

  Object.entries(detailsByParent).forEach(([parentTitle, group]) => {
    const parentCenter = posMap[parentTitle];
    if (!parentCenter) return;
    const mainCenter = posMap[mains[0]?.title] || { cx: CX, cy: CY };

    // Angle away from main center so details fan outward
    const baseAngle = Math.atan2(parentCenter.cy - mainCenter.cy, parentCenter.cx - mainCenter.cx);
    const spread = Math.PI * 0.55; // how wide the fan is
    const count = group.length;

    group.forEach((card, i) => {
      const baseA = count === 1
        ? baseAngle
        : baseAngle - spread / 2 + (spread / (count - 1)) * i;
      // Jitter radius and angle so details feel scattered, not lined up
      const h = hash(card.title);
      const rJitter = ((h & 0xFF) / 255 - 0.5) * 100;
      const aJitter = (((h >> 8) & 0xFF) / 255 - 0.5) * 0.35;
      const r = DETAIL_RADIUS + rJitter;
      const cx = parentCenter.cx + r * Math.cos(baseA + aJitter);
      const cy = parentCenter.cy + r * Math.sin(baseA + aJitter);
      posMap[card.title] = { cx, cy };
      positioned.push({ ...card, x: cx - DETAIL_W / 2, y: cy - DETAIL_H / 2 });
    });
  });

  // Fallback
  rest.forEach((card, i) => {
    positioned.push({ ...card, x: 100 + (i % 4) * 260, y: 1400 + Math.floor(i / 4) * 260 });
  });

  return positioned;
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
  placedCache = placed;

  // Compute canvas bounds for SVG
  const maxX = Math.max(...placed.map(c => c.x + CARD_W)) + 200;
  const maxY = Math.max(...placed.map(c => c.y)) + 400;
  ensureSVG(maxX, maxY);

  // Render cards offscreen first to measure heights
  const allEls = [];
  placed.forEach(card => {
    const el = makeCardEl(card);
    el.style.visibility = 'hidden';
    el.style.left = '-9999px';
    el.style.top = '0px';
    canvas.appendChild(el);
    allEls.push({ card, el });
  });

  // Position cards using real heights
  allEls.forEach(({ card, el }) => {
    const h = el.offsetHeight;
    cardPositions[card.title] = { x: card.x, y: card.y, w: CARD_W, h };
    el.style.visibility = '';
    el.style.left = card.x + 'px';
    el.style.top  = card.y + 'px';
  });

  // Draw all parent lines faintly by default
  drawLines(null, null);
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
    <div class="card-body">${card.summary}</div>
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
    scale = 0.72; applyT(); centerOnMain();
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
    scale = 0.72; applyT(); centerOnMain();
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