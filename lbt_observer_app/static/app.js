const LBT = { latDeg: 32.7013, lonDeg: -109.8891 };
const els = {};
let state = null;
let selectedId = "";
let metricsCache = new Map();
let saveTimer = null;
let draggedTargetId = "";
let sliderFrame = 0;
let pendingSliderMinutes = null;

const $ = (id) => document.getElementById(id);
const fmt = (x, digits = 1) => Number.isFinite(x) ? x.toFixed(digits) : "";
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;
const mod = (x, n) => ((x % n) + n) % n;
const ALT_PLOT_HOURS = 14;
const ATM_DISPLAY_LIMIT_ARCSEC = 5;
const LBT_ELEVATION_M = 3269;
const ATM_TEMP_C = 2;

document.addEventListener("DOMContentLoaded", async () => {
  [
    "dateInput", "timeInput", "timeSlider", "timeMinusBtn", "timePlusBtn", "lbtLocalTime", "zoneInput", "nowBtn", "saveBtn", "rebuildBtn",
    "instrumentTabs", "searchInput", "statusFilter", "flagFilter", "targetLimit", "upOnly", "hideDone",
    "nightStats", "summaryCards", "altCanvas", "altAzCanvas", "skyCanvas", "targetTable",
    "targetCount", "plotTargetLabel", "selectedTitle", "selectedMeta", "warningBadges", "diagnosticsGrid",
    "queueBtn", "notesBox", "sequenceList", "clearSequenceBtn",
    "readmeSelect", "readmeSummary", "readmeText", "stateStamp",
    "clearFiltersBtn", "exportStatusBtn", "fileInput", "importBtn",
    "scrapeBtn", "scrapeLog", "targetsViewBtn", "atmViewBtn", "readmesViewBtn", "plannerView",
    "atmDispView", "readmesWorkspaceView", "atmTargetLabel", "atmStats",
    "atmCanvas", "atmAltPaCanvas", "atmDispTimeCanvas", "atmLossCanvas",
    "atmSlitAngle", "atmSlitSlider", "atmSlitSliderValue", "atmGuideWave", "atmBlueWave",
    "atmRedWave", "atmSeeing", "atmSlitWidth", "readmeWorkspaceTitle",
    "readmeWorkspaceMeta", "readmeWorkspaceText", "readmeNotesBox",
    "readmeIndexPanel", "readmeIndexCount", "readmeIndexList",
    "targetDetailPanel", "diagnosticsPanel", "sequencePanel", "sequenceTimeline", "targetReadmePanel"
  ].forEach((id) => { els[id] = $(id); });

  await loadState();
  els.searchInput.value = "";
  wireEvents();
  setInterval(updateLbtLocalReadout, 30000);
  render();
});

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  state.targets ||= [];
  state.readmes ||= [];
  state.sequence ||= [];
  state.meta ||= {};
  state.readmeNotes ||= {};
  applyDefaults();
}

function applyDefaults() {
  const now = new Date();
  state.targets = mergeByIdentity(state.targets || []);
  const validIds = new Set(state.targets.map((t) => t.id));
  state.sequence = (state.sequence || []).filter((id, idx, arr) => validIds.has(id) && arr.indexOf(id) === idx);
  state.meta.date ||= now.toISOString().slice(0, 10);
  state.meta.timezone ||= "UTC";
  state.meta.selectedLocalTime ||= now.toISOString().slice(0, 16);
  state.meta.activeView ||= "planner";
  if (!state.meta.sortKey || state.meta.sortKey === "score") {
    state.meta.sortKey = "priority";
    state.meta.sortDir = "asc";
  }
  state.meta.sortDir ||= "asc";
  state.meta.atm ||= {};
  if (!state.meta.activeInstrument) {
    state.meta.activeInstrument = targetInstruments()[0] || "PEPSI";
  }
  state.targets.forEach((t, idx) => {
    if ((t.status || "").toLowerCase() === "queued") {
      if (!state.sequence.includes(t.id)) state.sequence.push(t.id);
      t.status = "";
    }
    t.status ||= "";
    t.notes ||= "";
    t.observedAt ||= "";
    if (t.manualOrder == null) t.manualOrder = idx;
  });
  selectedId ||= visibleTargets()[0]?.id || state.targets[0]?.id || "";
}

function wireEvents() {
  els.dateInput.addEventListener("change", () => {
    state.meta.date = els.dateInput.value;
    renderAndSave();
  });
  els.timeInput.addEventListener("change", () => {
    setSelectedLocalParts(els.dateInput.value, els.timeInput.value);
    renderAndSave();
  });
  els.timeSlider.addEventListener("input", () => {
    pendingSliderMinutes = Number(els.timeSlider.value);
    if (sliderFrame) return;
    sliderFrame = requestAnimationFrame(() => {
      sliderFrame = 0;
      updateFromNightSlider(pendingSliderMinutes);
    });
  });
  els.timeSlider.addEventListener("change", () => scheduleSave());
  els.timeMinusBtn.addEventListener("click", () => shiftSelectedTime(-30));
  els.timePlusBtn.addEventListener("click", () => shiftSelectedTime(30));
  els.zoneInput.addEventListener("change", () => {
    const instant = selectedUtc();
    state.meta.timezone = els.zoneInput.value;
    const parts = localPartsFromUtc(instant, state.meta.timezone);
    state.meta.date = parts.date;
    state.meta.selectedLocalTime = `${parts.date}T${parts.time}`;
    renderAndSave();
  });
  els.nowBtn.addEventListener("click", () => {
    const now = new Date();
    const parts = localPartsFromUtc(now, state.meta.timezone);
    state.meta.date = parts.date;
    state.meta.selectedLocalTime = `${parts.date}T${parts.time}`;
    renderAndSave();
  });
  els.saveBtn.addEventListener("click", () => saveState(true));
  els.rebuildBtn.addEventListener("click", rebuildFromFiles);
  els.targetsViewBtn.addEventListener("click", () => setView("planner"));
  els.atmViewBtn.addEventListener("click", () => setView("atmdisp"));
  els.readmesViewBtn.addEventListener("click", () => setView("readmes"));
  els.searchInput.addEventListener("input", render);
  els.statusFilter.addEventListener("change", render);
  els.flagFilter.addEventListener("change", render);
  els.targetLimit.addEventListener("change", render);
  els.upOnly.addEventListener("change", render);
  els.hideDone.addEventListener("change", render);
  els.clearFiltersBtn.addEventListener("click", () => {
    els.searchInput.value = "";
    els.statusFilter.value = "active";
    els.flagFilter.value = "all";
    els.targetLimit.value = "0";
    els.upOnly.checked = false;
    els.hideDone.checked = false;
    render();
  });
  els.queueBtn.addEventListener("click", () => {
    toggleSelectedQueue();
  });
  els.notesBox.addEventListener("input", () => {
    const target = getTarget(selectedId);
    if (!target) return;
    target.notes = els.notesBox.value;
    scheduleSave();
    renderTableOnly();
  });
  document.querySelectorAll(".statusButtons button").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateTarget(selectedId, {
        status: btn.dataset.status,
        observedAt: btn.dataset.status === "observed" ? new Date().toISOString() : ""
      });
    });
  });
  els.clearSequenceBtn.addEventListener("click", () => {
    state.sequence = [];
    renderAndSave();
  });
  els.readmeSelect.addEventListener("change", () => {
    const target = getTarget(selectedId);
    if (target) {
      target.readmeId = els.readmeSelect.value;
      scheduleSave();
      renderReadme();
    }
  });
  els.exportStatusBtn.addEventListener("click", () => downloadJson("lbt_observing_exchange.json", makeStatusExport()));
  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", importFile);
  els.scrapeBtn.addEventListener("click", runScraper);
  els.targetTable.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => setSort(th.dataset.sort));
  });
  ["atmSlitAngle", "atmGuideWave", "atmBlueWave", "atmRedWave", "atmSeeing", "atmSlitWidth"].forEach((id) => {
    els[id].addEventListener("input", () => {
      if (id === "atmSlitAngle") syncSlitPaControls(els.atmSlitAngle.value);
      state.meta.atm[id] = els[id].value;
      renderAtmDisp();
      scheduleSave();
    });
  });
  els.atmSlitSlider.addEventListener("input", () => {
    syncSlitPaControls(els.atmSlitSlider.value);
    state.meta.atm.atmSlitAngle = els.atmSlitAngle.value;
    renderAtmDisp();
    scheduleSave();
  });
  els.readmeNotesBox.addEventListener("input", () => {
    const readme = activeWorkspaceReadme();
    if (!readme) return;
    state.readmeNotes[readme.id] = els.readmeNotesBox.value;
    scheduleSave();
  });
  document.addEventListener("keydown", handleHotkey);
}

function handleHotkey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  if ((state.meta.activeView || "planner") !== "planner") return;
  const key = event.key.toLowerCase();
  if (key === "q") {
    event.preventDefault();
    toggleSelectedQueue();
  } else if (key === "d") {
    event.preventDefault();
    markSelectedDone();
  } else if (key === "t") {
    event.preventDefault();
    updateTarget(selectedId, { status: "", observedAt: "" });
  } else if (key === "j" || key === "arrowdown") {
    event.preventDefault();
    stepSelection(1);
  } else if (key === "k" || key === "arrowup") {
    event.preventDefault();
    stepSelection(-1);
  }
}

function isTypingTarget(node) {
  const tag = node?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node?.isContentEditable;
}

function toggleSelectedQueue() {
  if (!selectedId) return;
  if (state.sequence.includes(selectedId)) {
    state.sequence = state.sequence.filter((id) => id !== selectedId);
  } else {
    state.sequence.push(selectedId);
  }
  renderAndSave();
}

function markSelectedDone() {
  if (!selectedId) return;
  updateTarget(selectedId, { status: "observed", observedAt: new Date().toISOString() });
}

function stepSelection(delta) {
  const rows = visibleTargets();
  if (!rows.length) return;
  const idx = rows.findIndex((t) => t.id === selectedId);
  const next = rows[clamp(idx + delta, 0, rows.length - 1)] || rows[0];
  selectedId = next.id;
  render();
}

function setSelectedLocalParts(date, time) {
  state.meta.date = date;
  state.meta.selectedLocalTime = `${date}T${time || "00:00"}`;
}

function syncSlitPaControls(value) {
  const angle = mod(Math.round(Number(value) || 0), 360);
  els.atmSlitAngle.value = String(angle);
  els.atmSlitSlider.value = String(angle);
  els.atmSlitSliderValue.textContent = `${angle} deg`;
}

function shiftSelectedTime(deltaMinutes) {
  const current = zonedLocalToUtc(state.meta.selectedLocalTime || `${state.meta.date}T00:00`, state.meta.timezone);
  const shifted = new Date(current.getTime() + deltaMinutes * 60 * 1000);
  const parts = localPartsFromUtc(shifted, state.meta.timezone);
  state.meta.date = parts.date;
  state.meta.selectedLocalTime = `${parts.date}T${parts.time}`;
  renderAndSave();
}

function instruments() {
  return [...new Set(state.targets.map((t) => t.instrument).concat(state.readmes.map((r) => r.instrument)).filter(Boolean))]
    .sort((a, b) => instrumentRank(a) - instrumentRank(b) || a.localeCompare(b));
}

function targetInstruments() {
  return [...new Set(state.targets.map((t) => t.instrument).filter(Boolean))]
    .sort((a, b) => instrumentRank(a) - instrumentRank(b) || a.localeCompare(b));
}

function setView(view) {
  state.meta.activeView = view;
  renderAndSave();
}

function setSort(key) {
  if (state.meta.sortKey === key) {
    state.meta.sortDir = state.meta.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.meta.sortKey = key;
    state.meta.sortDir = ["targetName", "programName", "partner", "status", "priority", "airmass", "visitHours", "raDeg", "decDeg"].includes(key) ? "asc" : "desc";
  }
  renderAndSave();
}

function instrumentRank(name) {
  const idx = ["MODS", "SHARK-V", "LUCI", "LBC", "PEPSI", "P-POL"].indexOf(name);
  return idx >= 0 ? idx : 99;
}

function getTarget(id) {
  return state.targets.find((t) => t.id === id);
}

