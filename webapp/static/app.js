/* SG commute/housing explorer — all analysis runs client-side on the full bus
 * and rail networks so every drag, slider and toggle recomputes instantly.
 *
 * Runs in two modes:
 *   - server mode  : talks to app.py (/api/*) for data, geocoding, saving
 *   - offline mode : window.EMBEDDED_BUNDLE is pre-injected (single-file export)
 *
 * The model: there is no privileged way to get to work. Each of the three modes
 * (direct bus / direct rail / company shuttle) can be switched off entirely, and
 * `starRule` decides how many of the enabled ones a place has to satisfy before
 * it earns a ⭐. Everything else -- the map layers, the sidebar, the CSV -- reads
 * off that one decision, so turning off "shuttle" really does mean the shuttle
 * stops influencing the recommendations rather than just hiding some pins.
 *
 * Every way of getting to work also carries an estimated door-to-door time
 * (see "time model" below), and 🚌/🚆/🔁 only count while that time is under
 * the user's ceiling -- a direct bus that takes 80 minutes is not a reason to
 * live somewhere.
 */

const OFFLINE = !!window.EMBEDDED_BUNDLE;

/* Leaflet finds its default marker images by inspecting the URL it was loaded
 * from. That detection cannot work in the single-file build, where the library
 * is inlined and the images are data: URIs, so both builds are told explicitly. */
if (window.LEAFLET_ICONS) {
  delete L.Icon.Default.prototype._getIconUrl;
  Object.assign(L.Icon.Default.prototype.options, {
    iconUrl: window.LEAFLET_ICONS.icon,
    iconRetinaUrl: window.LEAFLET_ICONS.icon2x,
    shadowUrl: window.LEAFLET_ICONS.shadow,
  });
} else {
  L.Icon.Default.imagePath = "/static/vendor/images/";
}

/* ---------- language ----------
 * Two languages, one code path: every string the page shows is written as
 * T(chinese, english) right where it is used (T, because Leaflet owns L), so both versions sit side by side
 * and neither can drift out of a separate table. Static text in index.html
 * carries its English in data-en and friends; applyStaticText() swaps them.
 * The choice belongs to the viewer (localStorage), defaulting to the browser's
 * language, so a shared copy opens in the reader's language, not the author's. */
const LANG_KEY = "sgCommuteLang";
let LANG = (() => {
  try { const v = localStorage.getItem(LANG_KEY); if (v === "zh" || v === "en") return v; } catch (e) { /* private mode */ }
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
})();
const T = (zh, en) => (LANG === "en" ? en : zh);

function applyStaticText() {
  document.documentElement.lang = T("zh-Hant", "en");
  document.title = T("SG 通勤租屋互動探索器", "SG commute & housing explorer");
  document.querySelectorAll("[data-en]").forEach(el => {
    if (el.dataset.zh === undefined) el.dataset.zh = el.innerHTML;
    el.innerHTML = T(el.dataset.zh, el.dataset.en);
  });
  for (const [attr, key] of [["placeholder", "Ph"], ["title", "Title"], ["aria-label", "Aria"]])
    document.querySelectorAll("[data-en-" + key.toLowerCase() + "]").forEach(el => {
      if (el.dataset["zh" + key] === undefined) el.dataset["zh" + key] = el.getAttribute(attr) || "";
      el.setAttribute(attr, T(el.dataset["zh" + key], el.dataset["en" + key]));
    });
  document.querySelectorAll("[data-lang-toggle]").forEach(b => {
    b.textContent = T("EN", "中文");
    b.title = T("Switch to English", "切換成中文");
  });
}

function setLang(lang) {
  LANG = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* stays for this visit only */ }
  applyStaticText();
  // everything else on screen is rebuilt from state by the normal render path
  if (state && map) { buildShuttleMarkers(); refresh(); }
  if (!OFFLINE && $("setup").style.display !== "none") refreshStatus();
}

/* ---------- tiny helpers ---------- */
const $ = id => document.getElementById(id);
const R_EARTH = 6371000;
function haversine(a1, o1, a2, o2) {
  const p1 = a1 * Math.PI / 180, p2 = a2 * Math.PI / 180;
  const dp = (a2 - a1) * Math.PI / 180, dl = (o2 - o1) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2600);
}
const PALETTE = ["#f59e0b", "#8b5cf6", "#15803d", "#b91c1c", "#0369a1", "#be185d", "#4d7c0f", "#7c2d12"];
const modeLabel = m => ({
  bus: T("公車直達", "Direct bus"), rail: T("捷運直達", "Direct MRT"),
  transfer: T("轉乘一次", "One transfer"), shuttle: T("廠車", "Shuttle") }[m]);
// station names in the data are bare ("PASIR RIS"); say what kind of place it is
const stn = n => T(n + " 站", n + " Stn");
const MODE_ICON = { bus: "🚌", rail: "🚆", transfer: "🔁", shuttle: "🚐" };
const ALL_MODES = ["bus", "rail", "transfer", "shuttle"];

/* ---------- data + state ---------- */
let STOPS = {}, STOP_CODES = [], ROUTES = [], TOWNS = {};
let RAIL_STATIONS = {}, RAIL_NAMES = [], RAIL_LINES = [], LINE_BY_CODE = {};
let TRANSFER_WALK = 300, RAIL_WALK = 500;
let state = null, calc = {}, map = null;
let placingShuttle = false, addrHits = [];

/* ---------- time model ----------
 * Estimated minutes = walk + wait + ride (+ changes). A stop count alone hides
 * a 2x spread ("3 stops" is 0.9 km on one route, 1.8 km on another) and treats
 * a bus every 20 minutes like one every 5. The seeds live in config.py
 * TIME_MODEL and arrive with the bundle; these defaults only cover bundles
 * produced before it existed. Every `min` / `cost` below is in minutes. */
const TM_DEFAULTS = { walkMPerMin: 80, walkDetour: 1.3, busKmh: 17, busWaitDefaultMin: 6,
  railKmh: 28, railWaitMin: 3, railInterchangeMin: 5 };
let TM = { ...TM_DEFAULTS };
// straight-line metres are shorter than the path anyone actually walks
const walkT = m => m * TM.walkDetour / TM.walkMPerMin;
const walkMin = m => Math.max(1, Math.round(walkT(m)));
const fmtMin = t => T("約 " + Math.round(t) + " 分", "~" + Math.round(t) + " min");
// ROUTES[i][5] is the AM peak headway; the expected wait is half of it
function busWait(i) { const h = ROUTES[i][5]; return h ? h / 2 : TM.busWaitDefaultMin; }
// ROUTES[i][4] is km from the route's origin per stop; older bundles lack it,
// so fall back to the median stop spacing (0.4 km)
function busRide(i, from, to) {
  const km = ROUTES[i][4];
  return Math.max(0, km ? km[to] - km[from] : (to - from) * 0.4) / TM.busKmh * 60;
}
function railRide(L, p, q) {
  const c = LINE_BY_CODE[L].cum;
  return Math.abs(c[q] - c[p]) / 1000 / TM.railKmh * 60;
}
// the 🚌/🚆/🔁 ceiling; the slider's top end means "no limit"
const MAX_TOTAL_TOP = 120;
function maxTotal() { return state.maxTotalMin >= MAX_TOTAL_TOP ? Infinity : state.maxTotalMin; }
/* Keep the `keep` cheapest hits per key -- the sidebar only shows the best few,
 * and "first found" would be whichever route happens to sort first. */
function pushBest(map, key, hit, keep = 6) {
  let a = map.get(key);
  if (!a) map.set(key, a = []);
  if (a.length >= keep) {
    if (hit.min >= a[keep - 1].min) return;
    a.pop();
  }
  a.push(hit);
  a.sort((x, y) => x.min - y.min);
}
function hhmmMinus(hhmm, t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return null;
  const v = ((+m[1] * 60 + +m[2] - Math.ceil(t)) % 1440 + 1440) % 1440;
  return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
}

/* ROUTES[i][3] is the label the server built from BusServices ("3 往 Punggol
 * Int", "15 循環（經 Marine Parade Rd）"). The Direction fallback is only for
 * bundles produced before that field existed. English is reworded from the
 * same label, so bundles and single-file copies need no second field. */
function routeLabel(i) {
  const r = ROUTES[i], s = r[3] || (r[0] + " (方向 " + r[1] + ")");
  if (LANG !== "en") return s;
  return s.replace(/^(\S+) 往 (.+)$/, "$1 to $2")
    .replace(/^(\S+) 循環(?:（經 (.+)）)?$/, (m, n, via) => n + " loop" + (via ? " (via " + via + ")" : ""))
    .replace(/ \(方向 (\d)\)$/, " (direction $1)");
}
function routeColor(i) { return "hsl(" + ((i * 47) % 360) + ", 65%, 45%)"; }
function lineLabel(code) { return LINE_BY_CODE[code] ? LINE_BY_CODE[code].name : code; }
function lineColor(code) { return LINE_BY_CODE[code] ? LINE_BY_CODE[code].color : "#6b7280"; }
function townOf(road) {
  const low = (road || "").toLowerCase();
  for (const kw in TOWNS) if (low.includes(kw)) return TOWNS[kw];
  return road || T("未知", "Unknown");
}
function modes() { return state.modes; }
function enabledModes() { return ALL_MODES.filter(m => state.modes[m]); }
function access() { return state.modes.shuttleAccess; }
/* "at least two" is meaningless when the user only enabled one mode, so the
 * threshold is clamped rather than silently producing an empty result list. */
function starThreshold() {
  const n = enabledModes().length;
  if (!n) return Infinity;
  if (state.modes.starRule === "any") return 1;
  if (state.modes.starRule === "all") return n;
  return Math.min(2, n);
}

/* ---------- spatial index ----------
 * A flat grid over each point set. The candidate scan asks "is there a stop of
 * kind X within walking distance?" ~5,400 times per recompute, so the answer has
 * to come from a handful of cells rather than a full sweep of the network. */
const CELL = 0.006;  // ~660 m at Singapore's latitude
function buildGrid(entries) {
  const g = new Map();
  for (const e of entries) {
    const k = Math.floor(e.lat / CELL) + ":" + Math.floor(e.lon / CELL);
    let a = g.get(k); if (!a) g.set(k, a = []);
    a.push(e);
  }
  return g;
}
function gridNear(grid, lat, lon, r) {
  const span = Math.ceil(r / 110000 / CELL);
  const gi = Math.floor(lat / CELL), gj = Math.floor(lon / CELL), out = [];
  for (let i = gi - span; i <= gi + span; i++)
    for (let j = gj - span; j <= gj + span; j++) {
      const a = grid.get(i + ":" + j); if (!a) continue;
      for (const e of a) {
        const d = haversine(lat, lon, e.lat, e.lon);
        if (d <= r) out.push({ key: e.key, lat: e.lat, lon: e.lon, dist: d });
      }
    }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}
function anyWithin(grid, lat, lon, r) {
  const span = Math.ceil(r / 110000 / CELL);
  const gi = Math.floor(lat / CELL), gj = Math.floor(lon / CELL);
  for (let i = gi - span; i <= gi + span; i++)
    for (let j = gj - span; j <= gj + span; j++) {
      const a = grid.get(i + ":" + j); if (!a) continue;
      for (const e of a) if (haversine(lat, lon, e.lat, e.lon) <= r) return true;
    }
  return false;
}
/* The time-aware sibling of anyWithin(): the cheapest walk-plus-`cost` over the
 * entries within r. Entries carry `cost`, the minutes from boarding there to
 * the destination. Returns {t, e, d} or null. */
function bestWithin(grid, lat, lon, r) {
  const span = Math.ceil(r / 110000 / CELL);
  const gi = Math.floor(lat / CELL), gj = Math.floor(lon / CELL);
  let best = null;
  for (let i = gi - span; i <= gi + span; i++)
    for (let j = gj - span; j <= gj + span; j++) {
      const a = grid.get(i + ":" + j); if (!a) continue;
      for (const e of a) {
        const d = haversine(lat, lon, e.lat, e.lon);
        if (d > r) continue;
        const t = walkT(d) + e.cost;
        if (!best || t < best.t) best = { t, e, d };
      }
    }
  return best;
}
let STOP_GRID = null, RAIL_GRID = null;
function buildBaseGrids() {
  STOP_GRID = buildGrid(STOP_CODES.map(c => ({ key: c, lat: STOPS[c][0], lon: STOPS[c][1] })));
  RAIL_GRID = buildGrid(RAIL_NAMES.map(n => ({ key: n, lat: RAIL_STATIONS[n][0], lon: RAIL_STATIONS[n][1] })));
}
function nearestStop(lat, lon, r = 2000) {
  const hits = gridNear(STOP_GRID, lat, lon, r);
  return hits.length ? { code: hits[0].key, dist: hits[0].dist } : { code: null, dist: Infinity };
}
function nearestStation(lat, lon, r = 2000) {
  const hits = gridNear(RAIL_GRID, lat, lon, r);
  return hits.length ? { name: hits[0].key, dist: hits[0].dist } : { name: null, dist: Infinity };
}

/* OneMap's public search replies with `Access-Control-Allow-Origin: *`, so the
 * single-file build can call it straight from the page. The Flask proxy exists
 * for convenience in server mode, not to work around CORS. */
const ONEMAP_SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search";

async function geocodeSearch(q) {
  if (!OFFLINE) {
    const { data } = await api("/api/geocode?q=" + encodeURIComponent(q));
    return data || { ok: false, results: [], message: T("查詢失敗", "Search failed") };
  }
  let raw;
  try {
    const r = await fetch(ONEMAP_SEARCH + "?searchVal=" + encodeURIComponent(q) +
      "&returnGeom=Y&getAddrDetails=Y&pageNum=1");
    raw = (await r.json()).results || [];
  } catch (e) {
    return { ok: false, results: [], message: T("連不到 OneMap（地址搜尋需要網路，其他功能不用）。",
      "Cannot reach OneMap (address search needs the internet; nothing else does).") };
  }
  // same de-duplication as src/geocode.py: OneMap lists one row per entrance
  const out = [], seen = new Set();
  for (const r of raw.slice(0, 16)) {
    const lat = parseFloat(r.LATITUDE), lon = parseFloat(r.LONGITUDE);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const key = r.SEARCHVAL + "|" + lat.toFixed(4) + "|" + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lon, name: r.SEARCHVAL || r.ADDRESS || q, address: r.ADDRESS || q });
    if (out.length >= 8) break;
  }
  return out.length ? { ok: true, results: out } : { ok: false, results: [], message: T("查無此地址。", "No match.") };
}

/* ---------- setup wizard (server mode only) ---------- */
async function api(path, opts = {}) {
  // the server words its messages in the page's language
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Lang": LANG } });
  let j = null;
  try { j = await r.json(); } catch (e) { /* non-JSON error page */ }
  return { ok: r.ok, data: j };
}

async function refreshStatus() {
  const { data } = await api("/api/status");
  if (!data) return null;
  AI_HAS_SERVER_KEY = !!data.hasAiKey;
  AI_LOCAL = !!data.aiLocal;
  $("stepKey").classList.toggle("done", data.hasKey);
  if (data.hasKey) $("keyMsg").innerHTML = '<span class="ok">' + T("已偵測到已儲存的 API key。", "A saved API key was found.") + '</span>';
  const ready = data.hasData && data.hasRail;
  $("stepData").classList.toggle("done", ready);
  $("btnGo").disabled = !data.hasData;
  $("btnGo").textContent = T("進入探索器", "Open the explorer");   // clear any "loading" left from a previous entry
  if (data.hasData) {
    const c = data.counts;
    $("fetchMsg").innerHTML = '<span class="ok">' + T("資料就緒：" + c.bus_stops + " 站牌 / " + c.bus_routes +
      " 路線站序 / " + c.bus_services + " 路線", "Data ready: " + c.bus_stops + " stops / " + c.bus_routes +
      " route-stop rows / " + c.bus_services + " services") +
      (data.hasRail ? T(" ＋ 捷運路網。", " + MRT network.") : T("。", ".") + '</span><span class="warn"> ' +
        T("捷運站點尚未下載，捷運直達會算不出來 — 按「重新下載」補上。",
          "MRT stations are missing, so direct MRT cannot be worked out. Press “Download again”.")) +
      '</span>';
    $("fetchBar").style.width = "100%";
  }
  return data;
}

