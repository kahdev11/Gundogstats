/* ============================================================
   Kvartér — lokal jakthundlogg
   All data lives in this browser's IndexedDB. Nothing leaves the device.
   ============================================================ */

/* ---------------- geo helpers ---------------- */
const R_EARTH = 6371000;
function toRad(d) { return (d * Math.PI) / 180; }
function haversine(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); }
const COMPASS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/* ---------------- GPX parsing ---------------- */
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  const pts = trkpts.map((tp) => {
    const lat = parseFloat(tp.getAttribute('lat'));
    const lon = parseFloat(tp.getAttribute('lon'));
    const timeEl = tp.getElementsByTagName('time')[0];
    const t = timeEl ? new Date(timeEl.textContent).getTime() : null;
    return { lat, lon, t };
  }).filter((p) => !isNaN(p.lat) && !isNaN(p.lon) && p.t !== null);
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

/* ---------------- track math ---------------- */
function trackDistance(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return total;
}

function detectStands(pts, minSeconds = 60, speedThresholdKmh = 1.5, edgeBufferSeconds = 90) {
  const stands = [];
  if (pts.length < 2) return stands;
  let cur = null;
  const t0 = pts[0].t, tN = pts[pts.length - 1].t;
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    const kmh = dt > 0 ? (d / dt) * 3.6 : 0;
    if (kmh < speedThresholdKmh) {
      if (!cur) cur = { start: pts[i - 1].t, end: pts[i].t, lat: pts[i - 1].lat, lon: pts[i - 1].lon };
      else cur.end = pts[i].t;
    } else {
      if (cur && (cur.end - cur.start) / 1000 >= minSeconds) stands.push(cur);
      cur = null;
    }
  }
  if (cur && (cur.end - cur.start) / 1000 >= minSeconds) stands.push(cur);
  // filter out stands too close to the edges of the selected window (handling artifacts)
  return stands.filter(
    (s) => (s.start - t0) / 1000 > edgeBufferSeconds && (tN - s.end) / 1000 > edgeBufferSeconds
  );
}

function interpAt(pts, t) {
  if (t <= pts[0].t) return pts[0];
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const p0 = pts[i - 1], p1 = pts[i];
      const f = p1.t === p0.t ? 0 : (t - p0.t) / (p1.t - p0.t);
      return { lat: p0.lat + f * (p1.lat - p0.lat), lon: p0.lon + f * (p1.lon - p0.lon) };
    }
  }
  return pts[pts.length - 1];
}

function hunterDogDistanceStats(hunterPts, dogPts) {
  if (!hunterPts || !hunterPts.length) return null;
  const dists = [];
  for (const h of hunterPts) {
    const dp = interpAt(dogPts, h.t);
    dists.push(haversine(h.lat, h.lon, dp.lat, dp.lon));
  }
  dists.sort((a, b) => a - b);
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  const median = dists[Math.floor(dists.length / 2)];
  const max = dists[dists.length - 1];
  const within50 = dists.filter((d) => d <= 50).length / dists.length;
  return { mean, median, max, within50Pct: within50 * 100 };
}

function windSegments(pts, windFromDeg, binSize = 40) {
  const segs = [];
  for (let i = 0; i < pts.length; i += binSize) {
    const chunk = pts.slice(i, i + binSize + 1);
    if (chunk.length < 2) continue;
    const a = chunk[0], b = chunk[chunk.length - 1];
    const d = haversine(a.lat, a.lon, b.lat, b.lon);
    let cat = 'cross';
    if (d >= 5) {
      const br = bearing(a.lat, a.lon, b.lat, b.lon);
      const upwindTarget = windFromDeg; // heading toward wind source = into the wind
      const downwindTarget = (windFromDeg + 180) % 360;
      if (angDiff(br, upwindTarget) <= 50) cat = 'upwind';
      else if (angDiff(br, downwindTarget) <= 50) cat = 'downwind';
    }
    segs.push({ cat, start: [a.lat, a.lon], end: [b.lat, b.lon] });
  }
  // aggregate distance per category
  const totals = { upwind: 0, downwind: 0, cross: 0 };
  segs.forEach((s) => { totals[s.cat] += haversine(s.start[0], s.start[1], s.end[0], s.end[1]); });
  const sum = totals.upwind + totals.downwind + totals.cross || 1;
  return {
    segs,
    pct: {
      upwind: (totals.upwind / sum) * 100,
      downwind: (totals.downwind / sum) * 100,
      cross: (totals.cross / sum) * 100,
    },
  };
}