function selectedUtc() {
  const local = state.meta.selectedLocalTime || `${state.meta.date}T00:00`;
  return zonedLocalToUtc(local, state.meta.timezone);
}

function zonedLocalToUtc(localText, zone) {
  const [date, time] = localText.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  if (zone === "UTC") return new Date(Date.UTC(y, m - 1, d, hh, mm || 0));
  if (zone === "TUCSON") return new Date(Date.UTC(y, m - 1, d, hh + 7, mm || 0));
  if (zone === "BROWSER") return new Date(y, m - 1, d, hh, mm || 0);
  const zoneName = zone === "ET" ? "America/New_York" : "UTC";
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm || 0));
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(guess, zoneName);
    guess = new Date(Date.UTC(y, m - 1, d, hh, mm || 0) - off);
  }
  return guess;
}

function localPartsFromUtc(date, zone) {
  if (zone === "UTC") return { date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16) };
  if (zone === "BROWSER") {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
  }
  const zoneName = zone === "TUCSON" ? "America/Phoenix" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneName, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

function render() {
  if (!state) return;
  syncInputs();
  computeMetrics();
  ensureSelected();
  renderTabs();
  renderWorkspace();
  renderSummary();
  renderNight();
  renderPlots();
  renderTable();
  renderSelected();
  renderDiagnostics();
  renderSequence();
  renderReadme();
  renderAtmDisp();
  renderReadmeIndex();
  renderReadmeWorkspace();
  els.stateStamp.textContent = `Saved state: ${state.updatedAt || "not yet saved"}`;
}

function updateFromNightSlider(minutes) {
  const utc = utcFromNightSlider(Number(minutes));
  const parts = localPartsFromUtc(utc, state.meta.timezone);
  state.meta.date = parts.date;
  state.meta.selectedLocalTime = `${parts.date}T${parts.time}`;
  renderTimeChange();
}

function renderTimeChange() {
  syncInputs();
  computeMetrics();
  renderSummary();
  renderNight();
  renderPlots();
  renderTable();
  renderSelected();
  renderDiagnostics();
  renderSequence();
  renderAtmDisp();
}

function ensureSelected() {
  const current = getTarget(selectedId);
  if (current && current.instrument === state.meta.activeInstrument) return;
  selectedId = visibleTargets()[0]?.id || instrumentTargets()[0]?.id || state.targets[0]?.id || "";
}

function renderWorkspace() {
  const view = state.meta.activeView || "planner";
  const readmesActive = view === "readmes";
  els.plannerView.classList.toggle("hidden", view !== "planner");
  els.atmDispView.classList.toggle("hidden", view !== "atmdisp");
  els.readmesWorkspaceView.classList.toggle("hidden", !readmesActive);
  els.targetsViewBtn.classList.toggle("active", view === "planner");
  els.atmViewBtn.classList.toggle("active", view === "atmdisp");
  els.readmesViewBtn.classList.toggle("active", readmesActive);
  document.querySelector(".detail")?.classList.toggle("hidden", view === "atmdisp");
  els.readmeIndexPanel.classList.toggle("hidden", !readmesActive);
  els.targetDetailPanel.classList.toggle("hidden", view !== "planner");
  els.diagnosticsPanel.classList.toggle("hidden", view !== "planner");
  els.sequencePanel.classList.toggle("hidden", view !== "planner");
  els.targetReadmePanel.classList.toggle("hidden", view !== "planner");
}

function renderAndSave() {
  render();
  scheduleSave();
}

function syncInputs() {
  const parts = (state.meta.selectedLocalTime || `${state.meta.date}T00:00`).split("T");
  els.dateInput.value = state.meta.date || parts[0];
  els.timeInput.value = (parts[1] || "00:00").slice(0, 5);
  els.timeSlider.min = "0";
  els.timeSlider.max = String(ALT_PLOT_HOURS * 60);
  els.timeSlider.value = String(minutesIntoNightWindow(selectedUtc()));
  updateLbtLocalReadout();
  els.zoneInput.value = state.meta.timezone || "UTC";
}

function updateLbtLocalReadout() {
  if (!els.lbtLocalTime) return;
  els.lbtLocalTime.textContent = lbtLocalTimeLabel(new Date());
}

function lbtLocalTimeLabel(instant) {
  const parts = localPartsFromUtc(instant, "TUCSON");
  return `${parts.date} ${parts.time} MST`;
}

function computeMetrics() {
  metricsCache = new Map();
  const date = selectedUtc();
  const moon = moonPosition(date);
  const moonAltAz = altAz(moon.raDeg, moon.decDeg, date, LBT.latDeg, LBT.lonDeg);
  for (const target of state.targets) {
    const pos = target.raDeg == null || target.decDeg == null
      ? { alt: NaN, az: NaN, haHours: NaN, airmass: NaN }
      : altAz(target.raDeg, target.decDeg, date, LBT.latDeg, LBT.lonDeg);
    const moonSep = target.raDeg == null || target.decDeg == null
      ? NaN
      : angularSep(target.raDeg, target.decDeg, moon.raDeg, moon.decDeg);
    metricsCache.set(target.id, { ...pos, moonSep, moonAlt: moonAltAz.alt, moonIllum: moon.phase });
  }
}

function renderTabs() {
  const counts = Object.fromEntries(instruments().map((i) => [i, 0]));
  state.targets.forEach((t) => { counts[t.instrument] = (counts[t.instrument] || 0) + 1; });
  els.instrumentTabs.innerHTML = "";
  for (const inst of instruments()) {
    const btn = document.createElement("button");
    btn.className = inst === state.meta.activeInstrument && state.meta.activeView === "planner" ? "active" : "";
    btn.innerHTML = `<strong>${escapeHtml(inst)}</strong><span>${counts[inst] || 0}</span>`;
    btn.addEventListener("click", () => {
      state.meta.activeView = "planner";
      state.meta.activeInstrument = inst;
      selectedId = visibleTargets()[0]?.id || state.targets.find((t) => t.instrument === inst)?.id || selectedId;
      renderAndSave();
    });
    els.instrumentTabs.appendChild(btn);
  }
}

function renderSummary() {
  const targets = instrumentTargets();
  const active = targets.filter((t) => !isDone(t));
  const up = active.filter((t) => (metricsCache.get(t.id)?.alt || -90) > 20);
  const doneHours = targets.filter((t) => isObserved(t)).reduce((s, t) => s + (Number(t.visitHours) || 0), 0);
  const cards = [
    ["Active", active.length],
    ["Up now", up.length],
    ["Done hours", fmt(doneHours, 2)]
  ];
  els.summaryCards.innerHTML = cards.map(([k, v]) => `<div class="metric"><b>${k}</b><strong>${escapeHtml(String(v))}</strong></div>`).join("");
}

function renderNight() {
  const date = selectedUtc();
  const sun = sunPosition(date);
  const moon = moonPosition(date);
  const sunAlt = altAz(sun.raDeg, sun.decDeg, date, LBT.latDeg, LBT.lonDeg).alt;
  const moonAlt = altAz(moon.raDeg, moon.decDeg, date, LBT.latDeg, LBT.lonDeg).alt;
  const lst = localSiderealTime(date, LBT.lonDeg) / 15;
  els.nightStats.innerHTML = [
    ["UTC", date.toISOString().slice(0, 16).replace("T", " ")],
    ["LST", `${pad2(Math.floor(lst))}:${pad2(Math.floor((lst % 1) * 60))}`],
    ["Sun alt", `${fmt(sunAlt)} deg`],
    ["Moon", `${fmt(moon.phase * 100, 0)}%, alt ${fmt(moonAlt)} deg`]
  ].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join("");
}

function instrumentTargets() {
  return state.targets.filter((t) => t.instrument === state.meta.activeInstrument);
}

function visibleTargets() {
  const query = parseTargetQuery(els.searchInput?.value || "");
  const statusMode = els.statusFilter?.value || "active";
  const flagMode = els.flagFilter?.value || "all";
  let targets = instrumentTargets();
  targets = targets.filter((t) => {
    const m = metricsCache.get(t.id) || {};
    if (query.terms.length) {
      const blob = [t.targetName, t.programName, t.partner, t.notes, t.raText, t.decText].join(" ").toLowerCase();
      if (!query.terms.every((term) => blob.includes(term))) return false;
    }
    if (!passesCoordinateConstraints(t, query.constraints)) return false;
    if (els.hideDone?.checked && isDone(t)) return false;
    if (els.upOnly?.checked && !(m.alt > 0)) return false;
    if (statusMode === "observed" && !isObserved(t)) return false;
    if (statusMode === "todo" && (t.status || "")) return false;
    if (statusMode === "skip" && t.status !== "skip") return false;
    if (statusMode === "active" && (t.status === "observed" || t.status === "skip")) return false;
    if (!passesFlagFilter(t, flagMode)) return false;
    return true;
  });
  targets = targets.sort(compareTargets);
  const limit = Number(els.targetLimit?.value || 0);
  return limit > 0 ? targets.slice(0, limit) : targets;
}

function passesFlagFilter(target, mode) {
  if (!mode || mode === "all") return true;
  const warnings = targetWarnings(target);
  if (mode === "any") return warnings.length > 0;
  if (mode === "none") return warnings.length === 0;
  if (mode === "airmass") return warnings.some((w) => w.code === "airmass");
  if (mode === "moon") return warnings.some((w) => w.code === "moon");
  if (mode === "ha") return warnings.some((w) => w.code === "ha");
  if (mode === "below") return warnings.some((w) => w.code === "below");
  return true;
}

function parseTargetQuery(raw) {
  const constraints = [];
  const text = String(raw || "").replace(/\b(ra|dec)\s*(<=|>=|<|>)\s*([+-]?\d+(?:\.\d+)?)(?:h|d|deg)?\b/gi,
    (_, field, op, value) => {
      constraints.push({ field: field.toLowerCase(), op, value: Number(value) });
      return " ";
    });
  return {
    terms: text.trim().toLowerCase().split(/\s+/).filter(Boolean),
    constraints: constraints.filter((c) => Number.isFinite(c.value)),
  };
}

function passesCoordinateConstraints(target, constraints) {
  for (const c of constraints) {
    const value = c.field === "ra" ? target.raDeg / 15 : target.decDeg;
    if (!Number.isFinite(value)) return false;
    if (c.op === ">" && !(value > c.value)) return false;
    if (c.op === ">=" && !(value >= c.value)) return false;
    if (c.op === "<" && !(value < c.value)) return false;
    if (c.op === "<=" && !(value <= c.value)) return false;
  }
  return true;
}

function compareTargets(a, b) {
  const key = state.meta.sortKey || "priority";
  const dir = state.meta.sortDir === "asc" ? 1 : -1;
  if (key === "manual") return (a.manualOrder ?? 0) - (b.manualOrder ?? 0);
  if (key === "score") return scoreTarget(b) - scoreTarget(a);
  let av = targetSortValue(a, key);
  let bv = targetSortValue(b, key);
  if (typeof av === "string" || typeof bv === "string") {
    return dir * String(av ?? "").localeCompare(String(bv ?? ""));
  }
  av = Number.isFinite(av) ? av : (dir > 0 ? Infinity : -Infinity);
  bv = Number.isFinite(bv) ? bv : (dir > 0 ? Infinity : -Infinity);
  return dir * (av - bv);
}

function minutesIntoNightWindow(instant) {
  const start = lbtNightWindowStart(instant);
  return clamp(Math.round((instant - start) / 60000), 0, ALT_PLOT_HOURS * 60);
}

function utcFromNightSlider(minutes) {
  const start = lbtNightWindowStart(selectedUtc());
  return new Date(start.getTime() + minutes * 60000);
}

function lbtNightWindowStart(instant) {
  const center = lbtMidnightForSelectedNight(instant);
  return new Date(center.getTime() - (ALT_PLOT_HOURS / 2) * 3600 * 1000);
}

function targetSortValue(t, key) {
  const m = metricsCache.get(t.id) || {};
  if (key in m) return m[key];
  if (key === "status") return t.status || "todo";
  if (key === "partner") return partnerForTarget(t);
  if (key === "priority" || key === "visitHours") return Number(t[key]);
  return t[key] || "";
}

