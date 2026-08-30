/* ============================================================
   GundogHunting — lokal jakthundlogg
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
    const eleEl = tp.getElementsByTagName('ele')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    return { lat, lon, t, ele: isNaN(ele) ? null : ele };
  }).filter((p) => !isNaN(p.lat) && !isNaN(p.lon) && p.t !== null);
  pts.sort((a, b) => a.t - b.t);
  return pts;
}
// True if at least most points actually carry a real device elevation reading,
// so we can prefer it over looking anything up.
function hasRealElevation(pts) {
  if (!pts || !pts.length) return false;
  const withEle = pts.filter((p) => p.ele != null && !isNaN(p.ele)).length;
  return withEle / pts.length > 0.9;
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

/* ---------------- critical speed (endurance model across saved hunts) ----------------
 * Linear reformulation of the speed-duration / "critical power" model used in
 * Rozier-Delgado et al. 2025 (J Exp Biol) for hunting dogs on GPS collars:
 * distance = CS * duration + D'  — where CS (the regression slope) is the
 * critical speed (sustainable "forever" pace) and D' (the intercept) is the
 * finite distance reserve available above that pace. Fit by ordinary least
 * squares on each duration's best-ever effort across all saved hunts — far
 * more numerically stable in-browser than fitting the equivalent hyperbola
 * directly, and mathematically the same model. */