function computeStats(hunt) {
  const dogPts = hunt.dogPts.slice(hunt.trimStart, hunt.trimEnd + 1);
  const hunterPts = hunt.hunterPts ? hunt.hunterPts.filter((p) => p.t >= dogPts[0].t && p.t <= dogPts[dogPts.length - 1].t) : null;
  const dogDist = trackDistance(dogPts);
  const hunterDist = hunterPts && hunterPts.length > 1 ? trackDistance(hunterPts) : null;
  const durationMin = (dogPts[dogPts.length - 1].t - dogPts[0].t) / 60000;
  const stands = detectStands(dogPts);
  const hd = hunterPts && hunterPts.length > 1 ? hunterDogDistanceStats(hunterPts, dogPts) : null;
  const wind = hunt.windFrom != null ? windSegments(dogPts, COMPASS_DEG[hunt.windFrom]) : null;
  return { dogPts, hunterPts, dogDist, hunterDist, durationMin, stands, hunterDogDist: hd, wind };
}

/* ---------------- storage (IndexedDB) ---------------- */
const DB_NAME = 'kvarter-db';
const STORE = 'hunts';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(hunt) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(hunt);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date)));
    req.onerror = () => reject(req.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- formatting ---------------- */
const fmt = {
  km: (m) => (m / 1000).toFixed(2).replace('.', ',') + ' km',
  m: (v) => Math.round(v) + ' m',
  min: (v) => {
    const h = Math.floor(v / 60), mm = Math.round(v % 60);
    return h > 0 ? `${h}t ${mm}min` : `${mm}min`;
  },
  pct: (v) => Math.round(v) + ' %',
  date: (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
  },
};

/* ---------------- compass SVG ---------------- */
function compassSVG(rotDeg, big) {
  const size = big ? 96 : 46;
  return `<div class="compass${big ? ' big' : ''}" style="--needle-rot:${rotDeg}deg">
    <svg viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="44" fill="none" stroke="var(--border)" stroke-width="2"/>
      <text x="50" y="14" text-anchor="middle" font-size="9" fill="var(--text-muted)" font-family="IBM Plex Mono">N</text>
      <g class="needle">
        <polygon points="50,14 42,50 58,50" fill="var(--orange)"/>
        <polygon points="50,86 42,50 58,50" fill="var(--moss)"/>
      </g>
      <circle cx="50" cy="50" r="4" fill="var(--text)"/>
    </svg>
  </div>`;
}

/* ---------------- app state & routing ---------------- */
const APP_VERSION = '2026-08-29.4';
const root = document.getElementById('app-root');
let state = { hunts: [], newHunt: null };

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

async function refreshHunts() {
  state.hunts = await dbGetAll();
}

function navigate(view, payload) {
  window.location.hash = view + (payload ? ':' + payload : '');
}

async function router() {
  const hash = window.location.hash.replace('#', '');
  const [view, payload] = hash.split(':');
  await refreshHunts();
  if (view === 'new') renderNewHunt();
  else if (view === 'hunt' && payload) renderHuntDetail(payload);
  else if (view === 'hunt3d' && payload) renderHunt3D(payload);
  else renderDashboard();
}
window.addEventListener('hashchange', router);

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const hunts = state.hunts;
  root.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>Kvartér</span><span class="dot">·</span></div>
      <div class="brand-sub">${hunts.length} logget · v${APP_VERSION}</div>
    </header>
    <main>
      ${hunts.length === 0 ? `
        <div class="empty-state">
          <div class="glyph">🧭</div>
          <h3>Ingen turer logget ennå</h3>
          <p>Last opp GPX-filer fra hundens halsbånd (og gjerne håndenheten din) for å komme i gang. Har du en tidligere backup-fil? Importer den under.</p>
        </div>
      ` : `
        <div class="section-label">Logg</div>
        ${hunts.map(huntCardHTML).join('')}
      `}
      <div style="margin-top:24px;display:flex;flex-direction:column;gap:8px;">
        ${hunts.length > 0 ? '<button class="btn btn-ghost btn-block" id="exportBtn">Eksporter alle data (backup)</button>' : ''}
        <button class="btn btn-ghost btn-block" id="importBtn">Importer backup</button>
        <input type="file" id="importFile" accept=".json" class="hidden">
      </div>
    </main>
    <button class="btn btn-primary fab" id="newHuntBtn">+ Ny jakttur</button>
  `;
  document.getElementById('newHuntBtn').onclick = () => navigate('new');
  hunts.forEach((h) => {
    const el = document.getElementById('card-' + h.id);
    if (el) el.onclick = () => navigate('hunt', h.id);
  });
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.onclick = exportAllData;
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  importBtn.onclick = () => importFile.click();
  importFile.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('Ugyldig format');
      for (const hunt of data) {
        if (!hunt.id || !hunt.dogPts) continue;
        await dbPut(hunt);
      }
      toast(`Importerte ${data.length} jaktturer`);
      router();
    } catch (err) {
      toast('Kunne ikke lese filen — er det en gyldig backup?');
    }
  };
}

function huntCardHTML(h) {
  const stats = computeStats(h);
  const rot = h.windFrom ? COMPASS_DEG[h.windFrom] : 0;
  return `
    <div class="hunt-card" id="card-${h.id}">
      <div class="date">${fmt.date(h.date)}</div>
      <div class="compass-mini">${compassSVG(rot, false)}</div>
      <div class="place">${h.name || 'Uten navn'}</div>
      <div class="stat-row">
        <span>Hund <b>${fmt.km(stats.dogDist)}</b></span>
        ${stats.hunterDist ? `<span>Fører <b>${fmt.km(stats.hunterDist)}</b></span>` : ''}
        <span>Stand <b>${stats.stands.length}</b></span>
      </div>
    </div>
  `;
}

async function exportAllData() {
  const hunts = await dbGetAll();
  const blob = new Blob([JSON.stringify(hunts)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kvarter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Backup lastet ned');
}

/* ---------------- New hunt flow ---------------- */
function renderNewHunt() {
  state.newHunt = { name: '', date: new Date().toISOString().slice(0, 10), dogPts: null, hunterPts: null, windFrom: null, trimStart: 0, trimEnd: 0 };
  root.innerHTML = `
    <header class="topbar">
      <div class="back-row" style="padding:0;">
        <button class="back-btn" id="backBtn">←</button>
        <div class="hunt-title">Ny jakttur</div>
      </div>
    </header>
    <main>
      <div class="field">
        <label>Navn på turen (valgfritt)</label>
        <input type="text" id="huntName" placeholder="F.eks. Kvamskogen" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-family:var(--font-body);font-size:14px;">
      </div>
      <div class="field">
        <label>Halsbånd (hund) — GPX-fil, påkrevd</label>
        <div class="dropzone" id="dogDrop">Trykk for å velge fil</div>
        <input type="file" id="dogFile" accept=".gpx">
      </div>
      <div class="field">
        <label>Håndenhet (fører) — GPX-fil, valgfritt</label>
        <div class="dropzone" id="hunterDrop">Trykk for å velge fil</div>
        <input type="file" id="hunterFile" accept=".gpx">
      </div>
      <div class="field">
        <label>Vindretning (fra)</label>
        <div class="wind-picker">
          <div class="compass-wrap">${compassSVG(0, true)}</div>
          <div class="wind-dirs" id="windDirs">
            ${COMPASS_DIRS.map((d) => `<button type="button" class="wind-dir-btn" data-dir="${d}">${d}</button>`).join('')}
          </div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="processBtn" disabled>Last opp hund-GPX for å fortsette</button>
    </main>
  `;
  document.getElementById('backBtn').onclick = () => navigate('');
  document.getElementById('huntName').oninput = (e) => { state.newHunt.name = e.target.value; };

  document.getElementById('dogDrop').onclick = () => document.getElementById('dogFile').click();
  document.getElementById('hunterDrop').onclick = () => document.getElementById('hunterFile').click();

  document.getElementById('dogFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    state.newHunt.dogPts = parseGPX(text);
    document.getElementById('dogDrop').textContent = `✓ ${f.name} (${state.newHunt.dogPts.length} punkter)`;
    document.getElementById('dogDrop').classList.add('filled');
    updateProcessBtn();
  };
  document.getElementById('hunterFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    state.newHunt.hunterPts = parseGPX(text);
    document.getElementById('hunterDrop').textContent = `✓ ${f.name} (${state.newHunt.hunterPts.length} punkter)`;
    document.getElementById('hunterDrop').classList.add('filled');
  };

  document.querySelectorAll('.wind-dir-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.wind-dir-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.newHunt.windFrom = btn.dataset.dir;
      const compassEl = document.querySelector('.compass-wrap .compass .needle');
      if (compassEl) compassEl.parentElement.style.setProperty('--needle-rot', COMPASS_DEG[btn.dataset.dir] + 'deg');
    };
  });

  function updateProcessBtn() {
    const btn = document.getElementById('processBtn');
    if (state.newHunt.dogPts && state.newHunt.dogPts.length > 1) {
      btn.disabled = false;
      btn.textContent = 'Fortsett →';
    }
  }
  document.getElementById('processBtn').onclick = () => renderTrimStep();
}

/* ---------------- Trim step: pick the real hunt window ---------------- */
function renderTrimStep() {
  const nh = state.newHunt;
  nh.trimStart = 0;
  nh.trimEnd = nh.dogPts.length - 1;
  root.innerHTML = `
    <header class="topbar">
      <div class="back-row" style="padding:0;">
        <button class="back-btn" id="backBtn">←</button>
        <div class="hunt-title">Velg jaktvindu</div>
      </div>
    </header>
    <main>
      <p class="note">Dra i håndtakene for å fjerne båndtur i hver ende (gange til/fra bilen). Kartet og statistikken oppdateres live.</p>
      <div id="trimMap" style="width:100%;height:240px;border-radius:14px;border:1px solid var(--border);margin:10px 0;background:var(--surface);"></div>
      <div class="field">
        <label>Start: <span id="trimStartLabel"></span></label>
        <input type="range" id="trimStartSlider" min="0" max="${nh.dogPts.length - 1}" value="0" style="width:100%;">
      </div>
      <div class="field">
        <label>Slutt: <span id="trimEndLabel"></span></label>
        <input type="range" id="trimEndSlider" min="0" max="${nh.dogPts.length - 1}" value="${nh.dogPts.length - 1}" style="width:100%;">
      </div>
      <div class="stat-grid">
        <div class="stat-tile"><div class="label">Hund sporet</div><div class="value" id="trimDogDist">–</div></div>
        <div class="stat-tile"><div class="label">Varighet</div><div class="value" id="trimDuration">–</div></div>
      </div>
      <button class="btn btn-primary btn-block" id="saveBtn">Lagre jakttur</button>
    </main>
  `;
  document.getElementById('backBtn').onclick = () => navigate('new');

  const map = L.map('trimMap', { zoomControl: true, attributionControl: false });
  const fullLine = L.polyline(nh.dogPts.map((p) => [p.lat, p.lon]), { color: '#4c8fbd', weight: 3, opacity: 0.9 }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  // Leaflet reads the container's size at the moment fitBounds/invalidateSize
  // run. Right after an innerHTML swap that size can still be 0 for a tick,
  // which makes fitBounds compute a bogus view — so we wait a tick before
  // ever calling it, not just before invalidateSize.
  setTimeout(() => { map.invalidateSize(); map.fitBounds(fullLine.getBounds()); }, 0);
  setTimeout(() => map.invalidateSize(), 250);
  let startMarker = L.circleMarker([nh.dogPts[0].lat, nh.dogPts[0].lon], { radius: 7, color: '#7a9b6e', fillColor: '#7a9b6e', fillOpacity: 1 }).addTo(map);
  let endMarker = L.circleMarker([nh.dogPts[nh.dogPts.length - 1].lat, nh.dogPts[nh.dogPts.length - 1].lon], { radius: 7, color: '#e8541e', fillColor: '#e8541e', fillOpacity: 1 }).addTo(map);

  function updateTrim() {
    const s = parseInt(document.getElementById('trimStartSlider').value, 10);
    const e = parseInt(document.getElementById('trimEndSlider').value, 10);
    const lo = Math.min(s, e), hi = Math.max(s, e);
    nh.trimStart = lo; nh.trimEnd = hi;
    const sel = nh.dogPts.slice(lo, hi + 1);
    document.getElementById('trimStartLabel').textContent = new Date(nh.dogPts[lo].t).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('trimEndLabel').textContent = new Date(nh.dogPts[hi].t).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('trimDogDist').textContent = fmt.km(trackDistance(sel));
    document.getElementById('trimDuration').textContent = fmt.min((sel[sel.length - 1].t - sel[0].t) / 60000);
    startMarker.setLatLng([nh.dogPts[lo].lat, nh.dogPts[lo].lon]);
    endMarker.setLatLng([nh.dogPts[hi].lat, nh.dogPts[hi].lon]);
  }
  document.getElementById('trimStartSlider').oninput = updateTrim;
  document.getElementById('trimEndSlider').oninput = updateTrim;
  updateTrim();

  document.getElementById('saveBtn').onclick = async () => {
    const id = 'hunt-' + Date.now();
    const record = {
      id,
      name: nh.name,
      date: nh.date,
      dogPts: nh.dogPts,
      hunterPts: nh.hunterPts,
      windFrom: nh.windFrom,
      trimStart: nh.trimStart,
      trimEnd: nh.trimEnd,
    };
    await dbPut(record);
    toast('Jakttur lagret');
    navigate('hunt', id);
  };
}

/* ---------------- Hunt detail ---------------- */
async function renderHuntDetail(id) {
  const db = await openDB();
  const hunt = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!hunt) { navigate(''); return; }
  const stats = computeStats(hunt);

  root.innerHTML = `
    <header class="topbar">
      <div class="back-row" style="padding:0;">
        <button class="back-btn" id="backBtn">←</button>
        <div class="hunt-title">${hunt.name || fmt.date(hunt.date)}</div>
      </div>
    </header>
    <main>
      <div class="legend" id="mapLegend">
        <span><span class="swatch" style="background:#e8541e"></span>Fører</span>
        <span><span class="swatch" style="background:#4c8fbd"></span>Hund</span>
        <span><span class="swatch" style="background:#7a9b6e"></span>Stand</span>
        ${stats.wind ? '<button class="wind-dir-btn" id="windToggleBtn" style="margin-left:auto;">Vis vindretning</button>' : ''}
      </div>
      <div id="map"></div>
      <div class="stat-grid">
        <div class="stat-tile"><div class="label">Hund sporet</div><div class="value blue">${fmt.km(stats.dogDist)}</div></div>
        <div class="stat-tile"><div class="label">Fører gikk</div><div class="value accent">${stats.hunterDist ? fmt.km(stats.hunterDist) : '–'}</div></div>
        <div class="stat-tile"><div class="label">Varighet</div><div class="value">${fmt.min(stats.durationMin)}</div></div>
        <div class="stat-tile"><div class="label">Bekreftet stand</div><div class="value" style="color:var(--moss)">${stats.stands.length}</div></div>
      </div>
      ${stats.hunterDogDist ? `
        <div class="section-label">Avstand fører–hund</div>
        <div class="stat-grid">
          <div class="stat-tile"><div class="label">Snitt</div><div class="value">${fmt.m(stats.hunterDogDist.mean)}</div></div>
          <div class="stat-tile"><div class="label">Median</div><div class="value">${fmt.m(stats.hunterDogDist.median)}</div></div>
          <div class="stat-tile"><div class="label">Maks</div><div class="value">${fmt.m(stats.hunterDogDist.max)}</div></div>
          <div class="stat-tile"><div class="label">Innenfor 50 m</div><div class="value">${fmt.pct(stats.hunterDogDist.within50Pct)}</div></div>
        </div>
      ` : ''}
      ${stats.wind ? `
        <div class="section-label">Søksmønster vs. vind</div>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
          ${compassSVG(COMPASS_DEG[hunt.windFrom], true)}
          <div style="font-size:12.5px;color:var(--text-muted);">Vind fra ${hunt.windFrom}<br>Pilen viser vindretning</div>
        </div>
        <div class="wind-bars">
          <div class="wind-bar-row"><span class="lbl">Mot vinden</span><div class="wind-bar-track"><div class="wind-bar-fill" style="width:${stats.wind.pct.upwind}%;background:#4c8fbd;"></div></div><span class="pct">${fmt.pct(stats.wind.pct.upwind)}</span></div>
          <div class="wind-bar-row"><span class="lbl">Med vinden</span><div class="wind-bar-track"><div class="wind-bar-fill" style="width:${stats.wind.pct.downwind}%;background:#e8541e;"></div></div><span class="pct">${fmt.pct(stats.wind.pct.downwind)}</span></div>
          <div class="wind-bar-row"><span class="lbl">På tvers</span><div class="wind-bar-track"><div class="wind-bar-fill" style="width:${stats.wind.pct.cross}%;background:#93998c;"></div></div><span class="pct">${fmt.pct(stats.wind.pct.cross)}</span></div>
        </div>
      ` : ''}
      <button class="btn btn-primary btn-block" id="view3dBtn" style="margin-top:6px;">Vis spor i 3D</button>
      <button class="btn btn-ghost btn-block" id="deleteBtn" style="margin-top:10px;">Slett denne turen</button>
    </main>
  `;
  document.getElementById('backBtn').onclick = () => navigate('');
  document.getElementById('deleteBtn').onclick = async () => {
    if (confirm('Slette denne jaktturen permanent?')) {
      await dbDelete(id);
      toast('Slettet');
      navigate('');
    }
  };

  const map = L.map('map', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  let trackLayer = L.layerGroup().addTo(map);
  let showWind = false;

  function drawTrack() {
    trackLayer.clearLayers();
    const allPts = [];
    if (showWind && stats.wind) {
      const colors = { upwind: '#4c8fbd', downwind: '#e8541e', cross: '#93998c' };
      stats.wind.segs.forEach((s) => {
        L.polyline([s.start, s.end], { color: colors[s.cat], weight: 4, opacity: 0.9 }).addTo(trackLayer);
        allPts.push(s.start, s.end);
      });
    } else {
      const line = stats.dogPts.map((p) => [p.lat, p.lon]);
      L.polyline(line, { color: '#4c8fbd', weight: 3.5, opacity: 0.95 }).addTo(trackLayer);
      allPts.push(...line);
    }
    if (stats.hunterPts && stats.hunterPts.length > 1) {
      const hLine = stats.hunterPts.map((p) => [p.lat, p.lon]);
      L.polyline(hLine, { color: '#e8541e', weight: 3, opacity: 0.9 }).addTo(trackLayer);
      allPts.push(...hLine);
    }
    stats.stands.forEach((s) => {
      L.circleMarker([s.lat, s.lon], { radius: 7, color: '#3b6d11', fillColor: '#7a9b6e', fillOpacity: 1, weight: 2 })
        .addTo(trackLayer)
        .bindTooltip(`${Math.round((s.end - s.start) / 1000)} sek`);
    });
    if (allPts.length) map.fitBounds(allPts);
  }
  drawTrack();
  // Defer the first fitBounds until the container has a real, laid-out size —
  // right after an innerHTML swap it can still read as 0×0 for a tick, which
  // makes fitBounds compute a bogus view (this was almost certainly why the
  // track looked replaced by "something else": the map was just looking at
  // the wrong region). Toggling later is safe inline since the map is sized
  // correctly by then.
  setTimeout(() => { map.invalidateSize(); drawTrack(); }, 0);
  setTimeout(() => map.invalidateSize(), 250);

  const windToggleBtn = document.getElementById('windToggleBtn');
  if (windToggleBtn) {
    windToggleBtn.onclick = () => {
      showWind = !showWind;
      windToggleBtn.textContent = showWind ? 'Vis sporet' : 'Vis vindretning';
      windToggleBtn.classList.toggle('active', showWind);
      drawTrack();
    };
  }

  document.getElementById('view3dBtn').onclick = () => navigate('hunt3d', id);
}

/* ---------------- elevation lookup (Terrarium DEM tiles, AWS Open Data — public, no key, used by MapLibre/Mapbox-style tools so reliably CORS-enabled for browser fetches) ---------------- */
function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}
function lonLatToPixel(lon, lat, zoom, tileX, tileY) {
  const n = Math.pow(2, zoom);
  const xTile = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    px: Math.floor((xTile - tileX) * 256),
    py: Math.floor((yTile - tileY) * 256),
  };
}
function loadTileImageData(x, y, z) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Kunne ikke laste terrengflis'));
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  });
}
async function fetchElevations(points, zoom = 13) {
  // Group points by which tile they fall in, so we only fetch each tile once.
  const tileCache = new Map();
  const results = [];
  for (const { lat, lon } of points) {
    const { x, y } = lonLatToTile(lon, lat, zoom);
    const key = `${x}/${y}`;
    if (!tileCache.has(key)) {
      tileCache.set(key, loadTileImageData(x, y, zoom)); // promise, dedup concurrent loads
    }
    const imgData = await tileCache.get(key);
    const { px, py } = lonLatToPixel(lon, lat, zoom, x, y);
    const cx = Math.max(0, Math.min(255, px)), cy = Math.max(0, Math.min(255, py));
    const idx = (cy * 256 + cx) * 4;
    const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
    const elevation = r * 256 + g + b / 256 - 32768;
    results.push(elevation);
  }
  return results;
}

/* ---------------- 3D view (real terrenghøyde via Terrarium DEM tiles) ---------------- */
async function renderHunt3D(id) {
  const db = await openDB();
  const hunt = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!hunt) { navigate(''); return; }
  const stats = computeStats(hunt);

  root.innerHTML = `
    <header class="topbar">
      <div class="back-row" style="padding:0;">
        <button class="back-btn" id="backBtn">←</button>
        <div class="hunt-title">Spor i 3D</div>
      </div>
    </header>
    <main style="padding-left:0;padding-right:0;">
      <div id="three-status" class="note" style="margin:0 20px 10px;">Henter terrenghøyde for området …</div>
      <div id="three-wrap" style="width:100%;height:60vh;min-height:360px;position:relative;background:radial-gradient(ellipse at 50% 20%, #1c2a1d, #0d130e);">
        <canvas id="three-canvas" style="display:block;width:100%;height:100%;touch-action:none;"></canvas>
      </div>
      <div class="legend" style="padding:0 20px;margin-top:12px;">
        ${stats.wind ? `
          <span><span class="swatch" style="background:#4c8fbd"></span>Mot vind</span>
          <span><span class="swatch" style="background:#e8541e"></span>Med vind</span>
          <span><span class="swatch" style="background:#93998c"></span>På tvers</span>
        ` : `
          <span><span class="swatch" style="background:#4c8fbd"></span>Rolig</span>
          <span><span class="swatch" style="background:#e8541e"></span>Høy fart</span>
        `}
        <span><span class="swatch" style="background:#7a9b6e;border-radius:50%;width:8px;height:8px;"></span>Stand</span>
      </div>
    </main>
  `;
  // Guard: if the person navigates away before the (async) elevation fetch
  // finishes, we must not touch this view's DOM afterward — it's gone.
  let cancelled = false;
  const navGuard = () => { cancelled = true; };
  window.addEventListener('hashchange', navGuard, { once: true });
  document.getElementById('backBtn').onclick = () => navigate('hunt', id);

  const statusEl = document.getElementById('three-status');

  function downsample(arr, target) {
    if (arr.length <= target) return arr;
    const step = Math.ceil(arr.length / target);
    const out = arr.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
    return out;
  }
  const dogDS = downsample(stats.dogPts, 90);
  const standPts = stats.stands.map((s) => ({ lat: s.lat, lon: s.lon }));
  const lookupPts = [...dogDS, ...standPts];

  let elevations = null;
  try {
    elevations = await fetchElevations(lookupPts);
    if (cancelled) return;
    statusEl.textContent = 'Terreng fra åpne høydedata — posisjon vist på ekte høyde.';
  } catch (err) {
    if (cancelled) return;
    statusEl.textContent = 'Fikk ikke hentet terrenghøyde akkurat nå (nett eller høydedata utilgjengelig) — viser sporet flatt i stedet.';
  }
  if (cancelled) return;

  const dogElev = elevations ? elevations.slice(0, dogDS.length) : null;
  const standElev = elevations ? elevations.slice(dogDS.length) : null;

  try {
    init3D(stats, hunt, { dogDS, dogElev, standElev });
  } catch (err) {
    if (!cancelled) statusEl.textContent = '3D-visning feilet på denne enheten. Prøv igjen, eller se kartet i 2D i stedet.';
  }
}

function init3D(stats, hunt, elevData) {
  const canvas = document.getElementById('three-canvas');
  const wrap = document.getElementById('three-wrap');
  const W = () => wrap.clientWidth, H = () => wrap.clientHeight;
  const { dogDS, dogElev, standElev } = elevData;

  // project lat/lon to local meters around the track's centroid
  const lat0 = dogDS[Math.floor(dogDS.length / 2)].lat;
  const lon0 = dogDS[Math.floor(dogDS.length / 2)].lon;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(toRad(lat0));
  const project = (p) => [
    (p.lon - lon0) * mPerLon,
    (p.lat - lat0) * mPerLat,
  ];

  function downsample(arr, target) {
    if (arr.length <= target) return arr;
    const step = Math.ceil(arr.length / target);
    const out = arr.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
    return out;
  }

  const VERTICAL_EXAGGERATION = 1.8;
  const minElev = dogElev ? Math.min(...dogElev) : 0;
  const elevY = (i) => (dogElev ? (dogElev[i] - minElev) * VERTICAL_EXAGGERATION : 0);

  // speed per point — used for color when there's no wind classification
  const speeds = [0];
  for (let i = 1; i < dogDS.length; i++) {
    const d = haversine(dogDS[i - 1].lat, dogDS[i - 1].lon, dogDS[i].lat, dogDS[i].lon);
    const dt = (dogDS[i].t - dogDS[i - 1].t) / 1000;
    speeds.push(dt > 0 ? Math.min((d / dt) * 3.6, 25) : 0);
  }
  const colorFor = (i) => {
    const frac = Math.min(speeds[i] / 12, 1);
    const c1 = new THREE.Color(0x4c8fbd), c2 = new THREE.Color(0xe8541e);
    return c1.clone().lerp(c2, frac);
  };

  let catForIdx = null;
  if (stats.wind) {
    catForIdx = dogDS.map((p) => {
      let best = null, bestD = Infinity;
      stats.wind.segs.forEach((s) => {
        const dmid = haversine(p.lat, p.lon, (s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2);
        if (dmid < bestD) { bestD = dmid; best = s.cat; }
      });
      return best || 'cross';
    });
  }
  const catColors = { upwind: 0x4c8fbd, downwind: 0xe8541e, cross: 0x93998c };

  // build geometry
  const positions = [];
  const colors = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  dogDS.forEach((p, i) => {
    const [x, z] = project(p);
    const y = elevY(i);
    positions.push(x, y, z);
    const col = catForIdx ? new THREE.Color(catColors[catForIdx[i]]) : colorFor(i);
    colors.push(col.r, col.g, col.b);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  });

  const scene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);

  // hunter track: projected onto the same terrain profile via nearest dog-point elevation
  if (stats.hunterPts && stats.hunterPts.length > 1 && dogElev) {
    const hDS = downsample(stats.hunterPts, 250);
    const hPos = [];
    hDS.forEach((p) => {
      const [x, z] = project(p);
      let best = 0, bestD = Infinity;
      dogDS.forEach((dp, i) => {
        const dd = haversine(p.lat, p.lon, dp.lat, dp.lon);
        if (dd < bestD) { bestD = dd; best = i; }
      });
      hPos.push(x, elevY(best) + 0.4, z);
    });
    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.Float32BufferAttribute(hPos, 3));
    const hMat = new THREE.LineBasicMaterial({ color: 0xede6d6, transparent: true, opacity: 0.6 });
    scene.add(new THREE.Line(hGeo, hMat));
  }

  // stands as small glowing spheres, on the real terrain height
  stats.stands.forEach((s, i) => {
    const [x, z] = project(s);
    const y = standElev ? (standElev[i] - minElev) * VERTICAL_EXAGGERATION : 0;
    const geo2 = new THREE.SphereGeometry(0.9, 16, 16);
    const mat2 = new THREE.MeshBasicMaterial({ color: 0x7a9b6e });
    const sph = new THREE.Mesh(geo2, mat2);
    sph.position.set(x, y + 0.9, z);
    scene.add(sph);
  });

  // ground grid at base elevation
  const spanX = Math.max(maxX - minX, 50), spanZ = Math.max(maxZ - minZ, 50);
  const gridSize = Math.max(spanX, spanZ) * 1.4;
  const grid = new THREE.GridHelper(gridSize, 24, 0x33402f, 0x232f21);
  grid.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  scene.add(grid);

  const maxY = dogElev ? Math.max(...dogElev.map((_, i) => elevY(i))) : 0;
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  const target = new THREE.Vector3(centerX, maxY / 2 + 2, centerZ);
  const radius0 = Math.max(spanX, spanZ) * 0.9 + 40;

  const camera = new THREE.PerspectiveCamera(52, W() / H(), 0.1, gridSize * 4);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W(), H());

  let azimuth = Math.PI * 0.25, elevation = 0.55, radius = radius0;
  let dragging = false, lastX = 0, lastY = 0, idleTimer = null, autoRotate = true;

  function setCamera() {
    const cy = Math.sin(elevation) * radius;
    const ch = Math.cos(elevation) * radius;
    camera.position.set(
      target.x + Math.cos(azimuth) * ch,
      target.y + cy,
      target.z + Math.sin(azimuth) * ch
    );
    camera.lookAt(target);
  }
  setCamera();

  function onDown(x, y) { dragging = true; lastX = x; lastY = y; autoRotate = false; clearTimeout(idleTimer); }
  function onMove(x, y) {
    if (!dragging) return;
    const dx = x - lastX, dy = y - lastY;
    azimuth -= dx * 0.006;
    elevation = Math.max(0.12, Math.min(1.4, elevation + dy * 0.005));
    lastX = x; lastY = y;
    setCamera();
  }
  function onWindowMouseMove(e) { onMove(e.clientX, e.clientY); }
  function onUp() {
    dragging = false;
    idleTimer = setTimeout(() => { autoRotate = true; }, 2500);
  }
  function onWheel(e) {
    radius = Math.max(20, Math.min(radius0 * 3, radius + e.deltaY * 0.5));
    setCamera();
    e.preventDefault();
  }
  canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; onDown(t.clientX, t.clientY); }, { passive: true });
  canvas.addEventListener('touchmove', (e) => { const t = e.touches[0]; onMove(t.clientX, t.clientY); }, { passive: true });
  canvas.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    if (autoRotate) { azimuth += 0.0015; setCamera(); }
    renderer.render(scene, camera);
  }
  animate();

  function onResize() {
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
    renderer.setSize(W(), H());
  }
  window.addEventListener('resize', onResize);
  // Two-tier re-measure, same fix as the Leaflet maps: right after the
  // innerHTML swap the wrapper can still read 0×0 for a tick, which would
  // otherwise leave the WebGL canvas sized to nothing.
  setTimeout(onResize, 0);
  setTimeout(onResize, 250);

  const cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('hashchange', cleanup);
    clearTimeout(idleTimer);
    // Explicitly free the WebGL context instead of waiting on garbage
    // collection — repeated visits to this view without this would
    // eventually exhaust the browser's limited number of WebGL contexts
    // and silently break future 3D views.
    renderer.dispose();
  };
  window.addEventListener('hashchange', cleanup, { once: true });
}

/* ---------------- boot ---------------- */
router();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