function scoreTarget(t) {
  const m = metricsCache.get(t.id) || {};
  const pr = Number.isFinite(t.priority) ? 10 - t.priority : 0;
  const alt = Number.isFinite(m.alt) ? clamp((m.alt - 15) / 55, 0, 1) * 8 : 0;
  const moon = Number.isFinite(m.moonSep) ? clamp((m.moonSep - 20) / 80, 0, 1) * 2 : 0;
  const status = t.status === "queued" ? 3 : 0;
  return pr + alt + moon + status;
}

function renderTableOnly() {
  renderTable();
  renderSummary();
}

function renderTable() {
  const rows = visibleTargets();
  const tbody = els.targetTable.querySelector("tbody");
  tbody.innerHTML = "";
  els.targetCount.textContent = `${rows.length} shown`;
  els.targetTable.querySelectorAll("thead th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.meta.sortKey;
    th.classList.toggle("activeSort", active);
    th.dataset.dir = active ? state.meta.sortDir : "";
  });
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="12" class="emptyCell">No targets loaded. Run Update from OSURC, or import scraper output.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const target of rows) {
    const m = metricsCache.get(target.id) || {};
    const tr = document.createElement("tr");
    tr.className = target.id === selectedId ? "selected" : "";
    tr.draggable = true;
    tr.dataset.id = target.id;
    tr.innerHTML = `
      <td><div class="targetName"><strong>${escapeHtml(target.targetName)}</strong></div></td>
      <td><button class="statusCycle" title="Cycle todo and observed">${statusBadge(target.status, state.sequence.includes(target.id))}</button></td>
      <td>${warningBadgeHtml(target, "compact")}</td>
      <td class="coordCell">${escapeHtml(raShort(target))}</td>
      <td class="coordCell">${escapeHtml(decShort(target))}</td>
      <td>${escapeHtml(target.programName || "")}</td>
      <td class="numericCell"><input class="priorityInput" type="number" step="0.1" value="${target.priority ?? ""}" title="Edit priority"></td>
      <td class="numericCell">${fmt(m.alt)}</td>
      <td class="numericCell">${fmt(m.airmass, 2)}</td>
      <td class="numericCell">${fmt(m.haHours, 2)}</td>
      <td class="numericCell moonAngleCell" style="${moonCellStyle(m)}" title="${moonCellTitle(m)}"><span>${fmt(m.moonSep, 0)}</span></td>
      <td class="numericCell">${fmt(Number(target.visitHours), 2)}</td>`;
    tr.addEventListener("click", () => {
      selectedId = target.id;
      renderSelected();
      renderReadme();
      renderPlots();
      renderTable();
    });
    tr.addEventListener("dragstart", (event) => {
      draggedTargetId = target.id;
      event.dataTransfer.effectAllowed = "move";
    });
    tr.addEventListener("dragover", (event) => {
      event.preventDefault();
      tr.classList.add("dropTarget");
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("dropTarget"));
    tr.addEventListener("drop", (event) => {
      event.preventDefault();
      tr.classList.remove("dropTarget");
      moveTargetBefore(draggedTargetId, target.id);
    });
    const priorityInput = tr.querySelector(".priorityInput");
    priorityInput.addEventListener("click", (event) => event.stopPropagation());
    priorityInput.addEventListener("change", (event) => {
      event.stopPropagation();
      target.priority = toNum(priorityInput.value);
      target.prioritySource = "manual";
      renderAndSave();
    });
    const statusButton = tr.querySelector(".statusCycle");
    statusButton.addEventListener("click", (event) => {
      event.stopPropagation();
      cycleStatus(target.id);
    });
    tbody.appendChild(tr);
  }
}

function moonCellStyle(m) {
  const illum = clamp(Number(m.moonIllum) || 0, 0, 1);
  const fill = Math.round(illum * 100);
  const moonUp = Number(m.moonAlt) > 0;
  const alpha = moonUp ? 0.1 + illum * 0.28 : 0.06 + illum * 0.12;
  const color = moonUp ? `rgba(242, 184, 75, ${alpha.toFixed(2)})` : `rgba(149, 167, 178, ${alpha.toFixed(2)})`;
  return `--moon-fill:${fill}%;--moon-color:${color}`;
}

function moonCellTitle(m) {
  if (!Number.isFinite(m.moonSep) || !Number.isFinite(m.moonIllum)) return "";
  const up = Number(m.moonAlt) > 0 ? "up" : "down";
  return `Moon sep ${fmt(m.moonSep, 1)} deg; illum ${fmt(m.moonIllum * 100, 0)}%; moon ${up}`;
}

function cycleStatus(id) {
  const target = getTarget(id);
  if (!target) return;
  const current = (target.status || "").toLowerCase();
  const next = current === "observed" || current === "done" ? "" : "observed";
  updateTarget(id, { status: next, observedAt: next === "observed" ? new Date().toISOString() : "" });
}