async function pollProgress() {
  const { data } = await api("/api/progress");
  if (!data) return;
  if (data.error) {
    $("fetchMsg").innerHTML = '<span class="err">' + T("下載失敗：", "Download failed: ") + esc(data.error) + '</span>';
    $("btnFetch").disabled = false; return;
  }
  const total = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
  if (data.running) {
    const what = data.stageArg || "";
    const stage = { start: T("開始下載", "Starting"), dataset: T("下載 ", "Downloading ") + what,
      rail: T("下載捷運/輕軌站點（OneMap）", "Downloading MRT/LRT stations (OneMap)") }[data.stage] || data.stage;
    $("fetchMsg").textContent = stage + T("… 已取得 ", "… ") + total.toLocaleString() + T(" 筆", " records so far");
    // rough progress: the three bus datasets plus the rail harvest total ~37k records
    $("fetchBar").style.width = Math.min(96, (total / 37000) * 100) + "%";
    setTimeout(pollProgress, 600);
  } else if (data.done) {
    $("fetchBar").style.width = "100%";
    $("btnFetch").disabled = false;
    await refreshStatus();
    toast(T("路網資料下載完成", "Network data downloaded"));
  }
}

function wireSetup() {
  $("btnKey").addEventListener("click", async () => {
    const key = $("keyInput").value.trim();
    if (!key) return;
    $("btnKey").disabled = true; $("keyMsg").textContent = T("驗證中…", "Checking…");
    const { data } = await api("/api/key", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key })
    });
    $("btnKey").disabled = false;
    $("keyMsg").innerHTML = '<span class="' + (data && data.ok ? "ok" : "err") + '">' +
      esc(data ? data.message : T("驗證失敗", "Check failed")) + '</span>';
    if (data && data.ok) { $("keyInput").value = ""; refreshStatus(); }
  });

  const startFetch = force => async () => {
    $("btnFetch").disabled = true;
    $("fetchMsg").textContent = T("開始下載…", "Starting download…"); $("fetchBar").style.width = "2%";
    const { data } = await api("/api/fetch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force })
    });
    if (!data || !data.ok) {
      $("fetchMsg").innerHTML = '<span class="err">' + esc(data ? data.message : T("無法開始下載", "Could not start the download")) + '</span>';
      $("btnFetch").disabled = false; return;
    }
    pollProgress();
  };
  $("btnFetch").addEventListener("click", startFetch(false));
  $("btnRefetch").addEventListener("click", startFetch(true));
  $("btnGo").addEventListener("click", enterExplorer);
}

// both language buttons (wizard and explorer) are in the page from the start
document.querySelectorAll("[data-lang-toggle]").forEach(b =>
  b.addEventListener("click", () => setLang(LANG === "en" ? "zh" : "en")));

/* ---------- boot ---------- */
function loadNetwork(b) {
  STOPS = b.stops; STOP_CODES = Object.keys(STOPS); ROUTES = b.routes; TOWNS = b.towns;
  TRANSFER_WALK = b.transferWalk || 300;
  RAIL_WALK = b.railWalk || 500;
  TM = Object.assign({}, TM_DEFAULTS, b.timeModel || {});
  AI_MODELS = b.aiModels || [];
  const rail = b.rail || { stations: {}, lines: [] };
  RAIL_STATIONS = rail.stations; RAIL_NAMES = Object.keys(RAIL_STATIONS);
  RAIL_LINES = rail.lines;
  LINE_BY_CODE = {};
  for (const [code, name, color, seq] of RAIL_LINES) {
    const pos = new Map();
    seq.forEach((n, i) => pos.set(n, i));
    // metres along the line, station to station in a straight line; railRide()
    // turns differences of this into minutes
    const cum = [0];
    for (let k = 1; k < seq.length; k++) {
      const a = RAIL_STATIONS[seq[k - 1]], c = RAIL_STATIONS[seq[k]];
      cum.push(cum[k - 1] + (a && c ? haversine(a[0], a[1], c[0], c[1]) : 0));
    }
    LINE_BY_CODE[code] = { code, name, color, seq, pos, cum };
  }
  buildBaseGrids();
}

/* Older setup.json files predate the mode toggles and the per-shuttle switch. */
function normaliseSetup(s) {
  s.modes = Object.assign(
    { bus: true, rail: true, shuttle: true, transfer: false, railTransfers: 0, starRule: "two" },
    s.modes || {});
  s.modes.shuttleAccess = Object.assign({ walk: true, bus: true, rail: true }, s.modes.shuttleAccess || {});
  // Collapsed by default: plenty of people have no company shuttle at all, and
  // four pickup-point cards should not be the first thing they scroll past.
  s.ui = Object.assign({ shuttleOpen: false, probeFocus: false, mode: "manual",
    companyOpen: false, moreOpen: false, diagOpen: false }, s.ui || {});
  s.ai = s.ai && s.ai.spec && s.ai.base ? s.ai : null;
  if (!RAIL_NAMES.length) s.modes.rail = false;
  s.shuttles = (s.shuttles || []).map(sh => ({ ...sh, enabled: sh.enabled !== false }));
  // Still on the seed workplace: open the card with the search box, because
  // changing it is the first thing anyone has to do.
  if (s.company.isDefault) s.ui.companyOpen = true;
  // Setups saved before the time model limited the first leg by stops instead.
  if (!(s.feederMin > 0)) s.feederMin = 5;
  if (!(s.maxTotalMin > 0)) s.maxTotalMin = 60;
  s.probe = null; s.routeFilter = "";
  return s;
}

/* The single-file build has no server to save to, so it keeps the user's setup
 * in their browser instead -- otherwise every reload throws away the workplace
 * they just entered, which makes the shareable copy a demo rather than a tool. */