function bestEffortDistance(pts, durationSec) {
  const n = pts.length;
  if (n < 2) return null;
  const totalDur = (pts[n - 1].t - pts[0].t) / 1000;
  if (totalDur < durationSec) return null;
  const cumDist = [0];
  for (let i = 1; i < n; i++) {
    cumDist.push(cumDist[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  }
  let best = 0, j = 0;
  for (let i = 0; i < n; i++) {
    const targetT = pts[i].t + durationSec * 1000;
    if (targetT > pts[n - 1].t) break;
    if (j < i) j = i;
    while (j < n - 1 && pts[j + 1].t < targetT) j++;
    let distAtTarget;
    if (j >= n - 1 || pts[j].t === targetT) distAtTarget = cumDist[j];
    else {
      const t0 = pts[j].t, t1 = pts[j + 1].t;
      const f = t1 === t0 ? 0 : (targetT - t0) / (t1 - t0);
      distAtTarget = cumDist[j] + f * (cumDist[j + 1] - cumDist[j]);
    }
    const d = distAtTarget - cumDist[i];
    if (d > best) best = d;
  }
  return best;
}

const CS_DURATIONS = [15, 30, 60, 120, 180, 300, 450, 600, 900, 1200];

function computeCriticalSpeedModel(hunts) {
  const points = [];
  let huntsUsed = new Set();
  CS_DURATIONS.forEach((T) => {
    let best = 0, found = false;
    hunts.forEach((h) => {
      if (!h.dogPts) return;
      const dogPts = h.dogPts.slice(h.trimStart, h.trimEnd + 1);
      const d = bestEffortDistance(dogPts, T);
      if (d != null && d > best) { best = d; found = true; huntsUsed.add(h.id); }
    });
    if (found) points.push({ duration: T, distance: best });
  });
  if (points.length < 4) return { insufficientData: true, points, huntsUsed: huntsUsed.size };
  const n = points.length;
  const sumT = points.reduce((a, p) => a + p.duration, 0);
  const sumD = points.reduce((a, p) => a + p.distance, 0);
  const sumTT = points.reduce((a, p) => a + p.duration * p.duration, 0);
  const sumTD = points.reduce((a, p) => a + p.duration * p.distance, 0);
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return { insufficientData: true, points, huntsUsed: huntsUsed.size };
  const CS = (n * sumTD - sumT * sumD) / denom; // m/s
  const Dprime = (sumD - CS * sumT) / n; // meters
  const insufficientData = !(CS > 0 && isFinite(CS) && isFinite(Dprime));
  return { CS, Dprime, points, huntsUsed: huntsUsed.size, insufficientData };
}

function timeAboveSpeed(pts, speedKmhThreshold) {
  let sec = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const kmh = (d / dt) * 3.6;
    if (kmh > speedKmhThreshold) sec += dt;
  }
  return sec;
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
const APP_VERSION = '2026-08-29.11';
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
  else if (view === 'endurance') renderEndurance();
  else renderDashboard();
}
window.addEventListener('hashchange', router);

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const hunts = state.hunts;
  root.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>GundogHunting</span><span class="dot">·</span></div>
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
        <button class="btn btn-ghost btn-block" id="enduranceBtn" style="margin-top:14px;">Utholdenhet (kritisk hastighet)</button>
      `}
      <div style="margin-top:24px;display:flex;flex-direction:column;gap:8px;">
        ${hunts.length > 0 ? '<button class="btn btn-ghost btn-block" id="exportBtn">Eksporter alle data (backup)</button>' : ''}
        <button class="btn btn-ghost btn-block" id="importBtn">Importer backup</button>
        <input type="file" id="importFile" accept=".json" class="hidden">
        <button class="btn btn-ghost btn-block" id="forceUpdateBtn">Tving oppdatering av appen</button>
      </div>
    </main>
    <button class="btn btn-primary fab" id="newHuntBtn">+ Ny jakttur</button>
  `;
  document.getElementById('newHuntBtn').onclick = () => navigate('new');
  const enduranceBtn = document.getElementById('enduranceBtn');
  if (enduranceBtn) enduranceBtn.onclick = () => navigate('endurance');
  hunts.forEach((h) => {
    const el = document.getElementById('card-' + h.id);
    if (el) el.onclick = () => navigate('hunt', h.id);
  });
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.onclick = exportAllData;
  document.getElementById('forceUpdateBtn').onclick = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      toast('Oppdaterer …');
      setTimeout(() => window.location.reload(true), 400);
    } catch (err) {
      toast('Fikk ikke tvunget oppdatering — prøv å lukke og åpne appen på nytt');
    }
  };
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
  a.download = `gundoghunting-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Backup lastet ned');
}

/* ---------------- Endurance / critical speed view ---------------- */
async function renderEndurance() {
  const hunts = await dbGetAll();
  const model = computeCriticalSpeedModel(hunts);

  root.innerHTML = `
    <header class="topbar">
      <div class="back-row" style="padding:0;">
        <button class="back-btn" id="backBtn">←</button>
        <div class="hunt-title">Utholdenhet</div>
      </div>
    </header>
    <main>
      <p class="note">
        Kritisk hastighet er farten en hund kan holde uten at utmattelse hoper seg opp —
        under den grensen er arbeidet i praksis bærekraftig, over den akkumuleres tretthet raskt.
        Beregnet fra de beste innsatsene på tvers av alle lagrede turer
        (samme prinsipp som Rozier-Delgado et al. 2025 brukte på jakthunder med GPS-halsbånd,
        forenklet til en lineær modell for pålitelig beregning i appen).
      </p>
      ${model.insufficientData ? `
        <div class="empty-state">
          <div class="glyph">📉</div>
          <h3>Trenger flere turer</h3>
          <p>Fant ${model.points.length} av ${CS_DURATIONS.length} nødvendige varighetspunkter.
          Trenger minst 4 for å beregne en pålitelig kurve — logg noen flere turer, gjerne med
          litt variasjon i intensitet, så dukker dette opp av seg selv.</p>
        </div>
      ` : `
        <div class="stat-grid">
          <div class="stat-tile"><div class="label">Kritisk hastighet</div><div class="value accent">${(model.CS * 3.6).toFixed(1)} km/t</div></div>
          <div class="stat-tile"><div class="label">Distansereserve</div><div class="value">${fmt.m(model.Dprime)}</div></div>
        </div>
        <p class="note">Basert på ${model.huntsUsed} lagrede ${model.huntsUsed === 1 ? 'tur' : 'turer'}. Blir mer pålitelig jo flere turer med variert intensitet du logger.</p>
        <div class="section-label">Beste innsats per varighet</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${model.points.map((p) => `
            <div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:13px;padding:8px 12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);">
              <span style="color:var(--text-muted);">${p.duration < 60 ? p.duration + ' sek' : Math.round(p.duration / 60) + ' min'}</span>
              <span>${fmt.m(p.distance)} (${((p.distance / p.duration) * 3.6).toFixed(1)} km/t)</span>
            </div>
          `).join('')}
        </div>
      `}
    </main>
  `;
  document.getElementById('backBtn').onclick = () => navigate('');
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
        <span><span class="swatch" style="background:#e8b923;border-radius:50%;width:8px;height:8px;"></span>Fuglefunn</span>
        ${stats.wind ? '<button class="wind-dir-btn" id="windToggleBtn" style="margin-left:auto;">Vis vindretning</button>' : ''}
      </div>
      <div id="map"></div>
      <button class="btn btn-ghost btn-block" id="addBirdBtn" style="margin:8px 0;">+ Fuglefunn</button>
      <div id="birdPicker" class="hidden" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;">
        <p style="font-size:12.5px;color:var(--text-muted);margin:0 0 8px;">Hvilken fugl?</p>
        <div id="birdSpeciesBtns" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;">
          ${['Lirype', 'Fjellrype', 'Orrfugl', 'Storfugl', 'Jerpe', 'Annet'].map((s) => `<button type="button" class="wind-dir-btn bird-species-btn" data-species="${s}" style="padding:9px 0;">${s}</button>`).join('')}
        </div>
        <input type="text" id="birdNote" placeholder="Notat (valgfritt)" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:13px;margin-bottom:8px;">
        <button class="btn btn-ghost btn-block" id="birdCancelBtn">Avbryt</button>
      </div>
      <div class="stat-grid">
        <div class="stat-tile"><div class="label">Hund sporet</div><div class="value blue">${fmt.km(stats.dogDist)}</div></div>
        <div class="stat-tile"><div class="label">Fører gikk</div><div class="value accent">${stats.hunterDist ? fmt.km(stats.hunterDist) : '–'}</div></div>
        <div class="stat-tile"><div class="label">Varighet</div><div class="value">${fmt.min(stats.durationMin)}</div></div>
        <div class="stat-tile"><div class="label">Bekreftet stand</div><div class="value" style="color:var(--moss)">${stats.stands.length}</div></div>
      </div>
      <div class="stat-grid" id="elevGrid">
        <div class="stat-tile"><div class="label">Stigning</div><div class="value" id="elevGainVal">${hunt.elevStats ? fmt.m(hunt.elevStats.gain) : '…'}</div></div>
        <div class="stat-tile"><div class="label">Fall</div><div class="value" id="elevLossVal">${hunt.elevStats ? fmt.m(hunt.elevStats.loss) : '…'}</div></div>
      </div>
      <div id="enduranceSlot"></div>
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
    (hunt.birdSightings || []).forEach((b) => {
      L.circleMarker([b.lat, b.lon], { radius: 7, color: '#8a6a10', fillColor: '#e8b923', fillOpacity: 1, weight: 2 })
        .addTo(trackLayer)
        .bindTooltip(`${b.species}${b.note ? ' — ' + b.note : ''}`);
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

  // Bird sightings: tap "+ Fuglefunn", then tap the map where the bird was found.
  let awaitingBirdClick = false;
  let pendingBirdLatLng = null;
  const addBirdBtn = document.getElementById('addBirdBtn');
  const birdPicker = document.getElementById('birdPicker');
  const birdNote = document.getElementById('birdNote');
  addBirdBtn.onclick = () => {
    awaitingBirdClick = true;
    toast('Trykk i kartet der du fant fuglen');
  };
  document.getElementById('birdCancelBtn').onclick = () => {
    birdPicker.classList.add('hidden');
    awaitingBirdClick = false;
    pendingBirdLatLng = null;
    birdNote.value = '';
  };
  document.querySelectorAll('.bird-species-btn').forEach((btn) => {
    btn.onclick = async () => {
      if (!pendingBirdLatLng) return;
      const sighting = {
        id: 'bird-' + Date.now(),
        lat: pendingBirdLatLng.lat,
        lon: pendingBirdLatLng.lng,
        species: btn.dataset.species,
        note: birdNote.value.trim(),
        t: Date.now(),
      };
      hunt.birdSightings = [...(hunt.birdSightings || []), sighting];
      await dbPut(hunt);
      birdPicker.classList.add('hidden');
      pendingBirdLatLng = null;
      birdNote.value = '';
      drawTrack();
      toast(`${sighting.species} registrert`);
    };
  });
  map.on('click', (e) => {
    if (!awaitingBirdClick) return;
    awaitingBirdClick = false;
    pendingBirdLatLng = e.latlng;
    birdPicker.classList.remove('hidden');
  });

  document.getElementById('view3dBtn').onclick = () => navigate('hunt3d', id);

  // Elevation gain/loss: fetch once, then cache on the hunt record so we
  // never re-fetch on repeat visits. Same navigate-away guard as the 3D view.
  if (!hunt.elevStats) {
    let cancelled = false;
    window.addEventListener('hashchange', () => { cancelled = true; }, { once: true });
    (async () => {
      try {
        let elevs;
        if (hasRealElevation(stats.dogPts)) {
          elevs = stats.dogPts.map((p) => p.ele);
        } else {
          elevs = (await fetchElevationsSmart(stats.dogPts)).elevs;
        }
        if (cancelled) return;
        const { gain, loss } = elevGainLoss(elevs);
        hunt.elevStats = { gain: Math.round(gain), loss: Math.round(loss) };
        await dbPut(hunt);
        const gainEl = document.getElementById('elevGainVal');
        const lossEl = document.getElementById('elevLossVal');
        if (gainEl) gainEl.textContent = fmt.m(gain);
        if (lossEl) lossEl.textContent = fmt.m(loss);
      } catch (err) {
        if (cancelled) return;
        const gainEl = document.getElementById('elevGainVal');
        const lossEl = document.getElementById('elevLossVal');
        if (gainEl) gainEl.textContent = '–';
        if (lossEl) lossEl.textContent = '–';
      }
    })();
  }

  // Endurance insight: only shown once enough hunts exist to fit a model.
  (async () => {
    const allHunts = await dbGetAll();
    const model = computeCriticalSpeedModel(allHunts);
    const slot = document.getElementById('enduranceSlot');
    if (!slot || !model || model.insufficientData) return;
    const overSec = timeAboveSpeed(stats.dogPts, model.CS * 3.6);
    slot.innerHTML = `
      <div class="section-label">Utholdenhet</div>
      <div class="note">
        Basert på ${model.huntsUsed} lagrede turer er estimert kritisk hastighet <b>${(model.CS * 3.6).toFixed(1)} km/t</b> —
        farten der utmattelse begynner å hope seg opp raskt. I denne turen jobbet hun over den grensen i
        <b>${fmt.min(overSec / 60)}</b> av totalt ${fmt.min(stats.durationMin)}.
      </div>
    `;
  })();
}

function downsampleArr(arr, target) {
  if (arr.length <= target) return arr;
  const step = Math.ceil(arr.length / target);
  const out = arr.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function elevGainLoss(elevations) {
  let gain = 0, loss = 0;
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) gain += d; else loss += -d;
  }
  return { gain, loss };
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
// Loading a handful of DEM tiles is the only network cost — once cached,
// decoding elevation for any number of lat/lon points is just pixel math,
// so there is no reason to cap how many track points get real terrain
// height (unlike the old per-request JSON API this replaced).
async function ensureTilesLoaded(latlonPairs, zoom, tileCache) {
  const needed = new Map();
  latlonPairs.forEach(([lat, lon]) => {
    const { x, y } = lonLatToTile(lon, lat, zoom);
    needed.set(`${x}/${y}`, { x, y });
  });
  await Promise.all([...needed.entries()].map(async ([key, { x, y }]) => {
    if (tileCache.has(key)) return;
    try { tileCache.set(key, await loadTileImageData(x, y, zoom)); }
    catch (e) { tileCache.set(key, null); }
  }));
}
function decodeElevAt(lat, lon, zoom, tileCache) {
  const { x, y } = lonLatToTile(lon, lat, zoom);
  const imgData = tileCache.get(`${x}/${y}`);
  if (!imgData) return null;
  const { px, py } = lonLatToPixel(lon, lat, zoom, x, y);
  const cx = Math.max(0, Math.min(255, px)), cy = Math.max(0, Math.min(255, py));
  const idx = (cy * 256 + cx) * 4;
  const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
  return r * 256 + g + b / 256 - 32768;
}
async function fetchElevations(points, zoom = 13) {
  const tileCache = new Map();
  await ensureTilesLoaded(points.map((p) => [p.lat, p.lon]), zoom, tileCache);
  const results = points.map((p) => decodeElevAt(p.lat, p.lon, zoom, tileCache));
  if (results.some((e) => e == null)) throw new Error('Terrengdata utilgjengelig for deler av området');
  return results;
}

/* ---------------- Kartverket høydedata (1 m i kartlagte områder, ellers 20 m — vesentlig
 * finere enn Terrarium/SRTM sine ~25-30 m). Prøves først; går stille tilbake til
 * Terrarium-flisene over hvis tjenesten eller antatt parameterformat ikke skulle stemme. */
function latLonToUTM33(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lon0 = (15 * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180, lonR = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = ep2 * Math.cos(latR) ** 2;
  const A = Math.cos(latR) * (lonR - lon0);
  const M = a * (
    (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * latR -
    ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latR) +
    ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
    ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR)
  );
  const east = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const north = k0 * (M + N * Math.tan(latR) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { north, east };
}
function extractElevationField(data) {
  const candidates = [
    data?.punkter?.[0]?.z, data?.punkter?.[0]?.hoyde, data?.punkter?.[0]?.høyde,
    data?.z, data?.hoyde, data?.høyde, data?.elevation,
    Array.isArray(data) ? data[0]?.z : undefined,
    Array.isArray(data) ? data[0]?.hoyde : undefined,
  ];
  for (const c of candidates) if (typeof c === 'number' && isFinite(c)) return c;
  return null;
}
async function tryKartverketPoint(lat, lon) {
  const utm = latLonToUTM33(lat, lon);
  const url = `https://ws.geonorge.no/hoydedata/v1/punkt?nord=${utm.north.toFixed(1)}&ost=${utm.east.toFixed(1)}&koordsys=25833&geojson=false`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return extractElevationField(await res.json());
  } catch (e) { return null; }
}
let kartverketAvailable = null; // null = untested this session
async function fetchElevationsSmart(points) {
  if (kartverketAvailable === null) {
    const mid = points[Math.floor(points.length / 2)];
    kartverketAvailable = (await tryKartverketPoint(mid.lat, mid.lon)) != null;
  }
  if (!kartverketAvailable) {
    return { source: 'terrarium', elevs: await fetchElevations(points) };
  }
  // Sparse sample via the (rate-limited, per-point) Kartverket API, then
  // linearly interpolate for full track resolution — accurate where it
  // counts without hammering the service with thousands of requests.
  const targetSamples = Math.min(70, points.length);
  const step = Math.max(1, Math.floor(points.length / targetSamples));
  const sampleIdx = [];
  for (let i = 0; i < points.length; i += step) sampleIdx.push(i);
  if (sampleIdx[sampleIdx.length - 1] !== points.length - 1) sampleIdx.push(points.length - 1);

  const sampleElevs = new Array(sampleIdx.length).fill(null);
  const CHUNK = 8;
  for (let c = 0; c < sampleIdx.length; c += CHUNK) {
    const chunk = sampleIdx.slice(c, c + CHUNK);
    const results = await Promise.all(chunk.map((i) => tryKartverketPoint(points[i].lat, points[i].lon)));
    results.forEach((z, k) => { sampleElevs[c + k] = z; });
  }
  for (let k = 0; k < sampleElevs.length; k++) {
    if (sampleElevs[k] == null) {
      let best = null, bestD = Infinity;
      for (let k2 = 0; k2 < sampleElevs.length; k2++) {
        if (sampleElevs[k2] != null && Math.abs(k2 - k) < bestD) { bestD = Math.abs(k2 - k); best = sampleElevs[k2]; }
      }
      sampleElevs[k] = best ?? 0;
    }
  }
  const full = new Array(points.length).fill(null);
  sampleIdx.forEach((idx, k) => { full[idx] = sampleElevs[k]; });
  for (let k = 0; k < sampleIdx.length - 1; k++) {
    const i0 = sampleIdx[k], i1 = sampleIdx[k + 1];
    const z0 = full[i0], z1 = full[i1];
    for (let i = i0 + 1; i < i1; i++) {
      const f = (i - i0) / (i1 - i0);
      full[i] = z0 + f * (z1 - z0);
    }
  }
  return { source: 'kartverket', elevs: full };
}