function moveTargetBefore(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const instRows = instrumentTargets().sort((a, b) => (a.manualOrder ?? 0) - (b.manualOrder ?? 0));
  const sourceIndex = instRows.findIndex((t) => t.id === sourceId);
  const targetIndex = instRows.findIndex((t) => t.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = instRows.splice(sourceIndex, 1);
  instRows.splice(targetIndex > sourceIndex ? targetIndex - 1 : targetIndex, 0, moved);
  instRows.forEach((t, idx) => { t.manualOrder = idx; });
  state.meta.sortKey = "manual";
  state.meta.sortDir = "asc";
  renderAndSave();
}

function renderSelected() {
  const target = getTarget(selectedId);
  if (!target) {
    els.selectedTitle.textContent = "Target";
    els.selectedMeta.innerHTML = "";
    els.warningBadges.innerHTML = "";
    els.notesBox.value = "";
    return;
  }
  const m = metricsCache.get(target.id) || {};
  els.selectedTitle.textContent = target.targetName;
  els.queueBtn.textContent = state.sequence.includes(target.id) ? "Unqueue" : "Queue";
  els.selectedMeta.innerHTML = [
    ["Instrument", target.displayInstrument || target.instrument],
    ["Program", target.programName || ""],
    ["Partner", partnerForTarget(target)],
    ["Priority source", target.prioritySource || "OSURC"],
    ["RA, Dec", coordLine(target)],
    ["Alt / Airmass", `${fmt(m.alt)} deg / ${fmt(m.airmass, 2)}`],
    ["HA", `${fmt(m.haHours, 2)} hr`],
    ["Moon sep.", `${fmt(m.moonSep, 0)} deg`],
    ["Visit", target.visitHours ? `${fmt(Number(target.visitHours), 2)} hr` : ""],
    ["Source", target.source || ""]
  ].map(([k, v]) => `<div><b>${k}</b><span>${escapeHtml(String(v || ""))}</span></div>`).join("");
  els.warningBadges.innerHTML = warningBadgeHtml(target, "full") || `<span class="targetOk">No current flags</span>`;
  els.notesBox.value = target.notes || "";
  document.querySelectorAll(".statusButtons button").forEach((btn) => {
    btn.classList.toggle("active", (target.status || "") === btn.dataset.status);
  });
}

function renderDiagnostics() {
  const target = getTarget(selectedId);
  if (!target) {
    els.diagnosticsGrid.innerHTML = `<div class="emptyCell">No target selected.</div>`;
    return;
  }
  const date = selectedUtc();
  const m = metricsCache.get(target.id) || {};
  const lstDeg = localSiderealTime(date, LBT.lonDeg);
  const lstHours = lstDeg / 15;
  const pa = target.raDeg == null || target.decDeg == null ? NaN : parallacticAngle(target.raDeg, target.decDeg, date);
  const readme = findReadmeForTarget(target);
  const rows = [
    ["UTC", date.toISOString().slice(0, 16).replace("T", " ")],
    ["LBT local", lbtLocalTimeLabel(date)],
    ["LST", hoursLabel(lstHours)],
    ["RA", target.raText || degToHms(target.raDeg)],
    ["Dec", target.decText || degToDms(target.decDeg)],
    ["HA", `${fmt(m.haHours, 3)} hr`],
    ["Altitude", `${fmt(m.alt, 2)} deg`],
    ["Azimuth", `${fmt(m.az, 1)} deg`],
    ["Airmass", fmt(m.airmass, 3)],
    ["Moon sep.", `${fmt(m.moonSep, 1)} deg`],
    ["Moon illum.", `${fmt((m.moonIllum ?? NaN) * 100, 0)}%`],
    ["Moon alt", `${fmt(m.moonAlt, 1)} deg`],
    ["Parallactic PA", `${fmt(pa, 1)} deg`],
    ["Readme", readme ? (readme.projectId || readme.filename) : "not matched"],
    ["Formulae", "GMST sidereal, Kasten-Young airmass, elongation Moon phase"]
  ];
  els.diagnosticsGrid.innerHTML = rows
    .map(([k, v]) => `<div><b>${escapeHtml(k)}</b><span>${escapeHtml(String(v || ""))}</span></div>`)
    .join("");
}

function targetWarnings(target, includeReadme = false) {
  const m = metricsCache.get(target.id) || {};
  const warnings = [];
  if (target.raDeg == null || target.decDeg == null) {
    warnings.push({ code: "coord", label: "coord", detail: "Missing RA/Dec", level: "bad" });
    return warnings;
  }
  if (!Number.isFinite(m.alt) || m.alt <= 0) {
    warnings.push({ code: "below", label: "down", detail: "Below horizon", level: "bad" });
  } else if (m.alt < 30 || m.airmass > 2) {
    warnings.push({ code: "airmass", label: "X>2", detail: "Airmass above 2.0", level: "warn" });
  }
  const haLimit = Number(target.haLimitHours);
  if (Number.isFinite(haLimit) && haLimit > 0 && Math.abs(m.haHours) > haLimit) {
    warnings.push({ code: "ha", label: "HA", detail: `Outside HA limit (${fmt(haLimit, 1)} hr)`, level: "warn" });
  }
  const moon = moonRisk(target);
  if (moon.level) {
    warnings.push({
      code: "moon",
      label: moon.level === "bad" ? "Moon" : "moon",
      detail: `Moon: sep ${fmt(m.moonSep, 0)} deg, illum ${fmt(m.moonIllum * 100, 0)}%, alt ${fmt(m.moonAlt, 0)} deg`,
      level: moon.level
    });
  }
  if (includeReadme && !findReadmeForTarget(target)) {
    warnings.push({ code: "readme", label: "readme", detail: "No matched readme", level: "info" });
  }
  return warnings;
}

function moonRisk(target) {
  const m = metricsCache.get(target.id) || {};
  if (!Number.isFinite(m.moonSep) || !Number.isFinite(m.moonIllum) || !Number.isFinite(m.moonAlt)) return {};
  const explicit = moonLimitForTarget(target);
  if (Number.isFinite(explicit) && m.moonSep < explicit && m.moonAlt > -6) {
    return { level: "bad", score: 1 };
  }
  const altitudeFactor = m.moonAlt > 0 ? 1 : m.moonAlt > -6 ? 0.35 : 0;
  const sepFactor = clamp((70 - m.moonSep) / 55, 0, 1);
  const score = m.moonIllum * altitudeFactor * sepFactor;
  if (score > 0.55 || (m.moonIllum > 0.75 && m.moonAlt > 0 && m.moonSep < 35)) return { level: "bad", score };
  if (score > 0.25 || (m.moonIllum > 0.45 && m.moonAlt > 0 && m.moonSep < 45)) return { level: "warn", score };
  return { score };
}

function moonLimitForTarget(target) {
  const readme = target.readmeId ? state.readmes.find((r) => r.id === target.readmeId) : null;
  const text = [readme?.conditions, readme?.text].join(" ");
  const match = text.match(/minimum\s+moon\s+angle\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i)
    || text.match(/moon\s+(?:sep(?:aration)?|distance|angle)\s*(?:>|>=|at least|minimum)\s*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : NaN;
}

function warningBadgeHtml(target, mode) {
  const warnings = targetWarnings(target, mode === "full");
  if (!warnings.length) return "";
  const shown = mode === "compact" ? warnings.slice(0, 3) : warnings;
  const extra = warnings.length - shown.length;
  return shown.map((w) =>
    `<span class="warnBadge ${escapeHtml(w.level)}" title="${escapeHtml(w.detail)}">${escapeHtml(mode === "compact" ? w.label : w.detail)}</span>`
  ).join("") + (extra > 0 ? `<span class="warnBadge info" title="${extra} more flags">+${extra}</span>` : "");
}

function renderSequence() {
  els.sequenceList.innerHTML = "";
  state.sequence = state.sequence.filter((id) => getTarget(id));
  drawSequenceTimeline();
  for (const [idx, id] of state.sequence.entries()) {
    const t = getTarget(id);
    const m = metricsCache.get(id) || {};
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="seqName"><strong>${escapeHtml(t.targetName)}</strong><span>${fmt(m.alt)} deg</span></div>
      <div class="seqActions">
        <button data-act="up">Up</button>
        <button data-act="down">Down</button>
        <button data-act="done">Done</button>
        <button data-act="remove">Remove</button>
      </div>`;
    li.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => sequenceAction(idx, btn.dataset.act));
    });
    els.sequenceList.appendChild(li);
  }
}

function drawSequenceTimeline() {
  const canvas = els.sequenceTimeline;
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 42, r: 10, t: 16, b: 28 };
  const base = selectedUtc();
  const start = lbtNightWindowStart(base);
  const end = new Date(start.getTime() + ALT_PLOT_HOURS * 3600 * 1000);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  drawMiniTwilightBands(ctx, pad, w, h, start);
  ctx.strokeStyle = "#273443";
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);
  const xForTime = (date) => pad.l + clamp((date - start) / (end - start), 0, 1) * plotW;
  const xNow = xForTime(base);
  ctx.strokeStyle = "#edf4f7";
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(xNow, pad.t);
  ctx.lineTo(xNow, pad.t + plotH);
  ctx.stroke();
  ctx.globalAlpha = 1;
  let cursor = new Date(base);
  const queued = state.sequence.map(getTarget).filter(Boolean);
  if (!queued.length) {
    ctx.fillStyle = "#91a1aa";
    ctx.font = "12px system-ui";
    ctx.fillText("Queue empty", pad.l + 8, pad.t + 26);
  }
  queued.forEach((target, idx) => {
    const visit = Math.max(0.08, Number(target.visitHours) || 0.25);
    const next = new Date(cursor.getTime() + visit * 3600 * 1000);
    const x0 = xForTime(cursor);
    const x1 = xForTime(next);
    const y0 = pad.t + 12 + (idx % 4) * 22;
    const color = priorityColor(target);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.84;
    ctx.fillRect(x0, y0, Math.max(3, x1 - x0), 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#edf4f7";
    ctx.font = "11px system-ui";
    const label = `${idx + 1}. ${target.targetName}`;
    ctx.fillText(label, Math.min(x0 + 4, w - pad.r - ctx.measureText(label).width), y0 + 11);
    cursor = next;
  });
  ctx.fillStyle = "#91a1aa";
  ctx.font = "11px system-ui";
  for (let step = 0; step <= ALT_PLOT_HOURS; step += 2) {
    const tick = new Date(start.getTime() + step * 3600 * 1000);
    const x = pad.l + step / ALT_PLOT_HOURS * plotW;
    ctx.fillText(localPartsFromUtc(tick, state.meta.timezone).time.slice(0, 5), x - 12, h - 8);
  }
  const total = queued.reduce((sum, t) => sum + (Number(t.visitHours) || 0), 0);
  ctx.fillStyle = "#c9d7de";
  ctx.font = "12px system-ui";
  ctx.fillText(`${queued.length} targets / ${fmt(total, 2)} hr`, pad.l, 12);
}

function drawMiniTwilightBands(ctx, pad, w, h, start) {
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const samples = ALT_PLOT_HOURS * 4;
  const colors = [
    { max: -18, color: "rgba(2, 8, 18, 0.68)" },
    { max: -12, color: "rgba(19, 43, 83, 0.38)" },
    { max: -6, color: "rgba(38, 80, 120, 0.30)" },
    { max: 0, color: "rgba(182, 122, 51, 0.20)" },
    { max: 90, color: "rgba(242, 184, 75, 0.10)" }
  ];
  for (let i = 0; i < samples; i++) {
    const t = new Date(start.getTime() + (i + 0.5) * (ALT_PLOT_HOURS * 3600 * 1000 / samples));
    const sun = sunPosition(t);
    const sunAlt = altAz(sun.raDeg, sun.decDeg, t, LBT.latDeg, LBT.lonDeg).alt;
    const band = colors.find((b) => sunAlt < b.max) || colors[colors.length - 1];
    ctx.fillStyle = band.color;
    ctx.fillRect(pad.l + (i / samples) * plotW, pad.t, plotW / samples + 1, plotH);
  }
}

function sequenceAction(idx, action) {
  const id = state.sequence[idx];
  if (action === "up" && idx > 0) [state.sequence[idx - 1], state.sequence[idx]] = [state.sequence[idx], state.sequence[idx - 1]];
  if (action === "down" && idx < state.sequence.length - 1) [state.sequence[idx + 1], state.sequence[idx]] = [state.sequence[idx], state.sequence[idx + 1]];
  if (action === "remove") state.sequence.splice(idx, 1);
    if (action === "done") {
      updateTarget(id, { status: "observed", observedAt: new Date().toISOString() }, false);
      state.sequence.splice(idx, 1);
  }
  renderAndSave();
}

function renderReadme() {
  const target = getTarget(selectedId);
  const readmes = state.readmes.filter((r) => !target || r.instrument === target.instrument || r.id === target.readmeId);
  const matched = target ? findReadmeForTarget(target) : null;
  const explicitReadme = target?.readmeId ? state.readmes.find((r) => r.id === target.readmeId) : null;
  const selectedReadmeId = explicitReadme && readmeMatchScore(target, explicitReadme) > 1 ? explicitReadme.id : matched?.id || "";
  els.readmeSelect.innerHTML = `<option value="">No readme selected</option>` + readmes
    .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.projectId || r.filename)} (${escapeHtml(r.instrument)})</option>`)
    .join("");
  els.readmeSelect.value = selectedReadmeId;
  const readme = state.readmes.find((r) => r.id === selectedReadmeId);
  if (!readme) {
    els.readmeSummary.innerHTML = target
      ? `<div><b>No matching readme:</b> ${escapeHtml(target.targetName)}</div>`
      : "";
    els.readmeText.textContent = "";
    return;
  }
  els.readmeSummary.innerHTML = [
    ["Project ID", readme.projectId],
    ["Title", readme.title],
    ["Instrument", readme.instrumentRaw || readme.instrument],
    ["PI", readme.pi],
    ["Conditions", readme.conditions]
  ].filter(([, v]) => v).map(([k, v]) => `<div><b>${k}:</b> ${escapeHtml(String(v))}</div>`).join("");
  els.readmeText.textContent = readme.instructions || readme.text || "";
}

function findReadmeForTarget(target) {
  if (target.readmeId) return state.readmes.find((r) => r.id === target.readmeId) || null;
  const candidates = state.readmes.filter((r) => r.instrument === target.instrument);
  let best = null;
  let bestScore = 0;
  for (const readme of candidates) {
    const score = readmeMatchScore(target, readme);
    if (score > bestScore) {
      best = readme;
      bestScore = score;
    }
  }
  return bestScore > 1 ? best : null;
}

function readmeMatchScore(target, readme) {
  const hay = [readme.filename, readme.projectId, readme.title, readme.text].join(" ").toLowerCase();
  const headerHay = [readme.filename, readme.projectId, readme.title].join(" ").toLowerCase();
  const program = String(target.programName || target.partner || "").toLowerCase();
  const name = String(target.targetName || "").toLowerCase();
  let score = 0;
  if (program && tokenMatch(program, program.length < 3 ? headerHay : hay)) score += 4;
  if (name && tokenMatch(name, hay)) score += 3;
  if (readme.instrument === target.instrument) score += 1;
  return score;
}

function partnerForTarget(target) {
  const matched = findReadmeForTarget(target);
  if (matched?.partner) return matched.partner;
  if (target.partner && target.partner !== target.programName) return target.partner;
  return derivePartner(target.programName || target.partner || "");
}

function derivePartner(program) {
  const text = String(program || "").trim();
  if (!text) return "";
  if (text.includes("_")) return text.split("_", 1)[0];
  if (/^[A-Za-z]+-/.test(text)) return text.split("-", 1)[0];
  return text;
}

function tokenMatch(needle, haystack) {
  const clean = String(needle || "").trim().toLowerCase();
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function activeWorkspaceReadme() {
  if (!state.readmes.length) return null;
  const current = state.meta.activeReadmeId;
  const readme = state.readmes.find((r) => r.id === current) || state.readmes[0];
  state.meta.activeReadmeId = readme.id;
  return readme;
}

function renderReadmeIndex() {
  if (!els.readmeIndexList) return;
  els.readmeIndexList.innerHTML = "";
  els.readmeIndexCount.textContent = `${state.readmes.length}`;
  if (!state.readmes.length) {
    els.readmeIndexList.innerHTML = `<div class="emptyCell">No readmes loaded.</div>`;
    return;
  }
  const current = activeWorkspaceReadme();
  const readmes = [...state.readmes].sort((a, b) =>
    instrumentRank(a.instrument) - instrumentRank(b.instrument)
    || String(a.projectId || a.filename).localeCompare(String(b.projectId || b.filename))
  );
  for (const readme of readmes) {
    const btn = document.createElement("button");
    btn.className = readme.id === current?.id ? "active" : "";
    btn.innerHTML = `
      <strong>${escapeHtml(readme.projectId || readme.filename)}</strong>
      <span>${escapeHtml(readme.instrument || "")}</span>
      <small>${escapeHtml(readme.title || readme.filename || "")}</small>`;
    btn.addEventListener("click", () => {
      state.meta.activeReadmeId = readme.id;
      renderReadmeIndex();
      renderReadmeWorkspace();
      scheduleSave();
    });
    els.readmeIndexList.appendChild(btn);
  }
}

function renderReadmeWorkspace() {
  if (!state.readmes.length) {
    els.readmeWorkspaceTitle.textContent = "";
    els.readmeWorkspaceMeta.innerHTML = "";
    els.readmeWorkspaceText.textContent = "";
    els.readmeNotesBox.value = "";
    return;
  }
  const readme = activeWorkspaceReadme();
  if (!readme) return;
  els.readmeWorkspaceTitle.textContent = `${readme.projectId || readme.filename} (${readme.instrument})`;
  els.readmeWorkspaceMeta.innerHTML = [
    ["Project ID", readme.projectId],
    ["Title", readme.title],
    ["Instrument", readme.instrumentRaw || readme.instrument],
    ["PI", readme.pi],
    ["Conditions", readme.conditions],
    ["File", readme.path || readme.filename]
  ].filter(([, v]) => v).map(([k, v]) => `<div><b>${k}:</b> ${escapeHtml(String(v))}</div>`).join("");
  els.readmeWorkspaceText.textContent = readme.text || "";
  els.readmeNotesBox.value = state.readmeNotes[readme.id] || "";
}

function renderPlots() {
  drawAltitudePlot();
  drawAltAzPlot();
  drawSkyPlot();
}

function drawAltitudePlot() {
  const canvas = els.altCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 50, r: 18, t: 24, b: 40 };
  const base = selectedUtc();
  const start = lbtNightWindowStart(base);
  drawTwilightBands(ctx, pad, w, h, start);
  drawGrid(ctx, pad, w, h);
  const queued = state.sequence.map(getTarget).filter(Boolean);
  const targets = uniqueTargets([...queued, ...visibleTargets().slice(0, 14)]);
  const selected = getTarget(selectedId);
  if (selected && !targets.some((t) => t.id === selected.id)) targets.unshift(selected);
  targets.forEach((target) => {
    if (target.raDeg == null || target.decDeg == null) return;
    const isSelected = target.id === selectedId;
    const isQueued = state.sequence.includes(target.id);
    const stroke = priorityColor(target);
    if (isSelected) {
      drawAltTrack(ctx, target, start, pad, w, h, "rgba(255,255,255,0.24)", 9, []);
    }
    if (isQueued && !isSelected) {
      drawAltTrack(ctx, target, start, pad, w, h, "rgba(120,174,247,0.22)", 7, [10, 7]);
    }
    drawAltTrack(ctx, target, start, pad, w, h, stroke, isSelected ? 4 : isQueued ? 3 : 1.6, isQueued && !isSelected ? [10, 7] : []);
    const nowAlt = altAz(target.raDeg, target.decDeg, base, LBT.latDeg, LBT.lonDeg).alt;
    if (Number.isFinite(nowAlt) && nowAlt > 0 && (isSelected || isQueued)) {
      const x = pad.l + ((base - start) / (ALT_PLOT_HOURS * 3600 * 1000)) * (w - pad.l - pad.r);
      const y = pad.t + (1 - clamp(nowAlt, 0, 90) / 90) * (h - pad.t - pad.b);
      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 6 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#edf4f7";
      ctx.font = "13px system-ui";
      const labelWidth = ctx.measureText(target.targetName).width;
      const lx = x + labelWidth + 14 > w - pad.r ? x - labelWidth - 10 : x + 8;
      ctx.fillText(target.targetName, lx, y - 8);
    }
  });
  ctx.setLineDash([]);
  const xNow = pad.l + ((base - start) / (ALT_PLOT_HOURS * 3600 * 1000)) * (w - pad.l - pad.r);
  ctx.strokeStyle = "#ffffff";
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(xNow, pad.t);
  ctx.lineTo(xNow, h - pad.b);
  ctx.stroke();
  ctx.globalAlpha = 1;
  drawPriorityLegend(ctx, pad.l + 8, pad.t + 16);
  ctx.fillStyle = "#91a1aa";
  ctx.font = "13px system-ui";
  for (let step = 0; step <= ALT_PLOT_HOURS; step += 1) {
    const tickDate = new Date(start.getTime() + step * 3600 * 1000);
    const parts = localPartsFromUtc(tickDate, state.meta.timezone);
    const label = parts.time.slice(0, 2);
    const x = pad.l + step / ALT_PLOT_HOURS * (w - pad.l - pad.r);
    ctx.fillText(label, x - 8, h - 12);
    if (Math.abs(step - ALT_PLOT_HOURS / 2) < 0.01) {
      ctx.fillStyle = "rgba(237,244,247,0.75)";
      ctx.fillText("LBT midnight", x - 38, pad.t + 18);
      ctx.fillStyle = "#91a1aa";
    }
  }
  ctx.fillStyle = "rgba(237,244,247,0.72)";
  ctx.fillText("selected: white halo; queued: blue halo/dash", pad.l + 8, pad.t + 34);
  ctx.fillStyle = "#91a1aa";
  ctx.font = "13px system-ui";
  const xLabel = `Time (${timezoneLabel(state.meta.timezone)})`;
  const xLabelWidth = ctx.measureText(xLabel).width;
  ctx.fillText(xLabel, pad.l + (w - pad.l - pad.r - xLabelWidth) / 2, h - 2);
  els.plotTargetLabel.textContent = selected ? `${selected.targetName}; queued ${state.sequence.length}` : "";
}

function timezoneLabel(zone) {
  if (zone === "TUCSON") return "Tucson / MST";
  if (zone === "ET") return "ET";
  if (zone === "BROWSER") return "Browser local";
  return "UTC";
}

function lbtMidnightForSelectedNight(instant) {
  const lbt = localPartsFromUtc(instant, "TUCSON");
  const hour = Number(lbt.time.slice(0, 2));
  const midnight = zonedLocalToUtc(`${lbt.date}T00:00`, "TUCSON");
  return hour >= 12 ? new Date(midnight.getTime() + 24 * 3600 * 1000) : midnight;
}

function priorityColor(target) {
  const p = Number(target.priority);
  if (!Number.isFinite(p)) return "#95a7b2";
  if (p <= 1) return "#ec6a5d";
  if (p <= 2) return "#f2b84b";
  if (p <= 10) return "#66d17a";
  if (p <= 50) return "#3dc7b5";
  return "#78aef7";
}

function drawPriorityLegend(ctx, x, y) {
  const items = [
    ["P1", "#ec6a5d"],
    ["P2", "#f2b84b"],
    ["P<=10", "#66d17a"],
    ["P<=50", "#3dc7b5"],
    ["P>50", "#78aef7"]
  ];
  ctx.font = "12px system-ui";
  let dx = x;
  items.forEach(([label, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(dx, y - 8, 16, 7);
    ctx.fillStyle = "rgba(237,244,247,0.72)";
    ctx.fillText(label, dx + 21, y);
    dx += label.length > 3 ? 76 : 54;
  });
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || canvas.width));
  const height = Math.max(220, Math.round(rect.height || canvas.clientHeight || canvas.height));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, w: width, h: height };
}