const LOCAL_SETUP_KEY = "sgCommuteSetup";
function loadLocalSetup() {
  try {
    const raw = localStorage.getItem(LOCAL_SETUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }   // private mode, quota, or hand-edited junk
}

async function boot() {
  applyStaticText();
  if (OFFLINE) {
    const b = window.EMBEDDED_BUNDLE;
    loadNetwork(b);
    const local = loadLocalSetup();
    state = normaliseSetup(local || b.setup);
    $("setup").style.display = "none";
    startExplorer();
    // The stored setup wins on purpose -- otherwise every reload throws away the
    // workplace you just entered. But re-exporting the file with a new workplace
    // then looks like it did nothing at all, so say which one is on screen.
    if (local && b.buildId && local.buildId !== b.buildId)
      setTimeout(() => toast(T("這個檔案內建的設定已更新為「" + (b.setup.company.name || "未命名") +
        "」；畫面上是你上次自己存的設定，按「重設」可切回內建版本。",
        "This file now ships with “" + (b.setup.company.name || "unnamed") +
        "”; you are seeing the settings you saved last time. “Reset” switches to the built-in ones.")), 500);
    return;
  }
  wireSetup();
  const st = await refreshStatus();
  if (st && st.progress && st.progress.running) pollProgress();
  if (st && st.hasData) enterExplorer();   // skip the wizard on later runs
}

async function enterExplorer() {
  $("btnGo").disabled = true; $("btnGo").textContent = T("載入路網中…", "Loading the network…");
  const [bundle, setup] = await Promise.all([api("/api/bundle"), api("/api/setup")]);
  if (!bundle.data || !bundle.data.ok) {
    $("fetchMsg").innerHTML = '<span class="err">' + T("載入路網失敗，請先下載資料。", "Could not load the network; download the data first.") + '</span>';
    $("btnGo").disabled = false; $("btnGo").textContent = T("進入探索器", "Open the explorer"); return;
  }
  loadNetwork(bundle.data);
  state = normaliseSetup(setup.data.setup);
  $("setup").style.display = "none";
  startExplorer();
  if (!RAIL_NAMES.length) toast(T("捷運資料未載入，「捷運直達」已自動關閉", "No MRT data loaded, so “Direct MRT” is off"));
  // ?audit in the URL: run the findability check (webapp/static/ux_audit.js)
  // on the layout as it opens and pin its table to the corner
  if (/[?&]audit\b/.test(location.search)) {
    const s = document.createElement("script");
    s.src = "/static/ux_audit.js";
    s.onload = () => setTimeout(() => window.uxAuditShow(), 800);
    document.body.appendChild(s);
  }
}

/* ---------- core computation ---------- */

/* Which rail lines get you to the workplace, with how many interchanges, and
 * how long from each station. Worked backwards from the stations near the
 * workplace one interchange at a time: layer t holds, per line, the minutes
 * from every position on it to the door having changed lines t times. With
 * ~190 stations that is a few thousand steps. A station's `min` includes the
 * platform wait and the walk from the arrival station, not the walk from home;
 * `transfers` belongs to that fastest option. */
function computeRailReach() {
  const reach = new Map();          // station name -> {lines, transfers, min, line}
  if (!RAIL_NAMES.length) return { reach, lineTransfers: new Map(), companyStations: [] };

  const companyStations = gridNear(RAIL_GRID, state.company.lat, state.company.lon, state.companyRadius);
  const blank = line => new Float64Array(line.seq.length).fill(Infinity);
  const first = new Map();
  for (const st of companyStations)
    for (const L of RAIL_STATIONS[st.key][4]) {
      const line = LINE_BY_CODE[L]; if (!line) continue;
      const p = line.pos.get(st.key); if (p === undefined) continue;
      let g = first.get(L); if (!g) first.set(L, g = blank(line));
      for (let q = 0; q < g.length; q++) g[q] = Math.min(g[q], railRide(L, q, p) + walkT(st.dist));
    }

  const layers = [first], lineTransfers = new Map();
  for (const L of first.keys()) lineTransfers.set(L, 0);
  for (let t = 1; t <= (modes().railTransfers || 0); t++) {
    const next = new Map();
    for (const [L, g] of layers[t - 1])
      LINE_BY_CODE[L].seq.forEach((k, pk) => {
        if (!isFinite(g[pk])) return;
        for (const L2 of RAIL_STATIONS[k][4]) {
          const line2 = LINE_BY_CODE[L2];
          if (L2 === L || !line2) continue;
          const p2 = line2.pos.get(k); if (p2 === undefined) continue;
          let g2 = next.get(L2); if (!g2) next.set(L2, g2 = blank(line2));
          const onward = TM.railInterchangeMin + g[pk];
          for (let q = 0; q < g2.length; q++) g2[q] = Math.min(g2[q], railRide(L2, q, p2) + onward);
        }
      });
    if (!next.size) break;
    for (const L of next.keys()) if (!lineTransfers.has(L)) lineTransfers.set(L, t);
    layers.push(next);
  }

  layers.forEach((layer, t) => {
    for (const [L, g] of layer)
      LINE_BY_CODE[L].seq.forEach((name, q) => {
        if (!isFinite(g[q])) return;
        const min = TM.railWaitMin + g[q];
        let e = reach.get(name);
        if (!e) reach.set(name, e = { lines: [], transfers: t, min: Infinity, line: L });
        if (!e.lines.includes(L)) e.lines.push(L);
        if (min < e.min) { e.min = min; e.transfers = t; e.line = L; }
      });
  });
  return { reach, lineTransfers, companyStations };
}

/* Stops/stations from which a shuttle pickup point is at most `feederMin`
 * minutes' ride away.
 *
 * The pickup point is a PLACE, not a bus stop code. Pinning it to the single
 * nearest stop silently threw away every other way of arriving: "Aft Pasir Ris
 * St 53" snapped to Blk 582, which only routes 15/15A serve and only as their
 * 2nd stop -- so allowing a longer ride changed nothing, even though Pasir Ris
 * Interchange and 30 routes sit 273m away. Anything within a short walk of the
 * pickup point is therefore a valid place to get off.
 *
 * Riding a feeder to the shuttle is opt-in per network -- someone happy to walk
 * to the pickup point may not be willing to catch a bus at 07:00 to make it.
 * Each hit's `min` runs from boarding to standing at the pickup point. */
function computeShuttleReach(sh) {
  const busReach = new Map(), railReach = new Map(), A = access(), cap = state.feederMin;

  const alightStops = A.bus
    ? new Map(gridNear(STOP_GRID, sh.lat, sh.lon, TRANSFER_WALK).map(h => [h.key, h.dist])) : new Map();
  const alightStations = A.rail
    ? new Map(gridNear(RAIL_GRID, sh.lat, sh.lon, RAIL_WALK).map(h => [h.key, h.dist])) : new Map();

  if (alightStops.size) {
    ROUTES.forEach((r, i) => {
      const seq = r[2], wait = busWait(i);
      for (let idx = 0; idx < seq.length; idx++) {
        if (!alightStops.has(seq[idx])) continue;
        const walk = alightStops.get(seq[idx]);
        // bus route variants are directional, so only stops *before* the
        // alighting point on this variant can actually ride to it
        for (let n = 1; idx - n >= 0; n++) {
          const ride = busRide(i, idx - n, idx);
          if (ride > cap) break;
          pushBest(busReach, seq[idx - n],
            { route: i, nStops: n, at: seq[idx], walk, ride, min: wait + ride + walkT(walk) });
        }
      }
    });
  }

  for (const [name, walk] of alightStations) {
    // rail runs both ways on the same line entry, so either side counts
    for (const L of (RAIL_STATIONS[name] || [, , , , []])[4]) {
      const line = LINE_BY_CODE[L]; if (!line) continue;
      const p = line.pos.get(name); if (p === undefined) continue;
      for (const dir of [-1, 1])
        for (let q = p + dir; q >= 0 && q < line.seq.length; q += dir) {
          const ride = railRide(L, q, p);
          if (ride > cap) break;
          pushBest(railReach, line.seq[q],
            { line: L, nStops: Math.abs(q - p), at: name, walk, ride, min: TM.railWaitMin + ride + walkT(walk) });
        }
    }
  }
  return { busReach, railReach };
}

/* Ride a short first leg, change vehicle once, and the second vehicle goes to
 * work.
 *
 * "Finishers" are the places from which the trip completes with no further
 * change: any bus stop upstream of the workplace on a direct route, any station
 * on a serving line -- each with its own minutes to the door. A stop is a
 * transfer hub if a finisher is within TRANSFER_WALK of it, and its cost is
 * the cheapest walk-then-finish. That covers feeder-bus-to-MRT, MRT-to-a-
 * direct-bus, and bus-to-a-different-bus in one rule -- but only with a short
 * first leg (`feederMin`), because "one transfer, unlimited riding" is true of
 * nearly every address in Singapore and would mark the whole island.
 */
function computeTransferReach() {
  const reach = new Map();
  if (!modes().transfer) return reach;

  const finishers = [];
  for (const [c, byRoute] of calc.directStops)
    if (STOPS[c]) finishers.push({ key: c, lat: STOPS[c][0], lon: STOPS[c][1], cost: Math.min(...byRoute.values()), xfers: 0 });
  for (const [n, e] of calc.rail.reach)
    if (RAIL_STATIONS[n]) finishers.push({ key: n, lat: RAIL_STATIONS[n][0], lon: RAIL_STATIONS[n][1], cost: e.min, xfers: e.transfers });
  if (!finishers.length) return reach;
  const fgrid = buildGrid(finishers);

  // many routes share a stop, so each hub is priced once
  const hubs = new Map();
  const hub = (key, lat, lon, r) => {
    if (!hubs.has(key)) {
      const b = bestWithin(fgrid, lat, lon, r);
      hubs.set(key, b ? { min: b.t, xfers: b.e.xfers } : null);
    }
    return hubs.get(key);
  };
  const cap = state.feederMin;

  ROUTES.forEach((r, i) => {
    const seq = r[2], wait = busWait(i);
    for (let idx = 0; idx < seq.length; idx++) {
      const s = STOPS[seq[idx]];
      const h = s && hub(seq[idx], s[0], s[1], TRANSFER_WALK);
      if (!h) continue;
      // bus variants are directional: only earlier stops can ride to this hub
      for (let n = 1; idx - n >= 0; n++) {
        const ride = busRide(i, idx - n, idx);
        if (ride > cap) break;
        pushBest(reach, seq[idx - n],
          { kind: "bus", route: i, nStops: n, at: seq[idx], ride, min: wait + ride + h.min, xfers: 1 + h.xfers });
      }
    }
  });

  for (const line of Object.values(LINE_BY_CODE)) {
    line.seq.forEach((name, p) => {
      const s = RAIL_STATIONS[name];
      const h = s && hub(name, s[0], s[1], RAIL_WALK);
      if (!h) return;
      for (const dir of [-1, 1])
        for (let q = p + dir; q >= 0 && q < line.seq.length; q += dir) {
          const ride = railRide(line.code, q, p);
          if (ride > cap) break;
          pushBest(reach, line.seq[q],
            { kind: "rail", line: line.code, nStops: Math.abs(q - p), at: name, ride,
              min: TM.railWaitMin + ride + h.min, xfers: 1 + h.xfers });
        }
    });
  }
  return reach;
}

function recompute() {
  const M = modes();

  // 1. what counts as "arriving at work"
  const companyStops = gridNear(STOP_GRID, state.company.lat, state.company.lon, state.companyRadius)
    .map(h => ({ code: h.key, dist: h.dist }));
  const companySet = new Set(companyStops.map(x => x.code));
  const companyWalk = new Map(companyStops.map(x => [x.code, walkT(x.dist)]));

  // 2. bus route variants touching any of them = direct to the workplace.
  //    Computed unconditionally: this is a fact about the network, not a
  //    preference. The `bus` checkbox decides whether a direct bus *counts*
  //    toward the ⭐, but the transfer mode still needs to know which routes
  //    finish the journey -- gating this on M.bus silently killed 🔁 whenever
  //    someone unticked 🚌.
  const directRoutes = [];
  ROUTES.forEach((r, i) => { if (r[2].some(c => companySet.has(c))) directRoutes.push(i); });
  // Moving the workplace changes which routes are direct. A filter left pointing
  // at one that no longer is would draw a line nowhere near the new workplace and
  // hide every route that does serve it -- while the <select>, having no matching
  // <option> any more, renders blank rather than "（全部顯示）". Drop it here, before
  // render() and renderSidebar() read it.
  if (state.routeFilter !== "" && !directRoutes.includes(+state.routeFilter)) state.routeFilter = "";

  //    code -> Map(route -> minutes from boarding there to the door). Scanning
  //    each variant backwards keeps the cheapest "ride on to a stop near work,
  //    then walk" seen so far. Stops past the last such stop are left out: on
  //    this variant the bus is heading away (the other direction serves them).
  const directStops = new Map();
  const perKm = 60 / TM.busKmh;
  for (const i of directRoutes) {
    const seq = ROUTES[i][2], km = ROUTES[i][4], wait = busWait(i);
    const at = idx => (km ? km[idx] : idx * 0.4) * perKm;
    let finish = Infinity;   // min over later work stops j of (ride-to-j offset + walk)
    for (let idx = seq.length - 1; idx >= 0; idx--) {
      if (isFinite(finish)) {
        const min = wait + finish - at(idx);
        let byRoute = directStops.get(seq[idx]);
        if (!byRoute) directStops.set(seq[idx], byRoute = new Map());
        if (!(byRoute.get(i) <= min)) byRoute.set(i, min);
      }
      const w = companyWalk.get(seq[idx]);
      if (w !== undefined) finish = Math.min(finish, at(idx) + w);
    }
  }

  // 3. rail lines serving the workplace
  const rail = computeRailReach();

  // 4. per enabled shuttle point: what can ride to it
  const shuttleReach = M.shuttle
    ? state.shuttles.filter(sh => sh.enabled !== false).map(sh => ({ shuttle: sh, ...computeShuttleReach(sh) }))
    : [];

  // 5. grids of "places you can board for mode X", each with its minutes to the
  //    destination, so the candidate scan is a few cell lookups per anchor
  //    instead of a sweep of the whole network
  const busOk = buildGrid(!M.bus ? [] : [...directStops].filter(([c]) => STOPS[c])
    .map(([c, byRoute]) => ({ key: c, lat: STOPS[c][0], lon: STOPS[c][1], cost: Math.min(...byRoute.values()) })));
  const railOk = buildGrid(!M.rail ? [] : [...rail.reach].filter(([n]) => RAIL_STATIONS[n])
    .map(([n, e]) => ({ key: n, lat: RAIL_STATIONS[n][0], lon: RAIL_STATIONS[n][1], cost: e.min })));
  const shuttleOkPts = [];
  for (const sr of shuttleReach) {
    if (access().walk) shuttleOkPts.push({ key: "@" + sr.shuttle.name, lat: sr.shuttle.lat, lon: sr.shuttle.lon, cost: 0 });
    for (const [c, hits] of sr.busReach) if (STOPS[c]) shuttleOkPts.push({ key: c, lat: STOPS[c][0], lon: STOPS[c][1], cost: hits[0].min });
    for (const [n, hits] of sr.railReach) if (RAIL_STATIONS[n]) shuttleOkPts.push({ key: n, lat: RAIL_STATIONS[n][0], lon: RAIL_STATIONS[n][1], cost: hits[0].min });
  }
  const shuttleOk = buildGrid(shuttleOkPts);

  calc = { companyStops, companySet, directRoutes, directStops, rail, shuttleReach, busOk, railOk, shuttleOk };

  // transfers build on the direct results above, so this runs once `calc` exists
  calc.transferReach = computeTransferReach();
  calc.transferOk = buildGrid([...calc.transferReach]
    .map(([k, hits]) => STOPS[k] ? { key: k, lat: STOPS[k][0], lon: STOPS[k][1], cost: hits[0].min }
      : RAIL_STATIONS[k] ? { key: k, lat: RAIL_STATIONS[k][0], lon: RAIL_STATIONS[k][1], cost: hits[0].min } : null)
    .filter(Boolean));

  calc.stars = scanCandidates();
  // Evaluated here rather than inside renderProbe(), because the map layers need
  // the same answer to draw the focused view and re-deriving it per layer would
  // sweep the network three more times.
  calc.probeEval = state.probe ? evaluateLocation(state.probe.lat, state.probe.lon) : null;
}

/* When "只畫這個位置用得到的路線" is on and a place has been probed, every map
 * layer narrows to what that one place can actually use. Off (or with nothing
 * probed) this returns null and the layers draw the whole network as before. */
function focusEval() {
  return state.ui.probeFocus && state.probe && calc.probeEval ? calc.probeEval : null;
}

/* Estimated minutes per enabled mode if you live at (lat, lon); a mode is
 * missing when it does not work from there. 🚌/🚆/🔁 are door to door and must
 * fit under the ceiling; 🚐 is only as far as the pickup point (the shuttle's
 * own ride is the company's timetable, not ours) and is capped by the first-leg
 * limit alone. */
function modeTimes(lat, lon) {
  const M = modes(), r = state.walkRadius, cap = maxTotal(), out = {};
  const check = (m, grid, capped) => {
    if (!M[m]) return;
    const b = bestWithin(grid, lat, lon, r);
    if (b && (!capped || b.t <= cap)) out[m] = b.t;
  };
  check("bus", calc.busOk, true);
  check("rail", calc.railOk, true);
  check("transfer", calc.transferOk, true);
  check("shuttle", calc.shuttleOk, false);
  return out;
}
// fastest door-to-door time among the modes that have one (🚐 does not)
function bestDoorTime(times) {
  const ts = ["bus", "rail", "transfer"].filter(m => m in times).map(m => times[m]);
  return ts.length ? Math.min(...ts) : null;
}

/* Run that test at every transit node on the island; the survivors are the ⭐. */
function scanCandidates() {
  const need = starThreshold();
  if (!isFinite(need)) return [];
  const stars = [], ai = aiActive();
  const consider = (kind, id, lat, lon, label, road) => {
    let times = modeTimes(lat, lon), m = Object.keys(times), facts = null;
    if (m.length < need) return;
    // the AI's extra conditions can only remove modes, so the cheap test above
    // is a safe first cut before the per-place detail
    if (ai) {
      const r = aiCheck(lat, lon, road);
      if (!r || r.modes.length < need) return;
      ({ times, modes: m, facts } = r);
    }
    stars.push({ kind, id, lat, lon, label, road, modes: m, times, best: bestDoorTime(times), facts });
  };
  for (const code of STOP_CODES) {
    const s = STOPS[code];
    consider("bus", code, s[0], s[1], s[2], s[3]);
  }
  for (const name of RAIL_NAMES) {
    const s = RAIL_STATIONS[name];
    consider("rail", name, s[0], s[1], stn(name), stn(name));
  }
  return stars;
}

/* Full detail for one location -- powers the probe panel and the popups.
 * Uses the same costs as the ⭐ scan, so the two always agree. Ways over the
 * door-to-door ceiling are dropped but counted, so the panel can say "there is
 * a direct bus, it is just too slow" instead of implying there is none. */
function evaluateLocation(lat, lon) {
  const M = modes(), r = state.walkRadius, cap = maxTotal();
  const near = gridNear(STOP_GRID, lat, lon, r).map(h => ({ code: h.key, dist: h.dist }));
  const nearRail = gridNear(RAIL_GRID, lat, lon, r).map(h => ({ name: h.key, dist: h.dist }));
  const out = { near, nearRail, bus: new Map(), rail: [], transfer: [], shuttle: [], over: { bus: 0, rail: 0, transfer: 0 } };

  if (M.bus) {
    const all = new Map();   // route -> cheapest boarding stop within reach
    for (const n of near)
      for (const [i, cost] of (calc.directStops.get(n.code) || [])) {
        const min = walkT(n.dist) + cost;
        if (!all.has(i) || min < all.get(i).min) all.set(i, { ...n, min });
      }
    for (const [i, hit] of [...all].sort((a, b) => a[1].min - b[1].min))
      if (hit.min <= cap) out.bus.set(i, hit); else out.over.bus++;
  }

  if (M.rail)
    for (const st of nearRail) {
      const hit = calc.rail.reach.get(st.name);
      if (!hit) continue;
      const min = walkT(st.dist) + hit.min;
      if (min <= cap) out.rail.push({ station: st, lines: hit.lines, transfers: hit.transfers, line: hit.line, min });
      else out.over.rail++;
    }
  out.rail.sort((a, b) => a.min - b.min);

  if (M.transfer) {
    const seen = new Set();
    const take = (h, from, dist) => {
      const k = h.kind + h.route + h.line + h.at;
      if (seen.has(k)) return;
      seen.add(k);
      const min = walkT(dist) + h.min;
      if (min <= cap) out.transfer.push({ ...h, from, dist, min }); else out.over.transfer++;
    };
    for (const n of near)
      for (const h of (calc.transferReach.get(n.code) || [])) take(h, STOPS[n.code][2], n.dist);
    for (const st of nearRail)
      for (const h of (calc.transferReach.get(st.name) || [])) take(h, stn(st.name), st.dist);
    out.transfer.sort((a, b) => a.min - b.min);
  }

  if (M.shuttle)
    for (const sr of calc.shuttleReach) {
      const ways = [];
      const dWalk = haversine(lat, lon, sr.shuttle.lat, sr.shuttle.lon);
      if (access().walk && dWalk <= r) ways.push({ kind: "walk", dist: dWalk, min: walkT(dWalk) });
      for (const n of near)
        for (const h of (sr.busReach.get(n.code) || [])) ways.push({ kind: "bus", ...h, stop: n, min: walkT(n.dist) + h.min });
      for (const st of nearRail)
        for (const h of (sr.railReach.get(st.name) || [])) ways.push({ kind: "rail", ...h, station: st, min: walkT(st.dist) + h.min });
      if (ways.length) {
        ways.sort((a, b) => a.min - b.min);
        out.shuttle.push({ shuttle: sr.shuttle, ways, walkDist: dWalk, best: ways[0].min });
      }
    }

  out.satisfied = [];
  out.times = {};
  if (out.bus.size) { out.satisfied.push("bus"); out.times.bus = out.bus.values().next().value.min; }
  if (out.rail.length) { out.satisfied.push("rail"); out.times.rail = out.rail[0].min; }
  if (out.transfer.length) { out.satisfied.push("transfer"); out.times.transfer = out.transfer[0].min; }
  if (out.shuttle.length) { out.satisfied.push("shuttle"); out.times.shuttle = Math.min(...out.shuttle.map(s => s.best)); }
  return out;
}

/* ---------- map ---------- */
let layerRail, layerRoutes, layerReach, layerPriority, layerProbe;
let companyMarker, companyCircle, shuttleMarkers = [];

function startExplorer() {
  $("app").classList.add("on");
  state.shuttles.forEach(ensureShuttleAnchors);

  // the explorer can be re-entered after going back to the setup screen --
  // Leaflet refuses to re-init the same container, so only build it once
  if (!map) { initMap(); wireExplorer(); wireAi(); }

  buildShuttleMarkers();
  syncControls();
  refresh();
  // the container was display:none while the wizard showed; the ResizeObserver
  // set up in initMap() re-measures it once layout settles (a rAF callback would
  // never fire if the page is in a background tab)
  map.invalidateSize();
  map.setView([state.company.lat, state.company.lon], map.getZoom() || 12);
}

function syncControls() {
  $("companyR").value = state.companyRadius;
  $("walkR").value = state.walkRadius;
  $("feederMin").value = state.feederMin;
  $("maxTotal").value = Math.min(state.maxTotalMin, MAX_TOTAL_TOP);
  ALL_MODES.forEach(m => { $("mode" + m[0].toUpperCase() + m.slice(1)).checked = !!state.modes[m]; });
  $("modeRail").disabled = !RAIL_NAMES.length;
  $("accWalk").checked = !!access().walk;
  $("accBus").checked = !!access().bus;
  $("accRail").checked = !!access().rail;
  $("accRail").disabled = !RAIL_NAMES.length;
  $("railTransfers").value = state.modes.railTransfers || 0;
  $("starRule").value = state.modes.starRule;
  $("probeFocus").checked = !!state.ui.probeFocus;
}

function initMap() {
  // Canvas, not SVG: a loose ⭐ threshold marks thousands of stops, and one DOM
  // node per circle makes every pan and zoom crawl. Popups still work the same.
  map = L.map("map", { preferCanvas: true }).setView([state.company.lat, state.company.lon], 12);

  // Keeps Leaflet's cached viewport in sync whenever #map actually gets a size:
  // first layout, returning from the setup screen, window resizes. Without this
  // the map can latch a 0x0 box and render a single tile.
  if (window.ResizeObserver) {
    let last = "";
    new ResizeObserver(() => {
      const el = $("map"), key = el.clientWidth + "x" + el.clientHeight;
      if (el.clientWidth && el.clientHeight && key !== last) { last = key; map.invalidateSize(); }
    }).observe($("map"));
  }
  // OneMap (Singapore Land Authority): free, no key. CARTO's basemaps started
  // stamping "API KEY REQUIRED" across every tile (seen 2026-09-22). OneMap
  // only covers Singapore, so the layer is bounded to it instead of 404ing.
  L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png", {
    attribution: '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | ' +
      '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a> | ' +
      T("公車資料", "Bus data") + ' <a href="https://datamall.lta.gov.sg/" target="_blank" rel="noopener">LTA DataMall</a>',
    minZoom: 11, maxZoom: 19, bounds: [[1.144, 103.535], [1.494, 104.502]],
  }).addTo(map);

  layerRail = L.layerGroup().addTo(map);
  layerRoutes = L.layerGroup().addTo(map);
  layerReach = L.layerGroup().addTo(map);
  layerPriority = L.layerGroup().addTo(map);
  layerProbe = L.layerGroup().addTo(map);

  companyMarker = L.marker([state.company.lat, state.company.lon], { draggable: true }).addTo(map);
  companyCircle = L.circle([state.company.lat, state.company.lon],
    { radius: state.companyRadius, color: "#0f766e", weight: 1, fillOpacity: .05 }).addTo(map);
  companyMarker.on("dragend", e => {
    const p = e.target.getLatLng();
    moveCompany(p.lat, p.lng, null, p.lat.toFixed(5) + ", " + p.lng.toFixed(5), false);
  });

  map.on("click", e => {
    if (placingShuttle) { addShuttleAt(e.latlng.lat, e.latlng.lng); return; }
    state.probe = { lat: e.latlng.lat, lon: e.latlng.lng };
    refresh();
  });
}

