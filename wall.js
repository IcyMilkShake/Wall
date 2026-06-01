const API = '/api';

// ─── State ────────────────────────────────────────────────────────────────────
let scale = 1, ox = 60, oy = 60;
let dragging = false, sx, sy, sox, soy;
let allCards = [];
let activeTypes = new Set(['concept','definition','example','warning','quote']);

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

wrap.addEventListener('mousedown', e => {
  if (e.target === wrap || e.target === canvas || e.target.classList.contains('cluster-label')) {
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
  scale = Math.max(0.3, Math.min(2.5, scale - e.deltaY * 0.001));
  applyT();
}, { passive: false });

document.getElementById('zoom-in').onclick  = () => { scale = Math.min(2.5, scale + 0.15); applyT(); };
document.getElementById('zoom-out').onclick = () => { scale = Math.max(0.3, scale - 0.15); applyT(); };
document.getElementById('reset-btn').onclick = () => { scale = 1; ox = 60; oy = 60; applyT(); };

// ─── Card type config ─────────────────────────────────────────────────────────
const TYPE_META = {
  concept:    { label: 'Concept',    color: '#7F77DD' },
  definition: { label: 'Definition', color: '#EF9F27' },
  example:    { label: 'Example',    color: '#1D9E75' },
  warning:    { label: 'Warning',    color: '#E24B4A' },
  quote:      { label: 'Quote',      color: '#888780' },
};

// ─── Cluster layout: group by type, space out within cluster ─────────────────
const CLUSTER_CENTERS = {
  concept:    { cx: 130,  cy: 90  },
  definition: { cx: 480,  cy: 90  },
  example:    { cx: 130,  cy: 420 },
  warning:    { cx: 480,  cy: 420 },
  quote:      { cx: 830,  cy: 255 },
};
const CARD_W = 192, CARD_H = 170, GAP = 20;

function computePositions(cards) {
  const byType = {};
  cards.forEach(c => {
    if (!byType[c.type]) byType[c.type] = [];
    byType[c.type].push(c);
  });

  const result = [];
  for (const [type, group] of Object.entries(byType)) {
    const cp = CLUSTER_CENTERS[type] || { cx: 300, cy: 300 };
    const cols = Math.ceil(Math.sqrt(group.length));
    const totalW = cols * CARD_W + (cols - 1) * GAP;
    group.forEach((card, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      result.push({
        ...card,
        x: cp.cx - totalW / 2 + col * (CARD_W + GAP),
        y: cp.cy + row * (CARD_H + GAP),
      });
    });
  }
  return result;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderWall(cards) {
  canvas.innerHTML = '';
  hint.style.display = 'none';

  const visible = cards.filter(c => activeTypes.has(c.type));
  const placed = computePositions(visible);

  // Cluster labels
  const byType = {};
  placed.forEach(c => { if (!byType[c.type]) byType[c.type] = []; byType[c.type].push(c); });
  for (const [type, group] of Object.entries(byType)) {
    const xs = group.map(c => c.x);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2 + CARD_W / 2;
    const cy = Math.min(...group.map(c => c.y)) - 24;
    const lbl = document.createElement('div');
    lbl.className = 'cluster-label';
    lbl.style.left = cx + 'px';
    lbl.style.top  = cy + 'px';
    lbl.textContent = TYPE_META[type]?.label + 's' || type;
    canvas.appendChild(lbl);
  }

  // Cards
  placed.forEach(card => {
    const el = document.createElement('div');
    el.className = `card type-${card.type}`;
    el.style.left = card.x + 'px';
    el.style.top  = card.y + 'px';
    el.innerHTML = `
      <div class="card-type label-${card.type}">${TYPE_META[card.type]?.label || card.type}</div>
      <div class="card-title">${card.title}</div>
      <div class="card-body">${card.summary}</div>
      <button class="card-explain" data-title="${card.title}" data-summary="${encodeURIComponent(card.summary)}">
        ✦ Explain more
      </button>
    `;
    el.querySelector('.card-explain').addEventListener('click', e => {
      e.stopPropagation();
      openExplain(card.title, card.summary);
    });
    canvas.appendChild(el);
  });
}

// ─── Show skeletons while loading it looks like something is going on ─────────────────────────────────────────────
function showSkeletons() {
  canvas.innerHTML = '';
  hint.style.display = 'none';
  const positions = [
    {x:100,y:80},{x:320,y:80},{x:540,y:80},
    {x:100,y:280},{x:320,y:280},{x:540,y:280},
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
buildFilterPills();

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
    ox = 60; oy = 60; scale = 1; applyT();
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
    ox = 60; oy = 60; scale = 1; applyT();
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