function drawTwilightBands(ctx, pad, w, h, start) {
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const colors = [
    { max: -18, color: "rgba(2, 8, 18, 0.58)", label: "Astronomical night" },
    { max: -12, color: "rgba(19, 43, 83, 0.34)", label: "Astronomical twilight" },
    { max: -6, color: "rgba(38, 80, 120, 0.26)", label: "Nautical twilight" },
    { max: 0, color: "rgba(182, 122, 51, 0.18)", label: "Civil twilight" },
    { max: 90, color: "rgba(242, 184, 75, 0.08)", label: "Day" }
  ];
  let lastLabelX = -999;
  const samples = ALT_PLOT_HOURS * 6;
  for (let i = 0; i < samples; i++) {
    const t = new Date(start.getTime() + (i + 0.5) * 10 * 60 * 1000);
    const sun = sunPosition(t);
    const sunAlt = altAz(sun.raDeg, sun.decDeg, t, LBT.latDeg, LBT.lonDeg).alt;
    const band = colors.find((b) => sunAlt < b.max) || colors[colors.length - 1];
    const x = pad.l + (i / samples) * plotW;
    ctx.fillStyle = band.color;
    ctx.fillRect(x, pad.t, plotW / samples + 1, plotH);
    if (i > 0 && [-18, -12, -6, 0].some((level) => Math.abs(sunAlt - level) < 0.35)) {
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
    }
    if (i % 18 === 4 && x - lastLabelX > 120) {
      ctx.fillStyle = "rgba(237,244,247,0.36)";
      ctx.font = "12px system-ui";
      ctx.fillText(band.label.replace(" twilight", ""), x + 4, pad.t + plotH - 10);
      lastLabelX = x;
    }
  }
  const legend = [
    ["Civil", "rgba(182, 122, 51, 0.55)"],
    ["Nautical", "rgba(38, 80, 120, 0.70)"],
    ["Astronomical", "rgba(19, 43, 83, 0.85)"],
    ["Night", "rgba(2, 8, 18, 0.95)"]
  ];
  let lx = w - pad.r - 390;
  ctx.font = "12px system-ui";
  legend.forEach(([label, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, pad.t + 8, 18, 8);
    ctx.fillStyle = "rgba(237,244,247,0.70)";
    ctx.fillText(label, lx + 24, pad.t + 16);
    lx += label === "Astronomical" ? 116 : 88;
  });
}