const SNAP_M = 400;   // how far a pickup point may sit from the stop it "is"

/* A pickup point is useful if people can ride *either* network to it, so it
 * anchors to both the nearest bus stop and the nearest rail station. */
function shuttleAnchors(lat, lon) {
  return { bus: nearestStop(lat, lon, SNAP_M), rail: nearestStation(lat, lon, SNAP_M) };
}
function describeAnchors(bus, rail) {
  const bits = [];
  if (bus.code) bits.push(STOPS[bus.code][2] + " (" + Math.round(bus.dist) + "m)");
  if (rail.name) bits.push(stn(rail.name) + " (" + Math.round(rail.dist) + "m)");
  return bits.length ? bits.join(" ／ ") : null;
}

/* Used when the user drags or drops a pickup point: re-anchor AND move the pin
 * onto the bus stop it snapped to. */
function snapShuttle(sh, lat, lon) {
  const { bus, rail } = shuttleAnchors(lat, lon);
  sh.code = bus.code; sh.railStation = rail.name;
  sh.lat = lat; sh.lon = lon;
  if (bus.code) { sh.lat = STOPS[bus.code][0]; sh.lon = STOPS[bus.code][1]; }
  sh.snapped = describeAnchors(bus, rail);
  // the user placed this one deliberately, so it no longer needs verifying
  sh.matchMethod = "manual"; sh.matchConfident = true;
}

/* Used on load: fill in whichever anchors a saved (or server-seeded) point is
 * missing, without moving it. Setups written before rail existed carry a bus
 * stop code and no station, which would silently disable "ride the MRT to the
 * shuttle" for every one of them. */
function ensureShuttleAnchors(sh) {
  // A refreshed LTA download can retire a stop code, and setup.json is a plain
  // file people do edit by hand. Drop anchors the current network has never
  // heard of instead of carrying them into the sidebar as real ones.
  if (sh.code && !STOPS[sh.code]) sh.code = null;
  if (sh.railStation && !RAIL_STATIONS[sh.railStation]) sh.railStation = null;
  const { bus, rail } = shuttleAnchors(sh.lat, sh.lon);
  if (!sh.code) sh.code = bus.code;
  if (sh.railStation === undefined || sh.railStation === null) sh.railStation = rail.name;
  if (!sh.snapped) sh.snapped = describeAnchors(bus, rail);
}

function buildShuttleMarkers() {
  shuttleMarkers.forEach(m => map.removeLayer(m));
  shuttleMarkers = [];
  if (!modes().shuttle) return;
  shuttleMarkers = state.shuttles.map((sh, si) => {
    const off = sh.enabled === false;
    const icon = L.divIcon({
      className: "", iconSize: [22, 22], iconAnchor: [11, 11],
      html: '<div style="width:22px;height:22px;border-radius:50%;background:' + (off ? "#d1d5db" : sh.color) +
        ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);color:#fff;font-size:11px;' +
        'display:flex;align-items:center;justify-content:center;font-weight:700;opacity:' + (off ? ".55" : "1") + '">' + (si + 1) + '</div>'
    });
    const m = L.marker([sh.lat, sh.lon], { icon, draggable: true }).addTo(map);
    m.bindTooltip(sh.name + T("（" + sh.time + " 發車" + (off ? "，已停用" : "") + "，可拖曳）",
      " (departs " + sh.time + (off ? ", switched off" : "") + ", drag to move)"));
    m.on("dragend", e => {
      const p = e.target.getLatLng();
      snapShuttle(sh, p.lat, p.lng);
      // snapShuttle moves the point onto the stop it matched; leaving the pin at
      // the drop position would show one place while computing another
      e.target.setLatLng([sh.lat, sh.lon]);
      toast(sh.snapped ? T("已吸附到 ", "Snapped to ") + sh.snapped
        : T("附近 " + SNAP_M + "m 無站牌或捷運站", "No stop or station within " + SNAP_M + "m"));
      refresh();
    });
    return m;
  });
}

function addShuttleAt(lat, lon) {
  placingShuttle = false;
  $("btnAddShuttle").textContent = addShuttleText();
  const sh = {
    name: T("新廠車點 ", "Pickup ") + (state.shuttles.length + 1), time: "08:00", enabled: true,
    color: PALETTE[state.shuttles.length % PALETTE.length], lat, lon, code: null
  };
  snapShuttle(sh, lat, lon);
  state.shuttles.push(sh);
  buildShuttleMarkers();
  refresh();
  toast(sh.snapped ? T("已新增並吸附到 ", "Added and snapped to ") + sh.snapped
    : T("已新增（附近 400m 無站牌或捷運站）", "Added (no stop or station within 400m)"));
}
const addShuttleText = () => placingShuttle
  ? T("▸ 請在地圖上點一個位置（再按可取消）", "▸ Click a spot on the map (press again to cancel)")
  : T("＋ 新增廠車點（點地圖放置）", "＋ Add a pickup point (click the map)");

/* ---------- rendering ---------- */
function render() {
  layerRail.clearLayers(); layerRoutes.clearLayers(); layerReach.clearLayers();
  layerPriority.clearLayers(); layerProbe.clearLayers();

  companyMarker.setLatLng([state.company.lat, state.company.lon]);
  companyMarker.bindTooltip(T("上班地點：", "Workplace: ") + companyLabel() + T("（可拖曳）", " (drag to move)"));
  companyCircle.setLatLng([state.company.lat, state.company.lon]).setRadius(state.companyRadius);
  shuttleMarkers.forEach((m, i) => {
    const sh = state.shuttles[i];
    if (sh) m.setLatLng([sh.lat, sh.lon]);
  });

  renderRail();
  renderBusRoutes();
  renderShuttleReach();
  renderStars();
  renderProbeLayer();
}

function renderRail() {
  if (!RAIL_NAMES.length) return;
  const M = modes();
  const f = focusEval();
  const focusLines = f ? new Set(f.rail.flatMap(r => r.lines)) : null;
  const focusStations = f ? new Set(f.rail.map(r => r.station.name)) : null;
  for (const { code, color, seq } of Object.values(LINE_BY_CODE)) {
    const direct = M.rail && calc.rail.lineTransfers.has(code) && (!focusLines || focusLines.has(code));
    const pts = seq.filter(n => RAIL_STATIONS[n]).map(n => [RAIL_STATIONS[n][0], RAIL_STATIONS[n][1]]);
    if (pts.length > 1)
      L.polyline(pts, { color, weight: direct ? 5 : 1.5, opacity: direct ? .75 : .18 }).addTo(layerRail);
  }
  for (const name of RAIL_NAMES) {
    const s = RAIL_STATIONS[name];
    let hit = M.rail ? calc.rail.reach.get(name) : null;
    // in focus mode a station only counts if it is one you could walk to
    if (hit && focusStations && !focusStations.has(name)) hit = null;
    const c = hit ? lineColor(hit.lines[0]) : "#9ca3af";
    L.circleMarker([s[0], s[1]], {
      radius: hit ? 5 : 3, color: "#fff", weight: hit ? 2 : 1,
      fillColor: c, fillOpacity: hit ? 1 : .45
    }).bindPopup("<b>" + esc(stn(name)) + "</b><br>" + esc(s[3].join(" / ")) + "<br>" +
      esc(s[4].map(lineLabel).join(T("、", ", "))) +
      (hit ? "<br><br><b>" + T("可直達公司", "Goes to work") + "</b>: " + esc(hit.lines.map(lineLabel).join(T("、", ", "))) +
        (hit.transfers ? T("（轉乘 " + hit.transfers + " 次）", " (" + hit.transfers + " change" + (hit.transfers > 1 ? "s" : "") + ")")
          : T("（不用轉乘）", " (no change)")) +
        "<br>" + T("從這站" + fmtMin(hit.min) + "到公司（含等車）", "From here: " + fmtMin(hit.min) + " to work (incl. waiting)") : ""))
      .addTo(layerRail);
  }
}

function renderBusRoutes() {
  if (!modes().bus) return;
  const f = focusEval();
  let shown = state.routeFilter === "" ? calc.directRoutes : [parseInt(state.routeFilter, 10)];
  if (f) shown = shown.filter(i => f.bus.has(i));
  for (const i of shown) {
    if (!ROUTES[i]) continue;
    const color = routeColor(i);
    const pts = ROUTES[i][2].filter(c => STOPS[c]).map(c => [STOPS[c][0], STOPS[c][1]]);
    if (pts.length > 1) L.polyline(pts, { color, weight: 2, opacity: .5 }).addTo(layerRoutes);
    for (const c of ROUTES[i][2]) {
      const s = STOPS[c]; if (!s) continue;
      L.circleMarker([s[0], s[1]], { radius: 3, color, fillColor: color, fillOpacity: .85, weight: 1 })
        .bindPopup("<b>" + esc(s[2]) + "</b> (" + c + ")<br>" + esc(s[3]) + "<br>" + T("直達路線：", "Direct route: ") + esc(routeLabel(i)) +
          (calc.directStops.get(c) && calc.directStops.get(c).has(i)
            ? "<br>" + T("從這站" + fmtMin(calc.directStops.get(c).get(i)) + "到公司（含等車）",
              "From here: " + fmtMin(calc.directStops.get(c).get(i)) + " to work (incl. waiting)")
            : "<br>" + T("這一站在公司之後，這個方向到不了", "This stop is past work; this direction does not get there")))
        .addTo(layerRoutes);
    }
  }
}

function renderShuttleReach() {
  const f = focusEval();
  // {shuttle name -> set of stop codes / station names reachable from the probe}
  const usable = f ? new Map(f.shuttle.map(s => [s.shuttle.name, new Set(
    s.ways.map(w => (w.stop && w.stop.code) || (w.station && w.station.name)).filter(Boolean))])) : null;

  for (const sr of calc.shuttleReach) {
    const only = usable ? usable.get(sr.shuttle.name) : null;
    if (usable && !only) continue;   // this pickup point is out of reach from here
    for (const [code, hits] of sr.busReach) {
      if (only && !only.has(code)) continue;
      const s = STOPS[code]; if (!s) continue;
      const via = hits.map(h => esc(routeLabel(h.route)) + T(" 搭" + h.nStops + "站 → ", ", " + h.nStops + " stops → ") +
        esc(STOPS[h.at] ? STOPS[h.at][2] : h.at) + T(" 下車（", " (") + fmtMin(h.min) + T("）", ")")).join("<br>");
      L.circleMarker([s[0], s[1]],
        { radius: 6, color: sr.shuttle.color, fillColor: sr.shuttle.color, fillOpacity: .3, weight: 2 })
        .bindPopup("<b>" + esc(s[2]) + "</b> (" + code + ")<br>" + T("可到廠車點：", "Reaches pickup: ") +
          esc(sr.shuttle.name) + "<br>" + via).addTo(layerReach);
    }
    for (const [name, hits] of sr.railReach) {
      if (only && !only.has(name)) continue;
      const s = RAIL_STATIONS[name]; if (!s) continue;
      const via = hits.map(h => esc(lineLabel(h.line)) + T(" 搭" + h.nStops + "站 → ", ", " + h.nStops + " stops → ") +
        esc(stn(h.at)) + T(" 下車（", " (") + fmtMin(h.min) + T("）", ")")).join("<br>");
      L.circleMarker([s[0], s[1]],
        { radius: 8, color: sr.shuttle.color, fillColor: sr.shuttle.color, fillOpacity: .18, weight: 2, dashArray: "3 3" })
        .bindPopup("<b>" + esc(stn(name)) + "</b><br>" + T("可到廠車點：", "Reaches pickup: ") +
          esc(sr.shuttle.name) + "<br>" + via).addTo(layerReach);
    }
  }
}

/* Star markers are DOM nodes, which get slow in the thousands -- a loose
 * starRule can easily produce that many, so switch to canvas-ish circles. */
function renderStars() {
  // ⭐ answers "where should I look?", which is the question *before* this one.
  // Once a place is picked and focused on, thousands of red stars are exactly
  // the clutter the focus mode exists to remove.
  if (focusEval()) return;
  const heavy = calc.stars.length > 400;
  for (const st of calc.stars) {
    const detail = "<b>⭐ " + esc(st.label) + "</b>" + (st.kind === "bus" ? " (" + st.id + ")" : "") +
      "<br>" + esc(st.road) + "<br><br>" + T("符合：", "Works by:") + "<br>" +
      st.modes.map(m => esc(MODE_ICON[m] + modeLabel(m)) + " " + fmtMin(st.times[m]) +
        (m === "shuttle" ? T("到上車點", " to the pickup") : "")).join("<br>");
    const mk = heavy
      ? L.circleMarker([st.lat, st.lon], { radius: 5, color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: .9 })
      : L.marker([st.lat, st.lon], {
        icon: L.divIcon({ className: "", html: '<div class="star-icon">★</div>', iconSize: [20, 20], iconAnchor: [10, 10] })
      });
    mk.bindPopup(detail).addTo(layerPriority);
  }
}

function renderProbeLayer() {
  if (!state.probe) return;
  const home = [state.probe.lat, state.probe.lon];
  L.circle(home,
    { radius: state.walkRadius, color: "#111", weight: 1, dashArray: "4 4", fillOpacity: .04 }).addTo(layerProbe);

  // In focus mode the map is down to the handful of routes this place can use,
  // which makes the remaining question "and which stop do I walk to?" worth
  // answering on the map rather than only in the sidebar.
  const f = focusEval();
  if (f) {
    const legs = new Map();   // dedupe: one stop often serves several routes
    const addLeg = (lat, lon, label) => { if (!legs.has(label)) legs.set(label, [lat, lon, label]); };
    for (const n of f.bus.values())
      if (STOPS[n.code]) addLeg(STOPS[n.code][0], STOPS[n.code][1], STOPS[n.code][2]);
    for (const r of f.rail)
      if (RAIL_STATIONS[r.station.name])
        addLeg(RAIL_STATIONS[r.station.name][0], RAIL_STATIONS[r.station.name][1], stn(r.station.name));
    for (const sh of f.shuttle)
      for (const w of sh.ways) {
        if (w.kind === "walk") addLeg(sh.shuttle.lat, sh.shuttle.lon, sh.shuttle.name);
        else if (w.stop && STOPS[w.stop.code]) addLeg(STOPS[w.stop.code][0], STOPS[w.stop.code][1], STOPS[w.stop.code][2]);
        else if (w.station && RAIL_STATIONS[w.station.name])
          addLeg(RAIL_STATIONS[w.station.name][0], RAIL_STATIONS[w.station.name][1], stn(w.station.name));
      }
    for (const [lat, lon, label] of legs.values())
      L.polyline([home, [lat, lon]], { color: "#111", weight: 1.5, opacity: .45, dashArray: "2 5" })
        .bindTooltip(T("走到 ", "Walk to ") + label + " (" + Math.round(haversine(home[0], home[1], lat, lon)) + "m)")
        .addTo(layerProbe);
  }

  L.marker(home).bindTooltip(T("試算住家位置", "Trial home")).addTo(layerProbe);
}