// Samples a regular lat/lon grid across (and a bit beyond) a bounding box,
// for building an actual terrain surface rather than just a height-per-point line.
async function fetchTerrainGrid(minLat, maxLat, minLon, maxLon, gridN = 26, zoom = 13) {
  const marginLat = (maxLat - minLat) * 0.25 || 0.001;
  const marginLon = (maxLon - minLon) * 0.25 || 0.001;
  minLat -= marginLat; maxLat += marginLat;
  minLon -= marginLon; maxLon += marginLon;
  const cells = [];
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      const lat = minLat + ((maxLat - minLat) * i) / (gridN - 1);
      const lon = minLon + ((maxLon - minLon) * j) / (gridN - 1);
      cells.push({ lat, lon });
    }
  }
  const tileCache = new Map();
  await ensureTilesLoaded(cells.map((c) => [c.lat, c.lon]), zoom, tileCache);
  const grid = cells.map((c) => ({ ...c, elev: decodeElevAt(c.lat, c.lon, zoom, tileCache) }));
  return { gridN, grid };
}

/* ---------------- 3D view (real terrenghøyde: enhetens egen GPX-høyde om den finnes, ellers åpne terrengdata) ---------------- */
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
      <div id="three-status" class="note" style="margin:0 20px 10px;">Henter terreng for området …</div>
      <div id="three-wrap" style="width:100%;height:60vh;min-height:360px;position:relative;background:radial-gradient(ellipse at 50% 20%, #1c2a1d, #0d130e);">
        <canvas id="three-canvas" style="display:block;width:100%;height:100%;touch-action:none;"></canvas>
        <div style="position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:6px;">
          <button id="zoomInBtn" style="width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:rgba(30,42,31,0.85);color:var(--text);font-size:18px;">+</button>
          <button id="zoomOutBtn" style="width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:rgba(30,42,31,0.85);color:var(--text);font-size:18px;">−</button>
        </div>
      </div>
      <div class="legend" style="padding:0 20px;margin-top:12px;">
        ${stats.wind ? `
          <span><span class="swatch" style="background:#4c8fbd"></span>Mot vind</span>
          <span><span class="swatch" style="background:#e8541e"></span>Med vind</span>
          <span><span class="swatch" style="background:#93998c"></span>På tvers</span>
        ` : `
          <span><span class="swatch" style="background:#2fe6c9"></span>Hund</span>
        `}
        <span><span class="swatch" style="background:#ede6d6"></span>Fører</span>
        <span><span class="swatch" style="background:#7a9b6e;border-radius:50%;width:8px;height:8px;"></span>Stand</span>
        <span><span class="swatch" style="background:#e8b923;border-radius:50%;width:8px;height:8px;"></span>Fuglefunn</span>
      </div>
      <p class="note" style="margin:10px 20px 0;">Ett: roter. To: zoom/panorer. Høyreklikk-dra (PC): panorer.</p>
    </main>
  `;
  let cancelled = false;
  window.addEventListener('hashchange', () => { cancelled = true; }, { once: true });
  document.getElementById('backBtn').onclick = () => navigate('hunt', id);
  const statusEl = document.getElementById('three-status');

  const dogPts = stats.dogPts; // FULL resolution — real device data, not smoothed down

  const lats = dogPts.map((p) => p.lat), lons = dogPts.map((p) => p.lon);
  if (stats.hunterPts) { stats.hunterPts.forEach((p) => { lats.push(p.lat); lons.push(p.lon); }); }
  const bbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };

  let dogElev = null, terrain = null;
  try {
    // Always sample the track's height from the SAME terrain source used to
    // build the ground mesh below (rather than the GPX device elevation,
    // which even when present can differ from the mesh by enough to make
    // the track dip below the surface here and there). One consistent
    // source guarantees the track and the terrain never disagree — and
    // Kartverket's data is high-resolution across Norway anyway.
    const result = await fetchElevationsSmart(dogPts);
    dogElev = result.elevs;
    if (cancelled) return;
    statusEl.textContent = result.source === 'kartverket'
      ? 'Terreng og posisjon fra Kartverkets høydedata (1 m i kartlagte områder).'
      : 'Terreng og posisjon fra åpne høydedata (Terrarium/SRTM).';
    terrain = await fetchTerrainGrid(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon);
    if (cancelled) return;
  } catch (err) {
    if (cancelled) return;
    statusEl.textContent = 'Fikk ikke hentet terreng akkurat nå (nett eller høydedata utilgjengelig) — viser sporet flatt i stedet.';
  }
  if (cancelled) return;

  try {
    init3D(stats, hunt, { dogPts, dogElev, terrain });
  } catch (err) {
    if (!cancelled) statusEl.textContent = '3D-visning feilet på denne enheten. Prøv igjen, eller se kartet i 2D i stedet.';
  }
}

function init3D(stats, hunt, elevData) {
  const canvas = document.getElementById('three-canvas');
  const wrap = document.getElementById('three-wrap');
  const W = () => wrap.clientWidth, H = () => wrap.clientHeight;
  const { dogPts, dogElev, terrain } = elevData;

  const lat0 = dogPts[Math.floor(dogPts.length / 2)].lat;
  const lon0 = dogPts[Math.floor(dogPts.length / 2)].lon;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(toRad(lat0));
  const project = (lat, lon) => [(lon - lon0) * mPerLon, (lat - lat0) * mPerLat];

  const VERTICAL_EXAGGERATION = 1.8;
  const allElevs = [
    ...(dogElev || []),
    ...(terrain ? terrain.grid.map((g) => g.elev).filter((e) => e != null) : []),
  ];
  const minElev = allElevs.length ? Math.min(...allElevs) : 0;
  const elevY = (e) => (e == null ? 0 : (e - minElev) * VERTICAL_EXAGGERATION);

  let catForIdx = null;
  if (stats.wind) {
    catForIdx = dogPts.map((p) => {
      let best = null, bestD = Infinity;
      stats.wind.segs.forEach((s) => {
        const dmid = haversine(p.lat, p.lon, (s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2);
        if (dmid < bestD) { bestD = dmid; best = s.cat; }
      });
      return best || 'cross';
    });
  }

  const scene = new THREE.Scene();

  // Terrain surface: a real triangulated mesh with vertex height from open
  // elevation data, colored low (moss) to high (warm tan) — not just a line
  // floating in space.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  if (terrain) {
    const n = terrain.gridN;
    const positions = [];
    const colors = [];
    const terrainElevs = terrain.grid.map((g) => g.elev).filter((e) => e != null);
    const tMin = Math.min(...terrainElevs), tMax = Math.max(...terrainElevs) || tMin + 1;
    const low = new THREE.Color(0x2e4a30), high = new THREE.Color(0xb99b6b);
    terrain.grid.forEach((g) => {
      const [x, z] = project(g.lat, g.lon);
      const e = g.elev == null ? tMin : g.elev;
      const y = elevY(e);
      positions.push(x, y, z);
      const frac = tMax > tMin ? (e - tMin) / (tMax - tMin) : 0;
      const col = low.clone().lerp(high, frac);
      colors.push(col.r, col.g, col.b);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    });
    const indices = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j, b = i * n + j + 1, c = (i + 1) * n + j, d = (i + 1) * n + j + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    tgeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    tgeo.setIndex(indices);
    tgeo.computeVertexNormals();
    const tmat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    scene.add(new THREE.Mesh(tgeo, tmat));
  }

  // Dog track — full GPS resolution, rendered as an actual solid tube (not a
  // hairline) so it reads clearly against the terrain, and lifted a fixed
  // clearance above the surface so float/interpolation differences between
  // the track's own sampled height and the mesh's blended grid height can
  // never make it dip below and disappear into the ground.
  const trackR = Math.max(0.9, Math.max(maxX - minX, maxZ - minZ) * 0.01);
  const terrainClearance = trackR * 2.4;
  function pointAt(i) {
    const [x, z] = project(dogPts[i].lat, dogPts[i].lon);
    const y = elevY(dogElev ? dogElev[i] : null) + terrainClearance;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    return new THREE.Vector3(x, y, z);
  }
  function addTube(idxs, radius, color, opacity) {
    if (idxs.length < 2) return;
    const pts3 = idxs.map(pointAt);
    const curve = new THREE.CatmullRomCurve3(pts3);
    const tubularSegments = Math.max(2, Math.min(400, idxs.length * 2));
    const tgeo = new THREE.TubeGeometry(curve, tubularSegments, radius, 6, false);
    const tmat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
    scene.add(new THREE.Mesh(tgeo, tmat));
  }

  if (catForIdx) {
    const catHex = { upwind: 0x4c8fbd, downwind: 0xe8541e, cross: 0x93998c };
    let curCat = catForIdx[0], curIdxs = [0];
    for (let i = 1; i < dogPts.length; i++) {
      if (catForIdx[i] !== curCat) {
        curIdxs.push(i); // shared point so adjacent tubes join with no visible gap
        addTube(curIdxs, trackR, catHex[curCat], 1);
        curCat = catForIdx[i];
        curIdxs = [i];
      } else curIdxs.push(i);
    }
    addTube(curIdxs, trackR, catHex[curCat], 1);
  } else {
    // A single vivid, high-contrast colour (not the muted blue/orange used
    // elsewhere) so the whole track stands out clearly against the terrain
    // mesh's green-to-tan palette regardless of viewing angle.
    addTube(dogPts.map((_, i) => i), trackR, 0x2fe6c9, 1);
  }

  // Hunter track, draped using the nearest dog-track elevation as a proxy.
  if (stats.hunterPts && stats.hunterPts.length > 1 && dogElev) {
    const hIdxToDogIdx = stats.hunterPts.map((p) => {
      let best = 0, bestD = Infinity;
      dogPts.forEach((dp, i) => {
        const dd = haversine(p.lat, p.lon, dp.lat, dp.lon);
        if (dd < bestD) { bestD = dd; best = i; }
      });
      return best;
    });
    const hPts3 = stats.hunterPts.map((p, k) => {
      const [x, z] = project(p.lat, p.lon);
      const y = elevY(dogElev[hIdxToDogIdx[k]]) + terrainClearance * 1.4;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      return new THREE.Vector3(x, y, z);
    });
    if (hPts3.length >= 2) {
      const hCurve = new THREE.CatmullRomCurve3(hPts3);
      const hSeg = Math.max(2, Math.min(400, hPts3.length * 2));
      const hGeo = new THREE.TubeGeometry(hCurve, hSeg, trackR * 0.55, 6, false);
      const hMat = new THREE.MeshBasicMaterial({ color: 0xede6d6, transparent: true, opacity: 0.85 });
      scene.add(new THREE.Mesh(hGeo, hMat));
    }
  }

  // Stands, elevated to match the track height at that point, with a thin
  // "pin" line down to the terrain so they're easy to spot from any angle.
  const markerR = Math.max(1.2, Math.max(maxX - minX, maxZ - minZ) * 0.012);
  stats.stands.forEach((s) => {
    const [x, z] = project(s.lat, s.lon);
    let best = 0, bestD = Infinity;
    dogPts.forEach((dp, i) => {
      const dd = haversine(s.lat, s.lon, dp.lat, dp.lon);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    const y = elevY(dogElev ? dogElev[best] : null);
    const geo2 = new THREE.SphereGeometry(markerR, 16, 16);
    const mat2 = new THREE.MeshBasicMaterial({ color: 0x7a9b6e });
    const sph = new THREE.Mesh(geo2, mat2);
    sph.position.set(x, y + markerR * 1.6, z);
    scene.add(sph);
    const poleGeo = new THREE.BufferGeometry();
    poleGeo.setAttribute('position', new THREE.Float32BufferAttribute([x, y, z, x, y + markerR * 1.6, z], 3));
    scene.add(new THREE.Line(poleGeo, new THREE.LineBasicMaterial({ color: 0x7a9b6e, transparent: true, opacity: 0.6 })));
  });

  // Bird sightings, as a distinct amber cone (vs. the green stand spheres).
  (hunt.birdSightings || []).forEach((b) => {
    const [x, z] = project(b.lat, b.lon);
    let best = 0, bestD = Infinity;
    dogPts.forEach((dp, i) => {
      const dd = haversine(b.lat, b.lon, dp.lat, dp.lon);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    const y = elevY(dogElev ? dogElev[best] : null);
    const coneGeo = new THREE.ConeGeometry(markerR, markerR * 2.2, 12);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xe8b923 });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(x, y + markerR * 2.2, z);
    scene.add(cone);
    const poleGeo2 = new THREE.BufferGeometry();
    poleGeo2.setAttribute('position', new THREE.Float32BufferAttribute([x, y, z, x, y + markerR * 1.1, z], 3));
    scene.add(new THREE.Line(poleGeo2, new THREE.LineBasicMaterial({ color: 0xe8b923, transparent: true, opacity: 0.6 })));
  });

  const spanX = Math.max(maxX - minX, 50), spanZ = Math.max(maxZ - minZ, 50);
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  const maxElevSeen = allElevs.length ? (Math.max(...allElevs) - minElev) * VERTICAL_EXAGGERATION : 0;
  const target = new THREE.Vector3(centerX, maxElevSeen / 2 + 2, centerZ);
  const gridSize = Math.max(spanX, spanZ) * 1.4;
  const radius0 = Math.max(spanX, spanZ) * 0.9 + 40;
  const MIN_RADIUS = Math.max(spanX, spanZ) * 0.08 + 5;
  const MAX_RADIUS = radius0 * 4;

  const camera = new THREE.PerspectiveCamera(52, W() / H(), 0.1, gridSize * 6 + 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W(), H());

  let azimuth = Math.PI * 0.25, elevAngle = 0.55, radius = radius0;
  let dragging = false, panning = false, lastX = 0, lastY = 0, idleTimer = null, autoRotate = true;
  let pinchStartDist = null, pinchStartRadius = null, pinchLastMidX = null, pinchLastMidY = null;

  function setCamera() {
    const cy = Math.sin(elevAngle) * radius;
    const ch = Math.cos(elevAngle) * radius;
    camera.position.set(target.x + Math.cos(azimuth) * ch, target.y + cy, target.z + Math.sin(azimuth) * ch);
    camera.lookAt(target);
  }
  setCamera();

  function zoomBy(factor) {
    radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius * factor));
    setCamera();
  }
  // Pan moves the look-at point itself, in the camera's current left/right
  // and up/down screen directions — so you can settle the view on one
  // specific spot instead of only ever orbiting the track's centre.
  function panBy(dxPx, dyPx) {
    const panScale = radius * 0.0016;
    const rightX = Math.sin(azimuth), rightZ = -Math.cos(azimuth);
    target.x += -dxPx * panScale * rightX;
    target.z += -dxPx * panScale * rightZ;
    target.y += dyPx * panScale;
    setCamera();
  }
  function onDown(x, y) { dragging = true; lastX = x; lastY = y; autoRotate = false; clearTimeout(idleTimer); }
  function onMove(x, y) {
    if (!dragging) return;
    const dx = x - lastX, dy = y - lastY;
    azimuth -= dx * 0.006;
    elevAngle = Math.max(0.08, Math.min(1.5, elevAngle + dy * 0.005));
    lastX = x; lastY = y;
    setCamera();
  }
  function onWindowMouseMove(e) {
    if (panning) { panBy(e.clientX - lastX, e.clientY - lastY); lastX = e.clientX; lastY = e.clientY; return; }
    onMove(e.clientX, e.clientY);
  }
  function onUp() {
    dragging = false; panning = false; pinchStartDist = null;
    idleTimer = setTimeout(() => { autoRotate = true; }, 2500);
  }
  function onWheel(e) { zoomBy(1 + e.deltaY * 0.001); e.preventDefault(); }
  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  function touchMid(touches) {
    return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
  }
  function onTouchStart(e) {
    autoRotate = false; clearTimeout(idleTimer);
    if (e.touches.length === 2) {
      dragging = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartRadius = radius;
      const mid = touchMid(e.touches);
      pinchLastMidX = mid.x; pinchLastMidY = mid.y;
    } else if (e.touches.length === 1) {
      onDown(e.touches[0].clientX, e.touches[0].clientY);
    }
  }
  function onTouchMove(e) {
    if (e.touches.length === 2 && pinchStartDist != null) {
      // Two fingers: pinch distance zooms, midpoint movement pans — both at once, as expected.
      const d = touchDist(e.touches);
      radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, pinchStartRadius * (pinchStartDist / d)));
      const mid = touchMid(e.touches);
      panBy(mid.x - pinchLastMidX, mid.y - pinchLastMidY);
      pinchLastMidX = mid.x; pinchLastMidY = mid.y;
      setCamera();
    } else if (e.touches.length === 1) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) { panning = true; lastX = e.clientX; lastY = e.clientY; autoRotate = false; clearTimeout(idleTimer); }
    else onDown(e.clientX, e.clientY);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: true });
  canvas.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  if (zoomInBtn) zoomInBtn.onclick = () => zoomBy(0.8);
  if (zoomOutBtn) zoomOutBtn.onclick = () => zoomBy(1.25);

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
  setTimeout(onResize, 0);
  setTimeout(onResize, 250);

  const cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('hashchange', cleanup);
    clearTimeout(idleTimer);
    renderer.dispose();
  };
  window.addEventListener('hashchange', cleanup, { once: true });
}

/* ---------------- boot ---------------- */
router();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update().catch(() => {}))
    .catch(() => {});
}