function drawAltTrack(ctx, target, start, pad, w, h, color, width, dash) {
  ctx.beginPath();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  const samples = ALT_PLOT_HOURS * 6;
  for (let i = 0; i <= samples; i++) {
    const d = new Date(start.getTime() + i * 10 * 60 * 1000);
    const alt = altAz(target.raDeg, target.decDeg, d, LBT.latDeg, LBT.lonDeg).alt;
    const x = pad.l + (i / samples) * (w - pad.l - pad.r);
    const y = pad.t + (1 - clamp(alt, 0, 90) / 90) * (h - pad.t - pad.b);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawAltAzPlot() {
  const canvas = els.altAzCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 42, r: 14, t: 26, b: 34 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const base = selectedUtc();
  const start = lbtNightWindowStart(base);
  const queued = state.sequence.map(getTarget).filter(Boolean);
  const targets = uniqueTargets([...queued, ...visibleTargets().slice(0, 14)]);
  const selected = getTarget(selectedId);
  if (selected && !targets.some((t) => t.id === selected.id)) targets.unshift(selected);

  ctx.strokeStyle = "#273443";
  ctx.fillStyle = "#91a1aa";
  ctx.font = "12px system-ui";
  [0, 30, 60, 90].forEach((alt) => {
    const y = altAzY(alt, pad, h);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(alt), 8, y + 4);
  });
  [0, 90, 180, 270, 360].forEach((az) => {
    const x = altAzX(az, pad, w);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.fillText(["N", "E", "S", "W", "N"][az / 90], x - 5, h - 12);
  });
  ctx.strokeStyle = "rgba(242,184,75,0.78)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(pad.l, altAzY(30, pad, h));
  ctx.lineTo(w - pad.r, altAzY(30, pad, h));
  ctx.stroke();
  ctx.setLineDash([]);

  targets.forEach((target) => {
    if (target.raDeg == null || target.decDeg == null) return;
    const isSelected = target.id === selectedId;
    const isQueued = state.sequence.includes(target.id);
    drawAltAzTrack(ctx, target, start, pad, w, h, priorityColor(target), isSelected ? 3.8 : isQueued ? 2.8 : 1.5, isQueued && !isSelected ? [8, 6] : []);
    const m = metricsCache.get(target.id) || {};
    if (Number.isFinite(m.alt) && m.alt > 0) {
      const x = altAzX(m.az, pad, w);
      const y = altAzY(m.alt, pad, h);
      ctx.fillStyle = priorityColor(target);
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 5.5 : isQueued ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  });
  ctx.strokeStyle = "#edf4f7";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);
  ctx.fillStyle = "#91a1aa";
  ctx.font = "12px system-ui";
  ctx.fillText("Azimuth", pad.l + plotW / 2 - 22, h - 2);
  ctx.save();
  ctx.translate(12, pad.t + plotH / 2 + 24);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Altitude", 0, 0);
  ctx.restore();
}

function drawAltAzTrack(ctx, target, start, pad, w, h, color, width, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  const samples = ALT_PLOT_HOURS * 6;
  let penDown = false;
  for (let i = 0; i <= samples; i++) {
    const d = new Date(start.getTime() + i * 10 * 60 * 1000);
    const pos = altAz(target.raDeg, target.decDeg, d, LBT.latDeg, LBT.lonDeg);
    if (pos.alt <= 0) {
      penDown = false;
      continue;
    }
    const x = altAzX(pos.az, pad, w);
    const y = altAzY(pos.alt, pad, h);
    if (!penDown) {
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function altAzX(azDeg, pad, w) {
  return pad.l + mod(azDeg, 360) / 360 * (w - pad.l - pad.r);
}

function altAzY(altDeg, pad, h) {
  return pad.t + (1 - clamp(altDeg, 0, 90) / 90) * (h - pad.t - pad.b);
}

function uniqueTargets(targets) {
  const out = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    out.push(target);
  }
  return out;
}

function drawSkyPlot() {
  const canvas = els.skyCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const cx = w / 2;
  const cy = h / 2 + 8;
  const r = Math.min(w, h) * 0.42;
  ctx.strokeStyle = "#273443";
  ctx.lineWidth = 1;
  [0.33, 0.66, 1].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.strokeStyle = "rgba(242,184,75,0.85)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(cx, cy, r * (1 - 30 / 90), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#91a1aa";
  ctx.font = "12px system-ui";
  [["N", 0, -1], ["E", -1, 0], ["S", 0, 1], ["W", 1, 0]].forEach(([lab, dx, dy]) => {
    ctx.fillText(lab, cx + dx * (r + 10) - 4, cy + dy * (r + 14) + 4);
  });
  const skyPoint = (target) => {
    const m = metricsCache.get(target.id) || {};
    if (!Number.isFinite(m.alt) || m.alt <= 0) return null;
    const rr = r * (1 - m.alt / 90);
    const theta = rad(m.az);
    return { x: cx - rr * Math.sin(theta), y: cy - rr * Math.cos(theta), target };
  };
  const sequencePoints = state.sequence.map(getTarget).filter(Boolean).map(skyPoint).filter(Boolean);
  if (sequencePoints.length > 1) {
    ctx.strokeStyle = "rgba(120,174,247,0.82)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    sequencePoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  visibleTargets().slice(0, 80).forEach((target) => {
    const m = metricsCache.get(target.id) || {};
    if (!Number.isFinite(m.alt) || m.alt <= 0) return;
    const rr = r * (1 - m.alt / 90);
    const theta = rad(m.az);
    const x = cx - rr * Math.sin(theta);
    const y = cy - rr * Math.cos(theta);
    const isSelected = target.id === selectedId;
    const isQueued = state.sequence.includes(target.id);
    ctx.fillStyle = priorityColor(target);
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 7 : isQueued ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    if (isSelected || isQueued) {
      ctx.strokeStyle = isSelected ? "rgba(242,184,75,0.35)" : "rgba(120,174,247,0.35)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 12 : 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  sequencePoints.forEach((p, idx) => {
    ctx.fillStyle = "#071014";
    ctx.strokeStyle = priorityColor(p.target);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#edf4f7";
    ctx.font = "11px system-ui";
    const label = String(idx + 1);
    ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 4);
  });
}

function fillCanvas(ctx, w, h) {
  ctx.fillStyle = "#0b1118";
  ctx.fillRect(0, 0, w, h);
}

function drawGrid(ctx, pad, w, h) {
  ctx.strokeStyle = "#273443";
  ctx.fillStyle = "#91a1aa";
  ctx.font = "14px system-ui";
  [0, 20, 40, 60, 80].forEach((alt) => {
    const y = pad.t + (1 - alt / 90) * (h - pad.t - pad.b);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(alt), 8, y + 4);
  });
  const yAirmass2 = pad.t + (1 - 30 / 90) * (h - pad.t - pad.b);
  ctx.strokeStyle = "rgba(242,184,75,0.78)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(pad.l, yAirmass2);
  ctx.lineTo(w - pad.r, yAirmass2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function renderAtmDisp() {
  if (!els.atmCanvas) return;
  const target = getTarget(selectedId);
  const atm = state.meta.atm || {};
  const defaults = {
    atmSlitAngle: "0",
    atmGuideWave: "0.62",
    atmBlueWave: "0.35",
    atmRedWave: "1.00",
    atmSeeing: "0.8",
    atmSlitWidth: "1.0"
  };
  Object.entries(defaults).forEach(([id, value]) => {
    if (!els[id].matches(":focus")) els[id].value = atm[id] ?? value;
  });
  if (!els.atmSlitSlider.matches(":focus")) syncSlitPaControls(els.atmSlitAngle.value);
  if (!target || target.raDeg == null || target.decDeg == null) {
    els.atmTargetLabel.textContent = "Select a target with RA/Dec";
    els.atmStats.innerHTML = "";
    drawAtmAltPaCanvas(null);
    drawAtmDispTimeCanvas(null);
    drawAtmCanvas(null);
    drawAtmLossCanvas(null);
    return;
  }
  const date = selectedUtc();
  const pos = altAz(target.raDeg, target.decDeg, date, LBT.latDeg, LBT.lonDeg);
  const pa = parallacticAngle(target.raDeg, target.decDeg, date);
  const slit = Number(els.atmSlitAngle.value) || 0;
  const guide = Number(els.atmGuideWave.value) || 0.62;
  const blue = Number(els.atmBlueWave.value) || 0.35;
  const red = Number(els.atmRedWave.value) || 1.0;
  const seeing = Number(els.atmSeeing.value) || 0.8;
  const slitWidth = Number(els.atmSlitWidth.value) || 1.0;
  const z = clamp(90 - pos.alt, 0, 88);
  const blueOffset = differentialRefractionArcsec(blue, guide, z);
  const redOffset = differentialRefractionArcsec(red, guide, z);
  const offset = wrap180(slit - pa);
  const slitLossRisk = Math.abs(Math.sin(rad(offset))) * Math.max(Math.abs(blueOffset), Math.abs(redOffset));
  els.atmTargetLabel.textContent = target.targetName;
  els.atmStats.innerHTML = [
    ["Elevation", `${fmt(pos.alt)} deg`],
    ["Airmass", fmt(pos.airmass, 2)],
    ["Parallactic PA", `${fmt(pa)} deg`],
    ["Slit minus parallactic", `${fmt(offset)} deg`],
    [`${blue.toFixed(2)}-${guide.toFixed(2)} micron`, `${fmt(blueOffset, 2)} arcsec`],
    [`${red.toFixed(2)}-${guide.toFixed(2)} micron`, `${fmt(redOffset, 2)} arcsec`],
    ["Perpendicular spread", `${fmt(slitLossRisk, 2)} arcsec`]
  ].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join("");
  const model = { pa, slit, blueOffset, redOffset, guide, blue, red, target, pos, seeing, slitWidth, offset };
  drawAtmAltPaCanvas(model);
  drawAtmDispTimeCanvas(model);
  drawAtmCanvas(model);
  drawAtmLossCanvas(model);
}

function drawAtmAltPaCanvas(model) {
  const canvas = els.atmAltPaCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 46, r: 44, t: 34, b: 34 };
  drawAtmFrame(ctx, pad, w, h, "Altitude & parallactic angle vs UT");
  if (!model) return;
  const rows = atmTimeRows(model.target);
  const start = lbtNightWindowStart(selectedUtc());
  const xFor = (date) => pad.l + (date - start) / (ALT_PLOT_HOURS * 3600 * 1000) * (w - pad.l - pad.r);
  const altY = (alt) => pad.t + (1 - clamp(alt, 0, 90) / 90) * (h - pad.t - pad.b);
  const paY = (pa) => pad.t + (1 - mod(pa, 360) / 360) * (h - pad.t - pad.b);
  drawSimpleSeries(ctx, rows, (r) => xFor(r.date), (r) => altY(r.alt), "#66d17a", 2.5, []);
  drawSimpleSeries(ctx, rows, (r) => xFor(r.date), (r) => paY(r.pa), "#f2b84b", 2.2, [9, 6]);
  drawSelectedTimeMarker(ctx, pad, w, h, start);
  ctx.fillStyle = "#66d17a";
  ctx.fillText("alt", pad.l + 10, pad.t + 18);
  ctx.fillStyle = "#f2b84b";
  ctx.fillText("parallactic PA", pad.l + 48, pad.t + 18);
  ctx.fillStyle = "#91a1aa";
  [0, 30, 60, 90].forEach((v) => ctx.fillText(String(v), 12, altY(v) + 4));
  [0, 180, 360].forEach((v) => ctx.fillText(String(v), w - pad.r + 8, paY(v) + 4));
  drawAtmTimeTicks(ctx, pad, w, h, start);
}

function drawAtmDispTimeCanvas(model) {
  const canvas = els.atmDispTimeCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 50, r: 18, t: 34, b: 34 };
  drawAtmFrame(ctx, pad, w, h, "Dispersion vs UT");
  if (!model) return;
  const rows = atmTimeRows(model.target);
  const start = lbtNightWindowStart(selectedUtc());
  const waves = atmWaveSet(model);
  const maxDisp = Math.max(0.5, ...rows.flatMap((row) => waves.map((wave) => Math.abs(differentialRefractionArcsec(wave, model.guide, clamp(90 - row.alt, 0, 88))))));
  const yMax = Math.min(12, Math.max(1, Math.ceil(maxDisp * 1.2)));
  const xFor = (date) => pad.l + (date - start) / (ALT_PLOT_HOURS * 3600 * 1000) * (w - pad.l - pad.r);
  const yFor = (arcsec) => pad.t + (1 - clamp(arcsec, 0, yMax) / yMax) * (h - pad.t - pad.b);
  waves.forEach((wave, idx) => {
    drawSimpleSeries(ctx, rows, (r) => xFor(r.date), (r) => yFor(Math.abs(differentialRefractionArcsec(wave, model.guide, clamp(90 - r.alt, 0, 88)))), waveColor(idx), 2, idx % 2 ? [8, 5] : []);
    ctx.fillStyle = waveColor(idx);
    ctx.fillText(`${wave.toFixed(2)}`, pad.l + 10 + idx * 46, pad.t + 18);
  });
  drawSelectedTimeMarker(ctx, pad, w, h, start);
  ctx.fillStyle = "#91a1aa";
  [0, yMax / 2, yMax].forEach((v) => ctx.fillText(fmt(v, 1), 10, yFor(v) + 4));
  drawAtmTimeTicks(ctx, pad, w, h, start);
}

function drawAtmCanvas(model) {
  const canvas = els.atmCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const leftW = Math.min(330, w * 0.42);
  const cx = leftW / 2;
  const cy = h / 2 + 12;
  const skyR = Math.min(120, leftW * 0.36, h * 0.32);
  const skyScale = skyR / ATM_DISPLAY_LIMIT_ARCSEC;
  ctx.strokeStyle = "#273443";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, skyR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#91a1aa";
  ctx.font = "14px system-ui";
  ctx.fillText("N", cx - 5, cy - skyR - 18);
  ctx.fillText("E", cx + skyR + 14, cy + 5);
  ctx.fillText(`${ATM_DISPLAY_LIMIT_ARCSEC}"`, cx + skyR - 18, cy + skyR + 18);
  if (!model) return;
  drawPaLine(ctx, cx, cy, model.pa, skyR + 22, "#f2b84b", 3, []);
  drawSlitFootprint(ctx, cx, cy, model.slit, skyR + 18, model.slitWidth * skyScale, "#78aef7");
  drawSeeingCircle(ctx, cx, cy, Math.max(2, model.seeing * skyScale / 2));
  const theta = rad(model.pa);
  const bluePlotOffset = clamp(model.blueOffset, -ATM_DISPLAY_LIMIT_ARCSEC, ATM_DISPLAY_LIMIT_ARCSEC);
  const redPlotOffset = clamp(model.redOffset, -ATM_DISPLAY_LIMIT_ARCSEC, ATM_DISPLAY_LIMIT_ARCSEC);
  const bx = cx + Math.sin(theta) * bluePlotOffset * skyScale;
  const by = cy - Math.cos(theta) * bluePlotOffset * skyScale;
  const rx = cx + Math.sin(theta) * redPlotOffset * skyScale;
  const ry = cy - Math.cos(theta) * redPlotOffset * skyScale;
  ctx.strokeStyle = "#ec6a5d";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.fillStyle = "#ec6a5d";
  ctx.beginPath();
  ctx.arc(bx, by, 6, 0, Math.PI * 2);
  ctx.arc(rx, ry, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#edf4f7";
  ctx.font = "15px system-ui";
  ctx.fillText("Sky plane", 24, 28);
  ctx.font = "13px system-ui";
  ctx.fillText("parallactic", 24, 52);
  ctx.fillStyle = "#f2b84b";
  ctx.fillRect(118, 44, 36, 4);
  ctx.fillStyle = "#edf4f7";
  ctx.fillText("along slit", 24, 76);
  ctx.strokeStyle = "#78aef7";
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(118, 70);
  ctx.lineTo(154, 70);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#edf4f7";
  ctx.fillText("seeing FWHM", 24, 100);
  ctx.strokeStyle = "rgba(102,209,122,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(140, 96, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#edf4f7";
  ctx.fillText("dispersion vector", 24, 124);
  ctx.fillStyle = "#ec6a5d";
  ctx.fillRect(160, 118, 36, 4);
  drawDispersionChart(ctx, model, leftW + 28, 38, w - leftW - 48, h - 76);
}

function drawDispersionChart(ctx, model, x0, y0, width, height) {
  const slitDelta = rad(wrap180(model.slit - model.pa));
  const waves = [];
  for (let i = 0; i <= 80; i++) waves.push(0.32 + i * (1.08 - 0.32) / 80);
  const z = clamp(90 - model.pos.alt, 0, 88);
  const rows = waves.map((wave) => {
    const d = differentialRefractionArcsec(wave, model.guide, z);
    return {
      wave,
      along: d * Math.cos(slitDelta),
      perp: d * Math.sin(slitDelta)
    };
  });
  const yMax = ATM_DISPLAY_LIMIT_ARCSEC;
  ctx.fillStyle = "#0b1118";
  ctx.fillRect(x0, y0, width, height);
  const xFor = (wave) => x0 + (wave - 0.32) / (1.08 - 0.32) * width;
  const yPixelsPerArcsec = height * 0.46 / yMax;
  const yFor = (arcsec) => y0 + height / 2 - clamp(arcsec, -yMax, yMax) / yMax * (height * 0.46);
  ctx.fillStyle = "rgba(120,174,247,0.11)";
  ctx.fillRect(x0, yFor(model.slitWidth / 2), width, yFor(-model.slitWidth / 2) - yFor(model.slitWidth / 2));
  ctx.fillStyle = "rgba(102,209,122,0.10)";
  ctx.fillRect(x0, yFor(model.seeing / 2), width, yFor(-model.seeing / 2) - yFor(model.seeing / 2));
  ctx.strokeStyle = "#273443";
  ctx.lineWidth = 1;
  for (let y = -yMax; y <= yMax; y += 0.5) {
    const yy = yFor(y);
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(x0 + width, yy);
    ctx.stroke();
  }
  [0.35, 0.5, 0.62, 0.8, 1.0].forEach((wave) => {
    const xx = xFor(wave);
    ctx.beginPath();
    ctx.moveTo(xx, y0);
    ctx.lineTo(xx, y0 + height);
    ctx.stroke();
  });
  ctx.strokeStyle = "#edf4f7";
  ctx.strokeRect(x0, y0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, width, height);
  ctx.clip();
  drawChartSeeingCircles(ctx, [0.4, 0.6, 0.8, 1.0], xFor, yFor, model, slitDelta, z, yPixelsPerArcsec);
  plotSeries(ctx, rows, xFor, yFor, "perp", "#ec6a5d", 3, []);
  plotSeries(ctx, rows, xFor, yFor, "along", "#f2b84b", 2.5, [12, 8]);
  ctx.restore();
  ctx.fillStyle = "#edf4f7";
  ctx.font = "15px system-ui";
  ctx.fillText("Differential refraction relative to guide wavelength", x0, y0 - 12);
  ctx.font = "13px system-ui";
  ctx.fillStyle = "#ec6a5d";
  ctx.fillText("perpendicular to slit", x0 + 14, y0 + 22);
  ctx.strokeStyle = "#ec6a5d";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x0 + 142, y0 + 18);
  ctx.lineTo(x0 + 172, y0 + 18);
  ctx.stroke();
  ctx.fillStyle = "#f2b84b";
  ctx.fillText("along slit", x0 + 190, y0 + 22);
  ctx.strokeStyle = "#f2b84b";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([12, 8]);
  ctx.beginPath();
  ctx.moveTo(x0 + 258, y0 + 18);
  ctx.lineTo(x0 + 292, y0 + 18);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#66d17a";
  ctx.fillText("seeing", x0 + 312, y0 + 22);
  ctx.strokeStyle = "rgba(102,209,122,0.88)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x0 + 362, y0 + 18, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#91a1aa";
  ctx.fillText("wavelength (micron)", x0 + width / 2 - 52, y0 + height + 30);
  ctx.save();
  ctx.translate(x0 - 36, y0 + height / 2 + 48);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("offset (arcsec)", 0, 0);
  ctx.restore();
  ctx.fillStyle = "#91a1aa";
  [0.35, 0.5, 0.62, 0.8, 1.0].forEach((wave) => ctx.fillText(wave.toFixed(2), xFor(wave) - 12, y0 + height + 16));
  [-5, -2.5, 0, 2.5, 5].forEach((val) => {
    if (Math.abs(val) <= yMax) ctx.fillText(String(val), x0 - 24, yFor(val) + 4);
  });
}

function drawAtmLossCanvas(model) {
  const canvas = els.atmLossCanvas;
  const { ctx, w, h } = setupCanvas(canvas);
  fillCanvas(ctx, w, h);
  const pad = { l: 48, r: 18, t: 34, b: 38 };
  drawAtmFrame(ctx, pad, w, h, "Slit loss");
  if (!model) return;
  const slitDelta = rad(wrap180(model.slit - model.pa));
  const z = clamp(90 - model.pos.alt, 0, 88);
  const rows = [];
  for (let i = 0; i <= 100; i++) {
    const wave = 0.32 + i * (1.08 - 0.32) / 100;
    const d = differentialRefractionArcsec(wave, model.guide, z);
    const offset = Math.abs(d * Math.sin(slitDelta));
    rows.push({ wave, fraction: slitThroughputFraction(offset, model.seeing, model.slitWidth) });
  }
  const xFor = (wave) => pad.l + (wave - 0.32) / (1.08 - 0.32) * (w - pad.l - pad.r);
  const yFor = (frac) => pad.t + (1 - clamp(frac, 0, 1)) * (h - pad.t - pad.b);
  ctx.fillStyle = "rgba(236,106,93,0.12)";
  ctx.fillRect(pad.l, yFor(0.8), w - pad.l - pad.r, h - pad.b - yFor(0.8));
  drawSimpleSeries(ctx, rows, (r) => xFor(r.wave), (r) => yFor(r.fraction), "#66d17a", 3, []);
  const guideFrac = slitThroughputFraction(0, model.seeing, model.slitWidth);
  ctx.strokeStyle = "rgba(242,184,75,0.78)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(pad.l, yFor(guideFrac));
  ctx.lineTo(w - pad.r, yFor(guideFrac));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#91a1aa";
  [0, 0.5, 1].forEach((v) => ctx.fillText(v.toFixed(1), 12, yFor(v) + 4));
  [0.35, 0.5, 0.62, 0.8, 1.0].forEach((wave) => ctx.fillText(wave.toFixed(2), xFor(wave) - 12, h - 12));
  ctx.fillText("wavelength (micron)", pad.l + (w - pad.l - pad.r) / 2 - 56, h - 2);
}

function drawAtmFrame(ctx, pad, w, h, title) {
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  ctx.strokeStyle = "#273443";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + i / 4 * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + i / 4 * plotW;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
  }
  ctx.strokeStyle = "#edf4f7";
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);
  ctx.fillStyle = "#edf4f7";
  ctx.font = "14px system-ui";
  ctx.fillText(title, pad.l, 20);
  ctx.font = "12px system-ui";
}