/* ---------- sidebar ---------- */
function renderSidebar() {
  const M = modes(), c = state.company;
  $("companyNameLine").textContent = companyLabel();
  // the name field follows automatic names, but never while someone is typing in it
  if (document.activeElement !== $("companyName")) $("companyName").value = c.autoName ? companyLabel() : (c.name || "");
  $("companyAddrLine").textContent = c.address || "";
  $("companyAddrLine").hidden = !!c.isDefault;
  $("companyNudge").hidden = !c.isDefault;
  // once a spot has been tried, the "click the map" hint has done its job
  $("mapHint").hidden = !!state.probe;
  $("vCompanyR").textContent = state.companyRadius + " m";
  $("vWalkR").textContent = state.walkRadius + T(" m（約 " + walkMin(state.walkRadius) + " 分鐘）",
    " m (~" + walkMin(state.walkRadius) + " min)");
  $("vFeederMin").textContent = state.feederMin + T(" 分鐘", " min");
  $("vMaxTotal").textContent = isFinite(maxTotal()) ? state.maxTotalMin + T(" 分鐘", " min") : T("不限", "no limit");
  $("vTransfers").textContent = (M.railTransfers || 0) === 0 ? T("0 次（同一條線）", "0 (same line)") : String(M.railTransfers);
  // a closed section says what is inside it, so there is a reason to open it
  $("moreMeta").textContent = T("接駁 " + state.feederMin + " 分 · 步行 " + state.walkRadius + " m",
    "first leg " + state.feederMin + " min · walk " + state.walkRadius + " m");
  $("railOpts").style.display = M.rail ? "" : "none";
  $("transferOpts").style.display = M.transfer ? "" : "none";
  $("shuttleOpts").style.display = M.shuttle ? "" : "none";
  $("shuttleSection").style.display = M.shuttle ? "" : "none";
  const n = state.shuttles.length, active = state.shuttles.filter(sh => sh.enabled !== false).length;
  // ticking 🚐 with no pickup points yet: open the section, the add button is in it
  $("shuttleSection").open = !!state.ui.shuttleOpen || (M.shuttle && !n);
  $("companySection").open = !!state.ui.companyOpen;
  $("moreOpts").open = !!state.ui.moreOpen;
  $("diagSection").open = !!state.ui.diagOpen;
  $("shuttleCount").textContent = !n ? T("還沒有", "none yet")
    : active === n ? T(n + " 個", String(n)) : T(active + " / " + n + " 個啟用", active + " of " + n + " on");
  $("shuttleEmptyHint").hidden = !(M.shuttle && !active);
  $("btnAddShuttle").textContent = addShuttleText();

  const en = enabledModes(), need = starThreshold();
  $("starRuleHint").textContent = !en.length ? T("沒有勾任何方式，不會有候選。", "No mode is ticked, so nothing can qualify.")
    : T("勾了 " + en.length + " 種，要符合 " + need + " 種", en.length + " ticked, " + need + " must work") +
      (M.starRule === "two" && en.length === 1 ? T("（只勾一種，自動降為 1）", " (only one ticked, so 1)") : "");

  $("sCompanyStops").textContent = calc.companyStops.length;
  $("sCompanyRail").textContent = M.rail ? calc.rail.companyStations.length : "－";
  $("sDirect").textContent = M.bus ? calc.directRoutes.length : "－";
  $("sRailLines").textContent = M.rail ? calc.rail.lineTransfers.size : "－";
  $("sTransfer").textContent = M.transfer ? calc.transferReach.size : "－";
  $("sPrio").textContent = calc.stars.length;

  const sel = $("routeFilter"), keep = state.routeFilter;
  sel.innerHTML = '<option value="">' + T("（全部顯示）", "(show all)") + '</option>' +
    calc.directRoutes.map(i => '<option value="' + i + '">' + esc(routeLabel(i)) + '</option>').join("");
  sel.value = keep;
  sel.disabled = !M.bus;

  if (M.shuttle) renderShuttleList();
  renderAiPanel();
  renderProbe();
  renderPriorityList();
}

function renderShuttleList() {
  const reachOf = name => calc.shuttleReach.find(sr => sr.shuttle.name === name);
  $("shuttleList").innerHTML = state.shuttles.map((sh, i) => {
    const sr = reachOf(sh.name);
    const off = sh.enabled === false;
    const verify = sh.matchConfident === false
      ? '<br><span class="warn">' + T("⚠ 這是用座標猜的，請確認是不是這一站（不對就把圖示拖到正確站牌）",
        "⚠ Guessed from coordinates. Check it is the right stop (if not, drag the pin onto it)") + '</span>' : "";
    let status;
    if (sh.code || sh.railStation) {
      const bits = [];
      if (sh.code) bits.push(T("公車站 ", "Bus stop ") + sh.code +
        (STOPS[sh.code] ? " (" + esc(STOPS[sh.code][2]) + ")" : T("（不在目前的路網資料中）", " (not in the current network data)")));
      if (sh.railStation) bits.push(T("捷運 ", "MRT ") + esc(stn(sh.railStation)));
      status = bits.join("<br>") + (sh.matchMethod ? '<span class="meta"> · ' + esc(sh.matchMethod) + '</span>' : "") + verify;
    } else {
      status = '<span class="warn">' + T("未對到任何站牌／捷運站，無法算哪裡搭得到",
        "Not matched to any stop or station, so its reach cannot be worked out") + '</span>';
    }
    const A = access();
    const reachTxt = off ? '<span class="warn">' + T("已停用，不列入計算", "Switched off, not counted") + '</span>'
      : !sr ? ""
      : (!A.bus && !A.rail && !A.walk) ? '<span class="warn">' + T("三種接駁方式都關掉了，這個點等於沒作用",
        "All three ways to get here are off, so this point does nothing") + '</span>'
      : (A.bus ? '<b>' + sr.busReach.size + '</b>' + T(" 個公車站牌", " bus stops") : '') +
        (A.bus && A.rail ? T("、", ", ") : '') +
        (A.rail ? '<b>' + sr.railReach.size + '</b>' + T(" 個捷運站", " MRT stations") : '') +
        (A.bus || A.rail ? T("搭車 " + state.feederMin + " 分鐘內可到", " within a " + state.feederMin + "-min ride") : '') +
        (A.walk ? (A.bus || A.rail ? T("；", "; ") : '') + T("走路 " + state.walkRadius + "m 內也算",
          "walking up to " + state.walkRadius + "m counts too") : '');
    return '<div class="card' + (off ? ' off' : '') + '"><h3>' +
      '<input type="checkbox" data-on="' + i + '"' + (off ? '' : ' checked') + ' title="' + T("計入／不計入", "Count / don't count") + '">' +
      '<span class="dot" style="background:' + (off ? "#d1d5db" : sh.color) + '"></span>' +
      '<input type="text" data-sh="' + i + '" data-f="name" value="' + esc(sh.name) + '" style="font-weight:600">' +
      '</h3><div class="row" style="margin-bottom:6px">' +
      '<input type="time" data-sh="' + i + '" data-f="time" value="' + esc(sh.time) + '" style="width:110px">' +
      '<button class="tiny" data-zoom="' + i + '">' + T("定位", "Show") + '</button>' +
      '<button class="tiny" data-del="' + i + '">' + T("刪除", "Delete") + '</button></div>' +
      '<div class="meta">' + status + (sh.snapped ? '<br>' + T("已吸附到：", "Snapped to: ") + esc(sh.snapped) : '') +
      '<br>' + reachTxt + '</div></div>';
  }).join("");

  $("shuttleList").querySelectorAll("input[data-sh]").forEach(inp => {
    inp.addEventListener("change", e => {
      const sh = state.shuttles[+e.target.dataset.sh];
      sh[e.target.dataset.f] = e.target.value;
      buildShuttleMarkers(); refresh();
    });
  });
  $("shuttleList").querySelectorAll("input[data-on]").forEach(inp => {
    inp.addEventListener("change", e => {
      state.shuttles[+e.target.dataset.on].enabled = e.target.checked;
      buildShuttleMarkers(); refresh();
    });
  });
  $("shuttleList").querySelectorAll("button[data-del]").forEach(b => {
    b.addEventListener("click", e => {
      state.shuttles.splice(+e.target.dataset.del, 1);
      buildShuttleMarkers(); refresh(); toast(T("已刪除廠車點", "Pickup point deleted"));
    });
  });
  $("shuttleList").querySelectorAll("button[data-zoom]").forEach(b => {
    b.addEventListener("click", e => {
      const sh = state.shuttles[+e.target.dataset.zoom];
      map.setView([sh.lat, sh.lon], 16);
    });
  });
}

function renderProbe() {
  const el = $("probe"), hint = $("probeFocusHint");
  if (!state.probe) {
    el.innerHTML = '<p class="empty">' + T("在地圖上點一個位置試算。", "Click a spot on the map to try it.") + '</p>';
    hint.textContent = state.ui.probeFocus ? T("先在地圖上點一個位置，才知道要留下哪些路線。",
      "Click a spot on the map first, so there is something to focus on.") : "";
    return;
  }

  const M = modes(), ev = calc.probeEval || evaluateLocation(state.probe.lat, state.probe.lon);
  const need = starThreshold();
  // in AI mode the verdict must match the ⭐ list, which applies the AI's conditions
  const aiR = aiActive() ? aiCheck(state.probe.lat, state.probe.lon, ev.near.length ? STOPS[ev.near[0].code][3] : "") : undefined;
  const sat = aiR === undefined ? ev.satisfied : aiR ? aiR.modes : [];
  const isStar = sat.length >= need;
  const distCompany = haversine(state.probe.lat, state.probe.lon, state.company.lat, state.company.lon);
  const best = bestDoorTime(ev.times);
  const capTxt = isFinite(maxTotal()) ? state.maxTotalMin + T(" 分鐘", " min") : "";
  const none = () => '<div class="empty">' + T("沒有" + (capTxt ? "（" + capTxt + "內）" : ""),
    "None" + (capTxt ? " within " + capTxt : "")) + '</div>';
  // "there is a direct bus, just a slow one" is a different finding from "none"
  const overNote = n => n ? '<div class="meta">' + T("另有 " + n + " 種走法超過單程 " + capTxt + "，沒有列出",
    n + " more way" + (n > 1 ? "s" : "") + " over the " + capTxt + " limit, not listed") + '</div>' : "";
  const xferTxt = n => n ? T("轉 " + n + " 次", n + " change" + (n > 1 ? "s" : "")) : T("不用轉車", "no change");
  const sep = T("、", ", ");

  const verdict = !enabledModes().length ? T("⚠ 沒有勾選任何通勤方式", "⚠ No commute mode is ticked")
    : isStar ? T("⭐ 優先候選：", "⭐ Worth a look: ") + sat.map(m => MODE_ICON[m] + modeLabel(m)).join(" ＋ ")
    : sat.length ? T("🙂 只符合 " + sat.map(modeLabel).join(sep) + "（門檻 " + need + " 種）",
      "🙂 Only " + sat.map(modeLabel).join(sep) + " (needs " + need + ")")
    : aiR === null ? T("❌ 不符合 AI 條件（地區、捷運距離或直達公車條數）",
      "❌ Fails the AI conditions (area, MRT distance or number of direct buses)")
    : T("❌ 這裡不符合任何勾選的方式", "❌ None of the ticked modes works from here");

  hint.textContent = !state.ui.probeFocus
    ? (M.bus ? T("地圖上目前畫著全部 " + calc.directRoutes.length + " 條直達路線。",
      "The map shows all " + calc.directRoutes.length + " direct routes.") : T("地圖上目前畫著全部路網。", "The map shows the whole network."))
    : T("地圖只留下這裡用得到的：", "The map now shows only what this place can use: ") +
      [M.bus ? T(ev.bus.size + " 條公車", ev.bus.size + " buses") : "",
       M.rail ? T(ev.rail.length + " 個捷運站", ev.rail.length + " MRT stations") : "",
       M.shuttle ? T(ev.shuttle.length + " 個廠車點", ev.shuttle.length + " pickups") : ""].filter(Boolean).join(sep) +
      T("，虛線是要走過去的站牌；⭐ 候選暫時隱藏。", ". Dotted lines lead to the stops you would walk to; ⭐ are hidden meanwhile.");

  let html = '<div class="card' + (isStar ? ' prio' : '') + '"><h3>' + esc(verdict) + '</h3>' +
    (best !== null ? '<div class="big">' + T("門到門最快", "Door to door, fastest ") + fmtMin(best) + '</div>' : '') +
    '<div class="meta">' + T("距公司直線 " + (distCompany / 1000).toFixed(1) + " km · 走 " + state.walkRadius + "m 內有 " +
      ev.near.length + " 個站牌、" + ev.nearRail.length + " 個捷運站",
      (distCompany / 1000).toFixed(1) + " km from work as the crow flies · within " + state.walkRadius + "m: " +
      ev.near.length + " bus stops, " + ev.nearRail.length + " MRT stations") + '</div>' +
    '<div class="row" style="margin-top:6px"><button class="tiny" id="btnClearProbe">' + T("清除試算點", "Clear this spot") + '</button></div></div>';

  if (M.bus) {
    const row = ([i, n]) => '<div class="way"><span class="pill">' + esc(routeLabel(i)) + '</span>' +
      '<span class="meta"><b>' + fmtMin(n.min) + '</b> · ' + esc(STOPS[n.code][2]) + T(" 走 ", ", walk ") + Math.round(n.dist) + 'm' +
      (ROUTES[i][5] ? ' · ' + T(Math.round(ROUTES[i][5]) + " 分一班", "every " + Math.round(ROUTES[i][5]) + " min") : '') + '</span></div>';
    const all = [...ev.bus.entries()];
    html += '<div class="card"><h3>' + T("🚌 直達公車 " + all.length + " 條", "🚌 Direct buses: " + all.length) + '</h3>' +
      (all.length ? all.slice(0, 3).map(row).join("") +
        (all.length > 3 ? '<details class="more"><summary>' + T("顯示其餘 " + (all.length - 3) + " 條",
          "Show " + (all.length - 3) + " more") + '</summary>' + all.slice(3).map(row).join("") + '</details>' : "")
        : none()) +
      overNote(ev.over.bus) + '</div>';
  }

  if (M.rail) {
    html += '<div class="card"><h3>' + T("🚆 直達捷運 " + ev.rail.length + " 站", "🚆 Direct MRT: " + ev.rail.length + " stations") + '</h3>';
    if (ev.rail.length) {
      html += ev.rail.map(r => '<div style="margin-bottom:4px"><b>' + esc(stn(r.station.name)) + '</b> ' +
        '<span class="meta"><b>' + fmtMin(r.min) + '</b> · ' + T("走 ", "walk ") + Math.round(r.station.dist) + 'm · ' +
        xferTxt(r.transfers) + '</span> ' +
        r.lines.map(ln => '<span class="pill rail" style="background:' + lineColor(ln) + '22;color:' +
          lineColor(ln) + '">' + esc(lineLabel(ln)) + '</span>').join("") + '</div>').join("");
    } else html += none();
    html += overNote(ev.over.rail) + '</div>';
  }

  if (M.transfer) {
    html += '<div class="card"><h3>' + T("🔁 轉乘一次 " + ev.transfer.length + " 種走法", "🔁 One transfer: " + ev.transfer.length + " ways") + '</h3>';
    if (ev.transfer.length) {
      html += ev.transfer.slice(0, 6).map(t => '<div style="margin-bottom:4px">' +
        '<span class="pill">' + esc(t.kind === "bus" ? routeLabel(t.route) : lineLabel(t.line)) +
        T(" 搭 " + t.nStops + " 站", ", " + t.nStops + " stops") + '</span>' +
        '<span class="meta"><b>' + fmtMin(t.min) + '</b> · ' + xferTxt(t.xfers) + ' · ' + esc(t.from) +
        T(" 走 ", ", walk ") + Math.round(t.dist) + 'm → ' +
        esc(t.kind === "bus" ? (STOPS[t.at] ? STOPS[t.at][2] : t.at) : stn(t.at)) + T(" 換車", ": change here") + '</span></div>').join("") +
        (ev.transfer.length > 6 ? '<div class="meta">' + T("…另有 " + (ev.transfer.length - 6) + " 種", "…and " + (ev.transfer.length - 6) + " more") + '</div>' : "");
    } else html += '<div class="empty">' + T("沒有（接駁 " + state.feederMin + " 分內）", "None (first leg within " + state.feederMin + " min)") + '</div>';
    html += overNote(ev.over.transfer) + '</div>';
  }

  if (M.shuttle) {
    html += '<div class="card"><h3>' + T("🚐 廠車點 " + ev.shuttle.length + " 個", "🚐 Shuttle pickups: " + ev.shuttle.length) + '</h3>';
    if (ev.shuttle.length) {
      // One row per kind of feeder, each the fastest of its kind. Showing only
      // the overall winner hid the bus completely whenever a train also worked,
      // and someone who would rather not change onto the MRT at 07:00 wants to
      // see the bus option too.
      const bestOf = (ways, kind) => ways.find(w => w.kind === kind) || null;   // ways are sorted by min
      for (const s of ev.shuttle) {
        const leave = hhmmMinus(s.shuttle.time, s.best);
        html += '<div style="margin-bottom:8px"><b>' + esc(s.shuttle.name) + '</b> ' +
          '<span class="meta">' + T(esc(s.shuttle.time) + " 發車", "departs " + esc(s.shuttle.time)) +
          (leave ? ' · <b>' + T(leave + " 前出門", "leave by " + leave) + '</b>' : '') + '</span>';

        const walk = bestOf(s.ways, "walk");
        if (walk)
          html += '<div class="way"><span class="pill shuttle">' + T("🚶 走路 ", "🚶 Walk ") + Math.round(walk.dist) +
            'm</span><span class="meta"><b>' + fmtMin(walk.min) + '</b></span></div>';

        for (const [kind, icon] of [["bus", "🚌"], ["rail", "🚆"]]) {
          const b = bestOf(s.ways, kind); if (!b) continue;
          const on = kind === "bus" ? STOPS[b.stop.code][2] : stn(b.station.name);
          const onDist = Math.round(kind === "bus" ? b.stop.dist : b.station.dist);
          const off = kind === "bus" ? (STOPS[b.at] ? STOPS[b.at][2] : b.at) : stn(b.at);
          html += '<div class="way"><span class="pill shuttle">' + icon + ' ' +
            esc(kind === "bus" ? routeLabel(b.route) : lineLabel(b.line)) + T(" 搭 " + b.nStops + " 站", ", " + b.nStops + " stops") + '</span>' +
            '<span class="meta"><b>' + fmtMin(b.min) + '</b> · ' +
            T(esc(on) + " 上車（走 " + onDist + "m）→ " + esc(off) + " 下車", "board at " + esc(on) + " (walk " + onDist + "m) → alight at " + esc(off)) +
            (b.walk > 40 ? T("（再走 " + Math.round(b.walk) + "m）", " (then walk " + Math.round(b.walk) + "m)") : '') + '</span></div>';
        }
        html += '</div>';
      }
    } else html += '<div class="empty">' + T("沒有（接駁 " + state.feederMin + " 分內）", "None (first leg within " + state.feederMin + " min)") + '</div>';
    html += '</div>';
  }
  html += '<details class="more"><summary>' + T("ⓘ 時間怎麼算的", "ⓘ How the minutes are worked out") + '</summary>' +
    T("🚐 的時間只算到上車點，廠車本身開多久看公司班表。其餘：走路（直線 ×" + TM.walkDetour + "）＋ 等車（尖峰班距的一半）＋ 車程（公車 " +
      TM.busKmh + " km/h、捷運 " + TM.railKmh + " km/h）＋ 捷運轉線 " + TM.railInterchangeMin + " 分。都是估計值，要精確到分鐘請用 Google Maps 對照。",
      "🚐 counts only to the pickup point; how long the shuttle itself takes is up to its timetable. Everything else: walking (straight line ×" +
      TM.walkDetour + ") + waiting (half the peak headway) + riding (bus " + TM.busKmh + " km/h, MRT " + TM.railKmh +
      " km/h) + " + TM.railInterchangeMin + " min per MRT line change. All estimates; check the exact minutes in Google Maps.") + '</details>';
  el.innerHTML = html;
  const clear = $("btnClearProbe");
  if (clear) clear.addEventListener("click", () => { state.probe = null; refresh(); });
}

/* Group label: "<town> ｜ <road>", collapsed to just the road when the town
 * keyword table has no entry for it (townOf falls back to the road itself). */
function groupKey(road) {
  const town = townOf(road);
  return town === road ? road : town + T(" ｜ ", " | ") + road;
}

function priorityGroups() {
  const groups = new Map();
  for (const st of calc.stars) {
    const key = groupKey(st.road);
    if (!groups.has(key)) groups.set(key, { key, stops: [], stations: [], modes: new Set(), lat: st.lat, lon: st.lon, best: null });
    const g = groups.get(key);
    if (st.best !== null && (g.best === null || st.best < g.best)) { g.best = st.best; g.facts = st.facts; }
    if (!g.facts) g.facts = st.facts;
    (st.kind === "rail" ? g.stations : g.stops).push(st.label + (st.kind === "bus" ? " (" + st.id + ")" : ""));
    st.modes.forEach(m => g.modes.add(m));
  }
  return groups;
}

// more ways to get to work first, then the fastest
const groupOrder = (a, b) => (b.modes.size - a.modes.size) || ((a.best ?? Infinity) - (b.best ?? Infinity));

function renderPriorityList() {
  const groups = priorityGroups(), el = $("prioList");
  $("prioCount").textContent = groups.size ? T(groups.size + " 區 / " + calc.stars.length + " 個站點",
    groups.size + " areas / " + calc.stars.length + " stops") : "";
  if (!groups.size) {
    el.innerHTML = '<p class="empty">' + T("目前設定下沒有符合門檻的區域。放寬「⭐ 門檻」、加大步行半徑，或多勾一種通勤方式。",
      "Nothing qualifies with these settings. Loosen the ⭐ rule, widen the walking radius, or tick another mode.") + '</p>';
    return;
  }
  const sorted = [...groups.values()].sort(groupOrder);
  el.innerHTML = sorted.slice(0, 120).map(g =>
    '<div class="card prio"><h3>' + esc(g.key) + '</h3><div class="meta">' +
    (g.best !== null ? '<b>' + T("最快" + fmtMin(g.best) + "到公司", "Fastest: " + fmtMin(g.best) + " to work") + '</b><br>' : '') +
    [...g.modes].map(m => MODE_ICON[m] + modeLabel(m)).join(T("、", ", ")) +
    (g.stations.length ? '<br>' + T("捷運：", "MRT: ") + esc(g.stations.join(T("、", ", "))) : '') +
    (g.stops.length ? '<br>' + T("站牌：", "Stops: ") + esc(g.stops.slice(0, 3).join(T("、", ", "))) +
      (g.stops.length > 3 ? T(" …等 " + g.stops.length + " 個", " … " + g.stops.length + " in all") : "") : '') +
    '</div></div>').join("") +
    (sorted.length > 120 ? '<p class="empty">' + T("還有 " + (sorted.length - 120) + " 個區域未列出（匯出 CSV 可看全部）。",
      (sorted.length - 120) + " more areas not listed (Export CSV has them all).") + '</p>' : "");
}

/* ---------- AI mode ----------
 * Turns one sentence into the same filters the manual controls set. It is a
 * classifier, not a planner: the model never sees the network and never picks
 * places (sending the network would be ~120k tokens per question and still
 * unreliable at exact lookups).
 *
 * Measured 2026-09-22 with the local qwen3.5:9b: asked to fill in every field
 * itself it got 50/55 answers right, and the misses were all of two kinds --
 * numbers ("一個半小時" read as 30) and conditions nobody asked for (a
 * "no transfers" the sentence never mentioned). So the work is split:
 *   - aiNumbers() reads minutes, walking time and clock times with plain rules;
 *   - the model answers a few multiple-choice questions (aiSchema);
 *   - aiParse() keeps a model answer only if the sentence actually talks about
 *     that topic, and adds place names and "no data" topics it finds itself.
 * Base settings then go onto the same state the sliders drive, so the map,
 * list and CSV follow with no second code path; the rest is re-checked per
 * place in aiCheck(). */
const AI_KEY_STORE = "sgCommuteGeminiKey";
let AI_MODELS = [], AI_HAS_SERVER_KEY = false, AI_LOCAL = false;

function aiActive() { return state.ui.mode === "ai" && !!(state.ai && state.ai.spec); }
function aiLocalKey() { try { return localStorage.getItem(AI_KEY_STORE) || ""; } catch (e) { return ""; } }
function aiReady() { return OFFLINE ? !!aiLocalKey() : (AI_LOCAL || AI_HAS_SERVER_KEY); }
function aiTowns() { return [...new Set(Object.values(TOWNS))].sort(); }

/* One place under the AI's extra conditions: null if it fails a place-level
 * test, otherwise the modes that still count, their minutes, and the facts the
 * list and the comparison prompt show. -1 / "" / [] in the spec mean "not asked". */
function aiCheck(lat, lon, road) {
  const f = state.ai.spec, town = townOf(road);
  if (f.includeTowns.length && !f.includeTowns.includes(town)) return null;
  if (f.excludeTowns.includes(town)) return null;
  const mrt = nearestStation(lat, lon, 3000);
  if (f.maxMrtWalk > 0 && !(mrt.dist <= f.maxMrtWalk)) return null;

  const ev = evaluateLocation(lat, lon);
  const nx = f.maxTransfers >= 0 ? f.maxTransfers : Infinity;
  let buses = [...ev.bus];                       // fastest first
  if (f.maxHeadway > 0) buses = buses.filter(([i]) => ROUTES[i][5] && ROUTES[i][5] <= f.maxHeadway);
  if (f.minDirectBuses > 0 && buses.length < f.minDirectBuses) return null;

  const times = {};
  if (buses.length) times.bus = buses[0][1].min;
  const rail = ev.rail.filter(r => r.transfers <= nx);
  if (rail.length) times.rail = rail[0].min;
  const tr = ev.transfer.filter(t => t.xfers <= nx);
  if (tr.length) times.transfer = tr[0].min;
  let leave = null;
  for (const s of ev.shuttle)
    for (const w of s.ways) {
      if ((w.kind === "walk" ? 0 : 1) > nx) continue;   // a feeder then the shuttle is one change
      const by = hhmmMinus(s.shuttle.time, w.min);
      if (f.leaveNotBefore && by && by < f.leaveNotBefore) continue;
      if (times.shuttle === undefined || w.min < times.shuttle) { times.shuttle = w.min; leave = by; }
    }
  const heads = buses.map(([i]) => ROUTES[i][5]).filter(Boolean);
  return {
    modes: ALL_MODES.filter(m => m in times), times,
    facts: { town, directBuses: buses.length, bestHeadway: heads.length ? Math.min(...heads) : null,
      mrt: mrt.name ? mrt.name + " " + Math.round(mrt.dist) + "m" : null, leave },
  };
}