function drawSimpleSeries(ctx, rows, xFor, yFor, color, width, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  rows.forEach((row) => {
    const x = xFor(row);
    const y = yFor(row);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      started = false;
      return;
    }
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function atmTimeRows(target) {
  const start = lbtNightWindowStart(selectedUtc());
  const rows = [];
  for (let i = 0; i <= ALT_PLOT_HOURS * 4; i++) {
    const date = new Date(start.getTime() + i * 15 * 60 * 1000);
    const pos = altAz(target.raDeg, target.decDeg, date, LBT.latDeg, LBT.lonDeg);
    rows.push({ date, alt: pos.alt, pa: parallacticAngle(target.raDeg, target.decDeg, date), airmass: pos.airmass });
  }
  return rows;
}

function drawSelectedTimeMarker(ctx, pad, w, h, start) {
  const x = pad.l + (selectedUtc() - start) / (ALT_PLOT_HOURS * 3600 * 1000) * (w - pad.l - pad.r);
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x, pad.t);
  ctx.lineTo(x, h - pad.b);
  ctx.stroke();
}

function drawAtmTimeTicks(ctx, pad, w, h, start) {
  ctx.fillStyle = "#91a1aa";
  ctx.font = "12px system-ui";
  for (let step = 0; step <= ALT_PLOT_HOURS; step += 2) {
    const date = new Date(start.getTime() + step * 3600 * 1000);
    const label = pad2(date.getUTCHours());
    const x = pad.l + step / ALT_PLOT_HOURS * (w - pad.l - pad.r);
    ctx.fillText(label, x - 7, h - 12);
  }
  ctx.fillText("UT hour", pad.l + (w - pad.l - pad.r) / 2 - 18, h - 2);
}

function atmWaveSet(model) {
  const waves = [model.blue, 0.45, model.guide, 0.8, model.red]
    .filter((v) => Number.isFinite(v) && v >= 0.32 && v <= 1.1)
    .sort((a, b) => a - b);
  return [...new Set(waves.map((v) => Number(v.toFixed(2))))];
}

function waveColor(idx) {
  return ["#ec6a5d", "#f2b84b", "#66d17a", "#3dc7b5", "#78aef7", "#d78df0"][idx % 6];
}

function slitThroughputFraction(offsetArcsec, seeingFwhm, slitWidth) {
  const sigma = Math.max(0.05, seeingFwhm / 2.35482);
  const half = Math.max(0.05, slitWidth / 2);
  const root2 = Math.sqrt(2) * sigma;
  return clamp(0.5 * (erfApprox((half - offsetArcsec) / root2) - erfApprox((-half - offsetArcsec) / root2)), 0, 1);
}

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

function plotSeries(ctx, rows, xFor, yFor, key, color, width, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  rows.forEach((row, i) => {
    const x = xFor(row.wave);
    const y = yFor(row[key]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawChartSeeingCircles(ctx, waves, xFor, yFor, model, slitDelta, zDeg, yPixelsPerArcsec) {
  const radius = Math.max(4, model.seeing * yPixelsPerArcsec / 2);
  ctx.fillStyle = "rgba(102,209,122,0.08)";
  ctx.strokeStyle = "rgba(102,209,122,0.88)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  waves.forEach((wave) => {
    const d = differentialRefractionArcsec(wave, model.guide, zDeg);
    const perp = d * Math.sin(slitDelta);
    ctx.beginPath();
    ctx.arc(xFor(wave), yFor(perp), radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function drawSlitFootprint(ctx, cx, cy, paDeg, length, widthPx, color) {
  const theta = rad(paDeg);
  const dx = Math.sin(theta) * length;
  const dy = -Math.cos(theta) * length;
  const px = Math.cos(theta) * widthPx / 2;
  const py = Math.sin(theta) * widthPx / 2;
  ctx.strokeStyle = "rgba(120,174,247,0.35)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  [-1, 1].forEach((side) => {
    ctx.beginPath();
    ctx.moveTo(cx - dx + side * px, cy - dy + side * py);
    ctx.lineTo(cx + dx + side * px, cy + dy + side * py);
    ctx.stroke();
  });
  drawPaLine(ctx, cx, cy, paDeg, length, color, 4, [12, 8]);
}

function drawSeeingCircle(ctx, cx, cy, radiusPx) {
  ctx.strokeStyle = "rgba(102,209,122,0.85)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPaLine(ctx, cx, cy, paDeg, length, color, width, dash) {
  const theta = rad(paDeg);
  const dx = Math.sin(theta) * length;
  const dy = -Math.cos(theta) * length;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(cx - dx, cy - dy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();
  ctx.setLineDash([]);
}

function parallacticAngle(raDeg, decDeg, date) {
  const lst = localSiderealTime(date, LBT.lonDeg);
  const ha = rad(mod(lst - raDeg + 180, 360) - 180);
  const lat = rad(LBT.latDeg);
  const dec = rad(decDeg);
  return mod(deg(Math.atan2(Math.sin(ha), Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha))), 360);
}

function differentialRefractionArcsec(wave, guideWave, zDeg) {
  const atmScale = Math.exp(-LBT_ELEVATION_M / 8400) * 288 / (273 + ATM_TEMP_C);
  const primary = 6085 * (1 / (146 - Math.pow(wave, -2)) - 1 / (146 - Math.pow(guideWave, -2)));
  const secondary = 52.6 * (1 / (41 - Math.pow(wave, -2)) - 1 / (41 - Math.pow(guideWave, -2)));
  return atmScale * Math.tan(rad(zDeg)) * primary + secondary;
}

function wrap180(x) {
  return mod(x + 180, 360) - 180;
}

function updateTarget(id, patch, doRender = true) {
  const target = getTarget(id);
  if (!target) return;
  Object.assign(target, patch);
  if (patch.status !== undefined && ["observed", "done", "skip"].includes(String(patch.status).toLowerCase())) {
    state.sequence = state.sequence.filter((x) => x !== id);
  }
  if (doRender) renderAndSave();
}

function makeStatusExport() {
  return {
    kind: "lbt-status-exchange",
    exportedAt: new Date().toISOString(),
    statuses: state.targets.map((t) => ({
      id: t.id,
      instrument: t.instrument,
      targetName: t.targetName,
      raDeg: t.raDeg,
      decDeg: t.decDeg,
      status: t.status || "",
      notes: t.notes || "",
      observedAt: t.observedAt || "",
      priority: t.priority ?? null,
      prioritySource: t.prioritySource || "",
      manualOrder: t.manualOrder ?? null,
      readmeId: t.readmeId || "",
      queued: state.sequence.includes(t.id)
    }))
  };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  if (file.name.toLowerCase().endsWith(".csv")) {
    importCsv(text, file.name);
  } else {
    importJson(JSON.parse(text));
  }
  event.target.value = "";
  renderAndSave();
}

function importJson(data) {
  if (Array.isArray(data.statuses) || data.kind === "lbt-status-exchange") {
    const rows = data.statuses || [];
    rows.forEach((row) => {
      const target = state.targets.find((t) => t.id === row.id) || state.targets.find((t) =>
        t.instrument === row.instrument && t.targetName === row.targetName);
      if (target) Object.assign(target, {
        status: row.status || "",
        notes: row.notes || target.notes || "",
        observedAt: row.observedAt || "",
        priority: row.priority ?? target.priority,
        prioritySource: row.prioritySource || target.prioritySource || "",
        manualOrder: row.manualOrder ?? target.manualOrder,
        readmeId: row.readmeId || target.readmeId || ""
      });
      if (target && row.queued === true && !state.sequence.includes(target.id)) state.sequence.push(target.id);
      if (target && row.queued === false) state.sequence = state.sequence.filter((id) => id !== target.id);
      if (target && String(target.status).toLowerCase() === "queued") {
        if (!state.sequence.includes(target.id)) state.sequence.push(target.id);
        target.status = "";
      }
    });
    return;
  }
  if (Array.isArray(data.targets)) {
    state.targets = mergeByIdentity([...state.targets, ...data.targets]);
    return;
  }
  if (data.targets_by_instrument) {
    const newTargets = [];
    Object.entries(data.targets_by_instrument).forEach(([instrument, rows]) => {
      rows.forEach((row) => newTargets.push(targetFromScraperRow(row, instrument, "browser-json")));
    });
    state.targets = mergeByIdentity([...state.targets, ...newTargets]);
  }
}

function importCsv(text, filename) {
  const rows = parseCsv(text);
  const inst = (filename.match(/_(MODS|LBC|LUCI|PEPSI|SHARK|P-POL)/i)?.[1] || state.meta.activeInstrument || "Unknown").toUpperCase();
  const targets = rows.map((row) => targetFromScraperRow(row, inst, `browser-csv:${filename}`));
  state.targets = mergeByIdentity([...state.targets, ...targets]);
}

function targetFromScraperRow(row, instrument, source) {
  const raDeg = parseRa(row.ra || row.RA || row.raText);
  const decDeg = parseDec(row.dec || row.Dec || row.decText);
  const name = row.target_name || row.targetName || row.object || "Unknown";
  return {
    id: hash(`${source}|${instrument}|${name}|${raDeg}|${decDeg}`),
    source,
    instrument: normalizeInstrument(row.instrument || instrument),
    displayInstrument: normalizeInstrument(row.instrument || instrument),
    targetName: name,
    programName: row.program_name || row.programName || "",
    partner: row.partner || row.Partner || derivePartner(row.program_name || row.programName || ""),
    priority: toNum(row.priority),
    prioritySource: "browser-import",
    status: "",
    raDeg,
    decDeg,
    raText: degToHms(raDeg),
    decText: degToDms(decDeg),
    visitHours: toNum(row.duration) > 10 ? toNum(row.duration) / 60 : toNum(row.duration),
    haLimitHours: null,
    notes: "",
    readmeId: "",
    readmeLink: row.readme_link || "",
    observedAt: ""
  };
}

function mergeByIdentity(targets) {
  const byKey = new Map();
  targets.forEach((target) => {
    const key = targetIdentity(target);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, target);
    } else if (targetSourceRank(target.source) >= targetSourceRank(current.source)) {
      byKey.set(key, mergeTargetRecords(current, target));
    } else {
      byKey.set(key, mergeTargetRecords(target, current));
    }
  });
  return [...byKey.values()];
}

function mergeTargetRecords(older, newer) {
  const merged = { ...newer };
  ["status", "notes", "observedAt", "manualOrder", "readmeId", "prioritySource"].forEach((key) => {
    if (![null, undefined, ""].includes(older?.[key]) && [null, undefined, ""].includes(newer?.[key])) {
      merged[key] = older[key];
    }
  });
  if (![null, undefined, ""].includes(older?.priority) && [null, undefined, ""].includes(newer?.priority)) {
    merged.priority = older.priority;
  }
  return merged;
}

function targetIdentity(target) {
  const instrument = normalizeInstrument(target.instrument);
  const name = String(target.targetName || "").trim().toLowerCase();
  const program = String(target.programName || "").trim().toLowerCase();
  if (name && name !== "unknown") return [instrument, program, name].join("|");
  const ra = Number.isFinite(Number(target.raDeg)) ? Number(target.raDeg).toFixed(2) : "-999.00";
  const dec = Number.isFinite(Number(target.decDeg)) ? Number(target.decDeg).toFixed(2) : "-999.00";
  return [instrument, program, ra, dec].join("|");
}

function targetSourceRank(source) {
  const text = String(source || "");
  const date = text.match(/(\d{4})_(\d{2})_(\d{2})/);
  const dateRank = date ? Number(`${date[1]}${date[2]}${date[3]}`) : 0;
  let kindRank = 1;
  if (text.startsWith("json:")) kindRank = 3;
  else if (text.startsWith("csv:")) kindRank = 2;
  else if (text.startsWith("browser-json")) kindRank = 1;
  else if (text.startsWith("browser-csv")) kindRank = 0;
  return dateRank * 10 + kindRank;
}

async function rebuildFromFiles() {
  const res = await fetch("/api/rebuild");
  state = await res.json();
  applyDefaults();
  renderAndSave();
}

async function runScraper() {
  if (!confirm(`Run the Selenium scraper for ${state.meta.date}? This may open ChromeDriver and contact the OSURC queue page.`)) return;
  els.scrapeLog.style.display = "block";
  els.scrapeLog.textContent = "Running scraper...";
  const res = await fetch("/api/run-scraper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: state.meta.date })
  });
  const data = await res.json();
  els.scrapeLog.textContent = `${data.ok ? "Done" : "Failed"}\n\n${data.stdout || ""}\n${data.stderr || data.error || ""}`;
  if (data.state) {
    state = data.state;
    applyDefaults();
    renderAndSave();
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(false), 500);
}

async function saveState(show) {
  const res = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  const data = await res.json();
  if (data.updatedAt) state.updatedAt = data.updatedAt;
  els.stateStamp.textContent = show ? `Saved: ${state.updatedAt}` : `Autosaved: ${state.updatedAt}`;
}

function isObserved(t) {
  return (t.status || "").toLowerCase() === "observed" || (t.status || "").toLowerCase() === "done";
}

function isDone(t) {
  return isObserved(t) || (t.status || "").toLowerCase() === "skip";
}

function statusBadge(status, queued = false) {
  const s = (status || "todo").toLowerCase();
  const cls = s === "done" ? "observed" : s;
  const queue = queued ? `<span class="badge queued">queued</span>` : "";
  return `${queue}<span class="badge ${escapeHtml(cls)}">${escapeHtml(s)}</span>`;
}

function coordLine(t) {
  return `${t.raText || degToHms(t.raDeg)} ${t.decText || degToDms(t.decDeg)}`.trim();
}

function raShort(t) {
  const text = t.raText || degToHms(t.raDeg);
  return text.split(":").slice(0, 2).join(":");
}

function decShort(t) {
  const text = t.decText || degToDms(t.decDeg);
  return text.split(":").slice(0, 2).join(":");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pad2(x) {
  return String(x).padStart(2, "0");
}

function hoursLabel(hours) {
  if (!Number.isFinite(hours)) return "";
  let total = Math.round(mod(hours, 24) * 3600);
  if (total >= 86400) total -= 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function normalizeInstrument(v) {
  const s = String(v || "").toUpperCase();
  if (s.includes("LUCI")) return "LUCI";
  if (s.includes("LBC")) return "LBC";
  if (s.includes("PEPSI")) return "PEPSI";
  if (s.includes("MODS")) return "MODS";
  if (s.includes("SHARK")) return "SHARK-V";
  if (s.includes("P-POL")) return "P-POL";
  return String(v || "Unknown");
}

function parseRa(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    return 15 * (p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600);
  }
  const x = Number(s);
  if (!Number.isFinite(x)) return null;
  const h = Math.trunc(Math.abs(x));
  const m = (Math.abs(x) - h) * 100;
  return 15 * (h + m / 60);
}

function parseDec(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s.includes(":")) {
    const sign = s.startsWith("-") ? -1 : 1;
    const p = s.replace(/[+-]/, "").split(":").map(Number);
    return sign * (p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600);
  }
  const x = Number(s);
  if (!Number.isFinite(x)) return null;
  const sign = x < 0 ? -1 : 1;
  const d = Math.trunc(Math.abs(x));
  const m = (Math.abs(x) - d) * 100;
  return sign * (d + m / 60);
}

function degToHms(raDeg) {
  if (!Number.isFinite(raDeg)) return "";
  let total = Math.round(mod(raDeg / 15, 24) * 3600);
  if (total >= 86400) total -= 86400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function degToDms(decDeg) {
  if (!Number.isFinite(decDeg)) return "";
  const sign = decDeg < 0 ? "-" : "+";
  const total = Math.round(Math.abs(decDeg) * 3600);
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${sign}${pad2(d)}:${pad2(m)}:${pad2(s)}`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines.shift()).map((h) => h.trim());
  return lines.map((line) => {
    const vals = splitCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || ""]));
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quote = !quote;
    } else if (ch === "," && !quote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function localSiderealTime(date, lonDeg) {
  const jd = julianDate(date);
  const t = (jd - 2451545.0) / 36525;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t * t * t / 38710000;
  return mod(gmst + lonDeg, 360);
}

function altAz(raDeg, decDeg, date, latDeg, lonDeg) {
  const lst = localSiderealTime(date, lonDeg);
  let ha = mod(lst - raDeg + 180, 360) - 180;
  const lat = rad(latDeg);
  const dec = rad(decDeg);
  const har = rad(ha);
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(har);
  const alt = deg(Math.asin(clamp(sinAlt, -1, 1)));
  const az = mod(deg(Math.atan2(-Math.sin(har), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(har))), 360);
  const z = 90 - alt;
  const airmass = alt > 0 ? 1 / (Math.cos(rad(z)) + 0.50572 * Math.pow(96.07995 - z, -1.6364)) : NaN;
  return { alt, az, haHours: ha / 15, airmass };
}

function sunPosition(date) {
  const jd = julianDate(date);
  const n = jd - 2451545.0;
  const L = mod(280.46 + 0.9856474 * n, 360);
  const g = rad(mod(357.528 + 0.9856003 * n, 360));
  const lambda = rad(mod(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g), 360));
  const eps = rad(23.439 - 0.0000004 * n);
  const ra = mod(deg(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda))), 360);
  const dec = deg(Math.asin(Math.sin(eps) * Math.sin(lambda)));
  return { raDeg: ra, decDeg: dec };
}

function moonPosition(date) {
  const jd = julianDate(date);
  const d = jd - 2451543.5;
  const N = rad(mod(125.1228 - 0.0529538083 * d, 360));
  const i = rad(5.1454);
  const w = rad(mod(318.0634 + 0.1643573223 * d, 360));
  const a = 60.2666;
  const e = 0.0549;
  const M = rad(mod(115.3654 + 13.0649929509 * d, 360));
  const E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
  const zh = r * (Math.sin(v + w) * Math.sin(i));
  const eps = rad(23.4393);
  const xe = xh;
  const ye = yh * Math.cos(eps) - zh * Math.sin(eps);
  const ze = yh * Math.sin(eps) + zh * Math.cos(eps);
  const ra = mod(deg(Math.atan2(ye, xe)), 360);
  const dec = deg(Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)));
  const sun = sunPosition(date);
  const elong = angularSep(ra, dec, sun.raDeg, sun.decDeg);
  return { raDeg: ra, decDeg: dec, phase: (1 - Math.cos(rad(elong))) / 2 };
}

function angularSep(ra1, dec1, ra2, dec2) {
  const r1 = rad(ra1), d1 = rad(dec1), r2 = rad(ra2), d2 = rad(dec2);
  const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
  return deg(Math.acos(clamp(c, -1, 1)));
}