/* ---- the rule-read part ---- */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  if (s in CN_DIGIT) return CN_DIGIT[s];
  const m = /^([一二兩两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  return m ? (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0) : NaN;
}
const NUM = "(\\d+(?:\\.\\d+)?|[一二兩两三四五六七八九十]{1,3})";

/* Durations and clock times, which are exactly what the small model misreads.
 * A duration right after 走/步行 (or next to "walk") is walking; the others are
 * the commute. Chinese and English phrasings are both read. */
function aiNumbers(text) {
  let t = text.replace(/：/g, ":");
  let leave = "";
  // "leave after 7:30", "not before 7am" -- blanked like the Chinese ones below
  t = t.replace(/\b(not before|no earlier than|after)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:am|a\.m\.)?/gi, (all, w, h, mm) => {
    if (/leav|depart|head out|out of the house|set off/i.test(text) && +h >= 4 && +h <= 11)
      leave = String(+h).padStart(2, "0") + ":" + String(mm ? +mm : 0).padStart(2, "0");
    return " ".repeat(all.length);
  });
  // "7 點以後出門", "不想早於 7:30 出門" -- only earliest-departure phrasing is a filter we have
  const clock = new RegExp("(不早於|不要早於|不想早於|晚於)?\\s*" + NUM + "\\s*(?:點|:)\\s*(半|\\d{1,2})?\\s*(?:分)?\\s*(以後|之後|後)?", "g");
  t = t.replace(clock, (all, before, h, mm, after) => {
    const hour = cnNum(h), min = mm === "半" ? 30 : mm ? +mm : 0;
    if ((before || after) && /出門|出發|離家/.test(text) && hour >= 4 && hour <= 11)
      leave = String(hour).padStart(2, "0") + ":" + String(min).padStart(2, "0");
    return " ".repeat(all.length);   // keep positions, and keep "30 分" out of the durations
  });
  const found = [];
  const push = (idx, minutes, len = 0) => found.push({ minutes, walking: /走|步行/.test(t.slice(Math.max(0, idx - 6), idx)) ||
    /\bwalk\w*\b[^,.;]*$/i.test(t.slice(Math.max(0, idx - 20), idx)) || /^['’]?s?\s*(?:of\s+)?walk/i.test(t.slice(idx + len)) });
  // English: "an hour and a half", "half an hour", "1.5 hours", "45 min(utes)" --
  // in that order, so "an hour" is not read out of the longer phrases
  t = t.replace(/\bhalf\s+an\s+hour\b/gi, (all, idx) => { push(idx, 30, all.length); return " ".repeat(all.length); });
  t = t.replace(/\b(an|one|\d+(?:\.\d+)?)\s*hours?\s+and\s+a\s+half\b/gi,
    (all, n, idx) => { push(idx, (/\d/.test(n) ? +n : 1) * 60 + 30, all.length); return " ".repeat(all.length); });
  t = t.replace(/\b(an|one|two|\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi, (all, n, idx) => {
    push(idx, ({ an: 1, one: 1, two: 2 }[n.toLowerCase()] || +n) * 60, all.length);
    return " ".repeat(all.length);
  });
  t = t.replace(/\b(\d+)\s*-?\s*(?:minutes?|mins?)\b/gi, (all, n, idx) => { push(idx, +n, all.length); return " ".repeat(all.length); });
  t.replace(new RegExp(NUM + "\\s*(?:個)?\\s*(半)?\\s*(?:小時|鐘頭)", "g"),
    (all, n, half, idx) => { push(idx, cnNum(n) * 60 + (half ? 30 : 0)); return all; });
  t.replace(/(^|[^一二兩两三四五六七八九十\d個])半\s*(?:小時|鐘頭)/g,
    (all, pre, idx) => { push(idx + pre.length, 30); return all; });
  t.replace(new RegExp(NUM + "\\s*分(?:鐘)?", "g"), (all, n, idx) => { push(idx, cnNum(n)); return all; });
  const commute = found.filter(x => !x.walking && x.minutes > 0).map(x => x.minutes);
  const walk = found.filter(x => x.walking && x.minutes > 0).map(x => x.minutes);
  return { commute: commute.length ? Math.max(...commute) : null, walk: walk.length ? Math.min(...walk) : null, leave };
}

// Chinese names people actually type for the towns in config.py's TOWN_KEYWORDS
const TOWN_ALIASES = {
  "Ang Mo Kio": ["宏茂橋", "AMK"], "Bedok": ["勿洛"], "Bishan": ["碧山"], "Bukit Batok": ["武吉巴督"],
  "Bukit Merah": ["紅山", "红山"], "Bukit Panjang": ["武吉班讓", "武吉班让"], "Changi": ["樟宜"],
  "Choa Chu Kang": ["蔡厝港"], "Clementi": ["金文泰"], "Geylang": ["芽籠", "芽笼"], "Hougang": ["後港", "后港"],
  "Jurong East": ["裕廊東", "裕廊东"], "Jurong West": ["裕廊西"], "Kallang": ["加冷"], "Marine Parade": ["馬林百列", "马林百列"],
  "Novena": ["諾維娜", "诺维娜"], "Pasir Ris": ["巴西立"], "Punggol": ["榜鵝", "榜鹅"], "Queenstown": ["女皇鎮", "女皇镇"],
  "Sembawang": ["三巴旺"], "Sengkang": ["盛港"], "Serangoon": ["實龍崗", "实龙岗"], "Tampines": ["淡濱尼", "淡滨尼"],
  "Tengah": ["登加"], "Toa Payoh": ["大巴窯", "大巴窑"], "Woodlands": ["兀蘭", "兀兰"], "Yishun": ["義順", "义顺"],
};
function townsMentioned(text) {
  const low = text.toLowerCase(), out = [];
  for (const town of aiTowns()) {
    const names = [town, ...(TOWN_ALIASES[town] || [])];
    let at = -1;
    for (const n of names) { const i = low.indexOf(n.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at >= 0) out.push({ town, at });
  }
  return out;
}

const AI_MODE_WORDS = { 公車直達: "bus", 捷運直達: "rail", 轉乘一次: "transfer", 廠車: "shuttle" };
// the model may only choose a mode the sentence actually asks for: "住捷運站附近"
// is about the flat, not a request to count only the MRT
const AI_MODE_EVIDENCE = {
  bus: /(搭|坐|直達|有).{0,4}(公車|巴士)|(公車|巴士).{0,4}(直達|上班|到公司)|(take|ride|by|direct|catch)\W+(a\W+)?bus|bus\W.{0,12}(direct|to work|to the office)/i,
  rail: /(搭|坐|直達).{0,4}(捷運|地鐵|MRT|輕軌)|(捷運|地鐵|MRT).{0,4}(直達|上班|到公司)|(take|ride|by|direct)\W+(the\W+)?(MRT|train|metro|subway|LRT)|(MRT|train)\W.{0,12}(direct|to work)/i,
  transfer: /(可以|能|接受|願意|允許).{0,3}(轉乘|轉車|換車)|轉一次|(ok|okay|fine|happy|willing|don'?t mind|can)\W.{0,12}(transfer|chang)|one transfer/i,
  shuttle: /廠車|交通車|接駁車|shuttle|company bus/i,
};
// topics people ask about that there is no data for; the key is what the
// Chinese chip says, NOTOPIC_EN what the English one says
const AI_NOTOPIC = {
  租金: /租|預算|便宜|貴|價錢|價格|多少錢|\$|元|塊|\brent|budget|cheap|afford|price/i, 學校: /學校|小學|中學|幼稚園|學區|school/i,
  熟食中心: /熟食|小販|hawker|food court|kopitiam/i, 超市: /超市|購物|商場|mall|supermarket|grocer|shopping/i,
  安靜: /安靜|吵|噪音|quiet|nois/i, 治安: /治安|安全|\bsafe|crime/i, 屋齡: /屋齡|新屋|舊屋|老房|new flat|old flat|flat age|building age/i,
  房型: /房型|單房|套房|幾房|[一二三四五]房|整層|分租|\broom\b|studio|bedroom|whole unit/i,
};
const NOTOPIC_EN = { 租金: "rent", 學校: "schools", 熟食中心: "hawker centres", 超市: "supermarkets", 安靜: "quiet",
  治安: "safety", 屋齡: "flat age", 房型: "room type", 其他: "other" };

function aiSchema() {
  const towns = aiTowns(), NO = "不限";
  const props = {
    modes: { type: "array", items: { type: "string", enum: Object.keys(AI_MODE_WORDS) } },
    starRule: { type: "string", enum: [NO, "任一種", "至少兩種", "全部"] },
    transfer: { type: "string", enum: [NO, "不轉車"] },
    frequent: { type: "string", enum: [NO, "班次要多"] },
    nearMrt: { type: "string", enum: [NO, "靠近捷運"] },
    includeTowns: { type: "array", items: { type: "string", enum: towns } },
    excludeTowns: { type: "array", items: { type: "string", enum: towns } },
    unsupported: { type: "array", items: { type: "string", enum: [...Object.keys(AI_NOTOPIC), "其他"] } },
  };
  return { type: "object", properties: props, required: Object.keys(props) };
}

function aiSystemPrompt() {
  return [
    "把使用者的租屋需求對應到每一題的選項。這是選擇題：只能選清單裡的值。",
    "句子沒提到的題目選「不限」，陣列題給 []。寧可選不限，也不要猜。",
    "modes：使用者指定要搭的通勤方式。只說「住捷運站附近」不算指定捷運直達。",
    "starRule：「隨便」「都可以」「到得了就好」＝任一種。",
    "transfer：「不用轉車」「直達」「不想換車」＝不轉車。",
    "frequent：提到班次多、不想等車＝班次要多。",
    "nearMrt：想住在捷運站附近＝靠近捷運。",
    "includeTowns / excludeTowns：句子提到的地區，想住的放 include，不要的放 exclude。",
    "unsupported：提到但上面沒有的條件；預算、月租都算 租金。",
    "時間、分鐘數、幾點出門不用管，程式會自己讀。",
    "句子可能是英文，一樣對應到上面這些中文選項。",
  ].join("\n");
}

/* Model output is untrusted input: every answer needs evidence in the sentence,
 * and whatever the rules can read directly overrides it. */
function aiParse(raw, text, base) {
  const R = raw || {}, has = re => re.test(text);
  const words = Array.isArray(R.modes) ? R.modes : [];
  const okWithTransfer = /(可以|能|接受|願意|允許|沒差).{0,3}(轉|換)|(ok|okay|fine|happy|willing|don'?t mind|can)\W.{0,12}(transfer|chang)/i.test(text);
  const hasShuttle = state.shuttles.some(sh => sh.enabled !== false);
  let ms = words.map(w => AI_MODE_WORDS[w]).filter(m => m && AI_MODE_EVIDENCE[m].test(text));
  if (!RAIL_NAMES.length) ms = ms.filter(m => m !== "rail");
  if (!hasShuttle) ms = ms.filter(m => m !== "shuttle");
  // "可以接受轉乘" widens what counts; it is not a request to count transfers only
  if (okWithTransfer) ms.push("transfer");
  ms = [...new Set(ms)];
  if (ms.length === 1 && ms[0] === "transfer") ms = [...new Set([...base.modes, "transfer"])];
  if (!ms.length) ms = [...base.modes];

  // explicit wording decides on its own; a model answer needs the topic in the
  // sentence. "直達" alone is not enough: "兩條公車直達" says nothing about rail.
  const noTransfer = !okWithTransfer &&
    (/不用?轉車|不轉車|不想?換車|不要換車|不轉乘|不要轉|只要直達|要直達|no transfers?|without (a )?(transfer|chang)|no chang|direct only|only direct|don'?t want to (transfer|change)|not? to transfer/i.test(text) ||
      (R.transfer === "不轉車" && /轉|換|transfer|chang/i.test(text)));
  if (noTransfer) ms = ms.filter(m => m !== "transfer");
  if (!ms.length) ms = base.modes.filter(m => m !== "transfer");

  const starWords = /隨便|都可以|都行|到得了|任一|至少兩|兩種|都要|全部|每一種|\bany (one|of them|mode|way)\b|\beither\b|whatever|at least two|\bboth\b|all of them|every mode/i;
  const anyWords = /隨便|到得了|有到就好|怎樣都|哪一種都|\bany (one|of them|mode|way)\b|\beither\b|whatever|as long as/i;
  const star = anyWords.test(text) ? "any" : { 任一種: "any", 至少兩種: "two", 全部: "all" }[R.starRule];

  const num = aiNumbers(text);
  const frequent = /班次.{0,2}(多|密)|車要多|不想?等|等太久|frequent|don'?t (want to )?wait|short wait|not wait long/i.test(text) ||
    (R.frequent === "班次要多" && /班|等|頻|密|wait|frequen|often/i.test(text));
  const five = v => Math.round(v / 5) * 5;
  const mrtTalk = has(/捷運|地鐵|MRT|車站|\bstation|\btrain/i);
  const nearMrt = has(/(捷運|地鐵|MRT).{0,4}(附近|旁邊|近)|(靠近|接近|離).{0,3}(捷運|地鐵|MRT)|(near|close to|next to|by|walk\w* (distance )?(of|to|from))\W+(an?\W+|the\W+)?(MRT|station|train)/i) ||
    // "by MRT" is about the ride, not where the flat is: the model's "near the
    // MRT" also needs a word about distance in the sentence
    (R.nearMrt === "靠近捷運" && mrtTalk && /附近|旁|近|離|步行|走|near|close|walk|next to/i.test(text));
  const walkM = num.walk ? Math.round(num.walk * TM.walkMPerMin / TM.walkDetour / 50) * 50 : -1;
  const busCount = /(兩|2|二)\s*條|(三|3)\s*條/.exec(text) ||
    /\b(two|2)\s+(or more\s+)?(direct\s+)?bus|\b(three|3)\s+(or more\s+)?(direct\s+)?bus/i.exec(text);

  const mentioned = townsMentioned(text);
  const pick = arr => (Array.isArray(arr) ? arr : []).filter(x => mentioned.some(m => m.town === x));
  let inc = pick(R.includeTowns), exc = pick(R.excludeTowns);
  // a town the model skipped: "不要/除了 X" before it means exclude, otherwise include
  for (const { town, at } of mentioned)
    if (!inc.includes(town) && !exc.includes(town))
      (/不要|不想|除了|排除|避開|不住|以外/.test(text.slice(Math.max(0, at - 8), at)) ||
        /\b(not|no|avoid|except|excluding|exclude|anywhere but)\b[^,.;]*$/i.test(text.slice(Math.max(0, at - 24), at)) ||
        /以外/.test(text.slice(at, at + town.length + 6)) ? exc : inc).push(town);
  inc = inc.filter(x => !exc.includes(x));

  const unsupported = new Set((R.unsupported || []).filter(k => k in AI_NOTOPIC && AI_NOTOPIC[k].test(text)));
  for (const [k, re] of Object.entries(AI_NOTOPIC)) if (re.test(text)) unsupported.add(k);

  return {
    modes: ms,
    starRule: star && starWords.test(text) ? star : base.starRule,
    maxMinutes: num.commute ? Math.min(MAX_TOTAL_TOP, Math.max(10, five(num.commute))) : -1,
    maxTransfers: noTransfer ? 0 : -1,
    minDirectBuses: busCount && has(/公車|巴士|bus/i) ? (busCount[1] ? 2 : 3) : -1,
    maxHeadway: frequent ? 10 : -1,
    maxMrtWalk: mrtTalk && walkM > 0 ? walkM : nearMrt ? 500 : -1,
    walkRadius: !mrtTalk && walkM > 0 ? Math.min(1200, Math.max(100, walkM)) : -1,
    includeTowns: inc, excludeTowns: exc,
    leaveNotBefore: hasShuttle ? num.leave : "",
    unsupported: [...unsupported],
  };
}

/* ---- talking to a model ---- */
async function aiGenerate(system, user, schema, temperature) {
  if (!OFFLINE) {
    const { data } = await api("/api/ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, user, schema, temperature })
    });
    if (!data || !data.ok) throw new Error((data && data.message) || T("AI 沒有回應", "The AI did not answer"));
    return { text: data.text, via: data.via };
  }
  // The single-file build has no server: it calls Gemini itself with the
  // reader's own key, trying the lite models in order.
  const key = aiLocalKey();
  if (!key) throw new Error(T("請先貼上你的 Gemini API key", "Paste your Gemini API key first"));
  const body = { system_instruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: user }] }],
    generationConfig: { temperature } };
  if (schema) Object.assign(body.generationConfig, { response_mime_type: "application/json", response_schema: schema });
  let last = "";
  for (const model of AI_MODELS) {
    let r;
    // an overloaded model can hang for 40 s+; move on after 15
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body), signal: ctl.signal
      });
    } catch (e) { last = model + (e.name === "AbortError" ? T(" 太久沒回應", " timed out") : T(" 連線失敗", " connection failed")); continue; }
    finally { clearTimeout(timer); }
    if (r.ok) {
      const j = await r.json();
      try { return { text: j.candidates[0].content.parts[0].text, via: model }; } catch (e) { last = model + T(" 回傳格式看不懂", " sent an unreadable reply"); continue; }
    }
    const txt = await r.text();
    if (/API key not valid|API_KEY_INVALID/.test(txt)) throw new Error(T("這把 Gemini key 不能用，請重新貼一次", "That Gemini key does not work; paste it again"));
    last = model + (r.status === 429 ? T(" 額度用盡", " out of quota") : " HTTP " + r.status);
  }
  throw new Error(T("AI 暫時不能用（" + last + "）。先用手動模式。", "AI is unavailable right now (" + last + "). Use Manual for now."));
}

/* `base` is the manual setting from before the first question, so knocking a
 * chip out returns that slider to where the user had it, not to whatever the
 * previous AI answer set. */
function applyAiSpec() {
  const f = state.ai.spec, b = state.ai.base;
  ALL_MODES.forEach(m => { state.modes[m] = f.modes.includes(m); });
  state.modes.starRule = f.starRule;
  state.maxTotalMin = f.maxMinutes > 0 ? f.maxMinutes : b.maxTotalMin;
  state.walkRadius = f.walkRadius > 0 ? f.walkRadius : b.walkRadius;
  state.modes.railTransfers = f.maxTransfers >= 0 ? Math.min(2, f.maxTransfers) : b.railTransfers;
  syncControls(); buildShuttleMarkers(); refresh();
}

async function aiAsk() {
  const text = $("aiInput").value.trim();
  if (!text) return;
  $("btnAsk").disabled = true;
  $("aiMsg").textContent = OFFLINE ? T("AI 判讀中…", "Reading your sentence…")
    : T("AI 判讀中…（本機模型第一次要載入，約 20 秒）", "Reading your sentence… (the local model takes ~20 s to load the first time)");
  const base = (state.ai && state.ai.base) || {
    maxTotalMin: state.maxTotalMin, walkRadius: state.walkRadius, railTransfers: state.modes.railTransfers || 0,
    modes: ALL_MODES.filter(m => state.modes[m]), starRule: state.modes.starRule };
  const t0 = performance.now();
  try {
    const out = await aiGenerate(aiSystemPrompt(), text, aiSchema(), 0);
    let raw = {};
    try { raw = JSON.parse(out.text); } catch (e) { /* rules still read the sentence */ }
    state.ai = { text, spec: aiParse(raw, text, base), summary: "", base,
      via: out.via + T("，", ", ") + Math.round((performance.now() - t0) / 1000) + T(" 秒", " s") };
    $("aiMsg").textContent = "";
    applyAiSpec();
  } catch (e) {
    $("aiMsg").innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  } finally { $("btnAsk").disabled = false; }
}

async function aiCompare() {
  const top = [...priorityGroups().values()].sort(groupOrder).slice(0, 5);
  if (!top.length) return;
  $("btnAiCompare").disabled = true; $("aiSummary").textContent = T("AI 比較中…", "Comparing…");
  const en = LANG === "en";
  const rows = top.map(g => en ? {
    area: g.key, fastestMin: g.best === null ? null : Math.round(g.best),
    modes: [...g.modes].map(modeLabel), ...(g.facts ? {
      directBuses: g.facts.directBuses, bestHeadwayMin: g.facts.bestHeadway,
      nearestMrt: g.facts.mrt, latestLeaveForShuttle: g.facts.leave } : {}),
  } : {
    區域: g.key, 最快分鐘: g.best === null ? null : Math.round(g.best),
    方式: [...g.modes].map(modeLabel), ...(g.facts ? {
      直達公車條數: g.facts.directBuses, 最密班距分鐘: g.facts.bestHeadway,
      最近捷運: g.facts.mrt, 廠車最晚出門: g.facts.leave } : {}),
  });
  try {
    const out = await aiGenerate(en
      ? "You are a commute adviser. Using only the numbers below, compare the trade-offs between these areas in 3 to 5 plain English sentences; " +
        "the last sentence says which area you would look at first and why. Do not mention anything the data does not have " +
        "(rent, amenities, schools). No bullet points, no Markdown."
      : "你是通勤顧問。只根據下面給的數字，用 3 到 5 句繁體中文比較這幾個區域的取捨，最後一句說你會先去看哪一區、為什麼。" +
        "不要提資料裡沒有的東西（租金、生活機能、學校）。不要用條列，不要用 Markdown。",
      (en ? "What the user asked for: " : "使用者的需求：") + state.ai.text + (en ? "\n\nCandidate areas:\n" : "\n\n候選區域：\n") +
        JSON.stringify(rows, null, 1), null, 0.3);
    state.ai.summary = out.text.trim();
  } catch (e) {
    state.ai.summary = "";
    $("aiSummary").innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    $("btnAiCompare").disabled = false;
    return;
  }
  $("btnAiCompare").disabled = false;
  renderAiPanel();
}

/* What was understood, as chips the user can knock out one at a time -- the
 * point is that nothing about the filter is hidden. */
function aiChips(f) {
  const chips = [];
  const add = (k, label) => chips.push({ k, label });
  const rule = { any: T("任一種", "any one"), two: T("至少兩種", "at least two"), all: T("全部", "all") }[f.starRule];
  add("modes", f.modes.map(m => MODE_ICON[m] + modeLabel(m)).join("／") + (f.modes.length > 1 ? T("（" + rule + "）", " (" + rule + ")") : ""));
  if (f.maxMinutes > 0) add("maxMinutes", T("單程 ≤ " + f.maxMinutes + " 分", "one way ≤ " + f.maxMinutes + " min"));
  if (f.maxTransfers >= 0) add("maxTransfers", f.maxTransfers === 0 ? T("不轉車", "no transfers")
    : T("最多轉 " + f.maxTransfers + " 次", "≤ " + f.maxTransfers + " changes"));
  if (f.minDirectBuses > 0) add("minDirectBuses", T("直達公車 ≥ " + f.minDirectBuses + " 條", "direct buses ≥ " + f.minDirectBuses));
  if (f.maxHeadway > 0) add("maxHeadway", T("班距 ≤ " + f.maxHeadway + " 分", "bus every ≤ " + f.maxHeadway + " min"));
  if (f.maxMrtWalk > 0) add("maxMrtWalk", T("離捷運 ≤ " + f.maxMrtWalk + " m", "MRT within " + f.maxMrtWalk + " m"));
  if (f.walkRadius > 0) add("walkRadius", T("走到站 ≤ " + f.walkRadius + " m", "walk to stop ≤ " + f.walkRadius + " m"));
  if (f.includeTowns.length) add("includeTowns", T("只看 ", "only ") + f.includeTowns.join(T("、", ", ")));
  if (f.excludeTowns.length) add("excludeTowns", T("排除 ", "not ") + f.excludeTowns.join(T("、", ", ")));
  if (f.leaveNotBefore) add("leaveNotBefore", T("廠車 " + f.leaveNotBefore + " 後出門", "leave for shuttle after " + f.leaveNotBefore));
  return chips;
}
const AI_UNSET = { maxMinutes: -1, maxTransfers: -1, minDirectBuses: -1, maxHeadway: -1, maxMrtWalk: -1,
  walkRadius: -1, includeTowns: [], excludeTowns: [], leaveNotBefore: "" };

function renderAiPanel() {
  const manual = state.ui.mode !== "ai";
  $("tabManual").classList.toggle("on", manual);
  $("tabAi").classList.toggle("on", !manual);
  $("manualPanel").hidden = !manual;
  $("aiPanel").hidden = manual;
  if (manual) return;
  $("aiKeyBox").hidden = aiReady();
  $("aiAskBox").hidden = !aiReady();
  const f = state.ai && state.ai.spec;
  $("aiResult").hidden = !f;
  if (!f) return;
  $("aiUnderstood").textContent = T("理解成這些條件", "Understood as") + (state.ai.via ? " (" + state.ai.via + ")" : "") + T("：", ":");
  $("aiChips").innerHTML = aiChips(f).map(c => '<span class="chip">' + esc(c.label) +
    (c.k in AI_UNSET ? '<button data-unset="' + c.k + '" title="' + T("拿掉這個條件", "Remove this condition") +
      '" aria-label="' + T("拿掉 ", "Remove ") + esc(c.label) + '">✕</button>' : '') +
    '</span>').join("");
  $("aiChips").querySelectorAll("button[data-unset]").forEach(b => b.addEventListener("click", e => {
    const k = e.currentTarget.dataset.unset;
    state.ai.spec[k] = AI_UNSET[k];
    state.ai.summary = "";
    applyAiSpec();
  }));
  $("aiUnsupported").innerHTML = f.unsupported.length
    ? T("⚠ 這些沒有資料，沒有篩：", "⚠ No data for these, so not filtered: ") +
      esc(f.unsupported.map(k => T(k, NOTOPIC_EN[k] || k)).join(T("、", ", "))) : "";
  $("aiCount").textContent = calc.stars.length
    ? T("找到 " + priorityGroups().size + " 個區域（" + calc.stars.length + " 個站點）",
      priorityGroups().size + " areas found (" + calc.stars.length + " stops)")
    : T("沒有符合的地方，拿掉一兩個條件試試。", "Nothing matches. Try removing a condition or two.");
  $("btnAiCompare").hidden = !calc.stars.length;
  $("aiSummary").textContent = state.ai.summary || "";
}

function wireAi() {
  const setMode = m => {
    state.ui.mode = m;
    if (m === "manual" && state.ai) toast(T("AI 設定的方式、時間上限已帶到拉桿上；其他 AI 條件不再套用",
      "The AI's modes and time limit are now on the sliders; its other conditions no longer apply"));
    refresh();
  };
  $("tabManual").addEventListener("click", () => setMode("manual"));
  $("tabAi").addEventListener("click", () => setMode("ai"));
  $("btnAsk").addEventListener("click", aiAsk);
  $("aiInput").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) aiAsk(); });
  $("btnAiCompare").addEventListener("click", aiCompare);
  $("btnAiKey").addEventListener("click", async () => {
    const key = $("aiKeyInput").value.trim();
    if (!key) return;
    if (OFFLINE) {
      // stays in this browser only; the file itself never carries a key
      try { localStorage.setItem(AI_KEY_STORE, key); } catch (e) { $("aiKeyMsg").textContent = T("這個瀏覽器不允許儲存（無痕模式？）", "This browser will not store it (private mode?)"); return; }
      $("aiKeyInput").value = ""; renderAiPanel(); return;
    }
    $("aiKeyMsg").textContent = T("驗證中…", "Checking…");
    const { data } = await api("/api/ai-key", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key })
    });
    if (data && data.ok) { AI_HAS_SERVER_KEY = true; $("aiKeyInput").value = ""; $("aiKeyMsg").textContent = ""; renderAiPanel(); }
    else $("aiKeyMsg").innerHTML = '<span class="err">' + esc((data && data.message) || T("儲存失敗", "Could not save")) + '</span>';
  });
}

/* ---------- actions ---------- */
function exportCsv() {
  const groups = priorityGroups();
  const rows = [["Town/Road", "BestMinToWork", "Modes", "RailStations", "BusStops", "Lat", "Lon"]];
  for (const g of groups.values())
    rows.push([g.key, g.best === null ? "" : Math.round(g.best), [...g.modes].map(modeLabel).join(" / "),
      g.stations.join(" / "), g.stops.join(" / "), g.lat.toFixed(6), g.lon.toFixed(6)]);
  const csv = "﻿" + rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = "candidates.csv";
  // Firefox only follows a download from an anchor that is in the document, and
  // revoking the blob URL in the same tick cancels the save in some browsers.
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(groups.size ? T("已匯出 " + groups.size + " 個候選區域", "Exported " + groups.size + " areas")
    : T("目前沒有候選區域，仍匯出空表", "No candidate areas; exported an empty table"));
}

/* What to call wherever the workplace pin now is, from the network already in
 * memory (no reverse-geocoding service to call): the MRT station if one is a
 * short walk away, else the nearest bus stop. Worked out on every render, so
 * it follows the language switch. */
function placeName(lat, lon) {
  const st = nearestStation(lat, lon, 600);
  if (st.name) return T(st.name + " 站附近", "Near " + st.name + " Stn");
  const bs = nearestStop(lat, lon, 400);
  if (bs.code) return T(STOPS[bs.code][2] + " 附近", "Near " + STOPS[bs.code][2]);
  return lat.toFixed(5) + ", " + lon.toFixed(5);
}
/* The name on screen. A typed name is kept forever; a searched one until the
 * pin moves; after a drag or typed coordinates it is placeName(). Keeping the
 * old name after a drag is how a company name ended up labelling a pin in
 * the middle of town. */
function companyLabel() {
  const c = state.company;
  return c.autoName ? placeName(c.lat, c.lon) : (c.name || T("未命名地點", "Unnamed place"));
}

/* Move the workplace. `label` is a search result's name (null when the pin
 * was dragged or coordinates were typed); `zoom` false leaves the map alone
 * because the user is already looking at the spot they dropped the pin on. */
function moveCompany(lat, lon, label, address, zoom = true) {
  const c = state.company;
  c.lat = lat; c.lon = lon;
  if (address) c.address = address;
  if (!c.nameEdited) {
    c.autoName = !label;
    if (label) c.name = label;
  }
  c.isDefault = false;
  if (zoom) map.setView([lat, lon], Math.max(map.getZoom(), 14));
  refresh();
}

function renderAddrResults() {
  const el = $("addrResults");
  if (!addrHits.length) { el.innerHTML = ""; return; }
  el.innerHTML = addrHits.map((h, i) =>
    '<button class="pick" data-hit="' + i + '"><b>' + esc(h.name) + '</b><span>' + esc(h.address) + '</span></button>').join("");
  el.querySelectorAll("button[data-hit]").forEach(b => {
    b.addEventListener("click", e => {
      const h = addrHits[+e.currentTarget.dataset.hit];
      moveCompany(h.lat, h.lon, h.name, h.address);
      $("addrMsg").innerHTML = '<span class="ok">' + T("已移到 ", "Moved to ") + esc(h.name) + '</span>';
      addrHits = []; renderAddrResults();
      closeCompanyCard();
    });
  });
}

// after a new workplace is picked the card folds back to show it
function closeCompanyCard() { state.ui.companyOpen = false; $("companySection").open = false; }

function wireExplorer() {
  const onRange = (id, apply) => $(id).addEventListener("input", e => { apply(+e.target.value); refresh(); });
  onRange("companyR", v => state.companyRadius = v);
  onRange("walkR", v => state.walkRadius = v);
  onRange("feederMin", v => state.feederMin = v);
  onRange("maxTotal", v => state.maxTotalMin = v);
  onRange("railTransfers", v => state.modes.railTransfers = v);

  ALL_MODES.forEach(m => {
    $("mode" + m[0].toUpperCase() + m.slice(1)).addEventListener("change", e => {
      state.modes[m] = e.target.checked;
      buildShuttleMarkers(); refresh();
    });
  });
  [["accWalk", "walk"], ["accBus", "bus"], ["accRail", "rail"]].forEach(([id, k]) => {
    $(id).addEventListener("change", e => { access()[k] = e.target.checked; refresh(); });
  });
  $("starRule").addEventListener("change", e => { state.modes.starRule = e.target.value; refresh(); });
  $("shuttleSection").addEventListener("toggle", e => { state.ui.shuttleOpen = e.target.open; });
  // the card's "change" chip sits inside <summary>, so the whole header toggles
  [["companySection", "companyOpen"], ["moreOpts", "moreOpen"], ["diagSection", "diagOpen"]].forEach(([id, key]) =>
    $(id).addEventListener("toggle", e => { state.ui[key] = e.target.open; }));
  $("probeFocus").addEventListener("change", e => {
    state.ui.probeFocus = e.target.checked;
    if (e.target.checked && !state.probe) toast(T("在地圖上點一個位置，就只會留下那裡用得到的路線",
      "Click a spot on the map and only the routes it can use will stay"));
    render(); renderSidebar();
  });
  $("routeFilter").addEventListener("change", e => { state.routeFilter = e.target.value; render(); });

  $("companyName").addEventListener("input", e => {
    const c = state.company;
    c.name = e.target.value;
    // a typed name survives later searches and drags; clearing it hands the
    // naming back to them
    c.nameEdited = !!c.name.trim();
    c.autoName = !c.nameEdited;
    c.isDefault = false;
    render(); renderSidebar();
  });

  $("btnAddr").addEventListener("click", async () => {
    const q = $("addrInput").value.trim();
    if (!q) return;
    $("addrMsg").textContent = T("搜尋中…", "Searching…"); addrHits = []; renderAddrResults();
    const data = await geocodeSearch(q);
    if (!data.ok || !data.results.length) {
      $("addrMsg").innerHTML = '<span class="err">' + esc(data.message || T("查無此地址", "No match")) + '</span>'; return;
    }
    addrHits = data.results;
    if (addrHits.length === 1) {
      const h = addrHits[0];
      moveCompany(h.lat, h.lon, h.name, h.address);
      $("addrMsg").innerHTML = '<span class="ok">' + esc(h.address) + '</span>';
      addrHits = [];
      closeCompanyCard();
    } else {
      $("addrMsg").textContent = T("找到 " + addrHits.length + " 筆，選一個：", addrHits.length + " matches, pick one:");
    }
    renderAddrResults();
  });
  $("addrInput").addEventListener("keydown", e => { if (e.key === "Enter") $("btnAddr").click(); });

  $("btnLatLon").addEventListener("click", () => {
    const m = $("latlonInput").value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { $("addrMsg").innerHTML = '<span class="err">' + T("格式看不懂，請填「緯度, 經度」例如 1.29294, 103.85259",
      "Could not read that. Use “lat, lon”, e.g. 1.29294, 103.85259") + '</span>'; return; }
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (lat < 1.1 || lat > 1.5 || lon < 103.5 || lon > 104.2) {
      $("addrMsg").innerHTML = '<span class="err">' + T("這個座標不在新加坡範圍內。", "That point is not in Singapore.") + '</span>'; return;
    }
    moveCompany(lat, lon, null, lat.toFixed(5) + ", " + lon.toFixed(5));
    $("addrMsg").innerHTML = '<span class="ok">' + T("已移到 ", "Moved to ") + lat.toFixed(5) + ", " + lon.toFixed(5) + '</span>';
    closeCompanyCard();
  });

  $("btnAddShuttle").addEventListener("click", () => {
    placingShuttle = !placingShuttle;
    $("btnAddShuttle").textContent = addShuttleText();
  });

  $("btnFitPrio").addEventListener("click", () => {
    const pts = calc.stars.map(s => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15));
    else toast(T("目前設定下沒有優先候選地點", "Nothing qualifies with these settings"));
  });

  $("btnSave").addEventListener("click", async () => {
    const payload = JSON.parse(JSON.stringify(state));
    delete payload.probe;
    // main.py and the single-file export read the name, not the rule behind it
    payload.company.name = companyLabel();
    if (OFFLINE) {
      payload.buildId = window.EMBEDDED_BUNDLE.buildId;   // which built-in setup this grew out of
      try {
        localStorage.setItem(LOCAL_SETUP_KEY, JSON.stringify(payload));
        toast(T("設定已存在這個瀏覽器，下次打開會沿用", "Saved in this browser; it will be used next time"));
      } catch (e) { toast(T("這個瀏覽器不允許儲存（無痕模式？）", "This browser will not store it (private mode?)")); }
      return;
    }
    const { data } = await api("/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    toast(data && data.ok ? data.message : T("儲存失敗", "Could not save"));
  });

  $("btnExport").addEventListener("click", exportCsv);

  $("btnReset").addEventListener("click", async () => {
    if (OFFLINE) {
      try { localStorage.removeItem(LOCAL_SETUP_KEY); } catch (e) { /* nothing saved */ }
      location.reload(); return;
    }
    const { data } = await api("/api/setup");
    state = normaliseSetup(data.setup);
    state.shuttles.forEach(ensureShuttleAnchors);
    syncControls();
    buildShuttleMarkers(); refresh();
    map.setView([state.company.lat, state.company.lon], 12);
    toast(T("已重設", "Reset done"));
  });

  $("btnSetup").addEventListener("click", () => {
    $("app").classList.remove("on");
    $("setup").style.display = "";
    refreshStatus();
  });
}

/* A full recompute sweeps both networks and probes ~5,400 anchors, which is
 * fast but not free -- coalesce the burst of events a slider drag produces.
 * Deliberately a timer and not requestAnimationFrame: rAF never fires while the
 * tab is in the background, and app.py opens the explorer in a tab the user may
 * not look at for a while, which left the map blank until they focused it. */
let _pending = null;
function refresh() {
  clearTimeout(_pending);
  _pending = setTimeout(() => {
    _pending = null;
    recompute(); render(); renderSidebar();
  }, 0);
}

boot();
