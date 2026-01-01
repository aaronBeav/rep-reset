// =====================
// Storage helpers
// =====================
const LS_KEYS = {
  plan: "rr_plan_v1",
  logs: "rr_daylogs_v1",
  profile: "rr_profile_v1",
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function todayISO(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

function formatTime(sec) {
  const s = Math.max(0, sec | 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

// =====================
// Default data
// =====================
function defaultPlan() {
  const t = new Date();
  const start = new Date(t);
  start.setDate(start.getDate() - 3);
  return {
    planName: "My Plan",
    startDate: start.toISOString().slice(0, 10),
    scheduleType: "DAILY_EXCEPT_SUN",
    intervals: [
      { title: "Warm-up", type: "workout", mode: "timer", durationSeconds: 60 },
      { title: "Rest", type: "rest", mode: "timer", durationSeconds: 20 },
      { title: "Main Set", type: "workout", mode: "timer", durationSeconds: 60 },
      { title: "Rest", type: "rest", mode: "timer", durationSeconds: 20 },
      { title: "Cool-down", type: "workout", mode: "timer", durationSeconds: 45 }
    ]
  };
}

let PLAN = loadJSON(LS_KEYS.plan, null) || defaultPlan();
let DAYLOGS = loadJSON(LS_KEYS.logs, {}); // { "YYYY-MM-DD": {status, note?} }
let PROFILE = loadJSON(LS_KEYS.profile, { height: "", weight: "", lastWeightDate: null });

// =====================
// Tabs
// =====================
const tabs = document.querySelectorAll(".tab");
tabs.forEach(btn => btn.addEventListener("click", () => {
  tabs.forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("show"));
  document.getElementById(`tab-${btn.dataset.tab}`).classList.add("show");
}));

// =====================
// Plan UI
// =====================
const startDateEl = document.getElementById("startDate");
const planListEl = document.getElementById("planList");
const intervalTypeEl = document.getElementById("intervalType");
const intervalTitleEl = document.getElementById("intervalTitle");
const intervalSecondsEl = document.getElementById("intervalSeconds");
const jsonBoxEl = document.getElementById("jsonBox");

document.getElementById("btnAddInterval").addEventListener("click", () => {
  const title = intervalTitleEl.value.trim() || (intervalTypeEl.value === "rest" ? "Rest" : "Workout");
  const secs = Math.max(5, parseInt(intervalSecondsEl.value || "30", 10));
  PLAN.intervals.push({ title, type: intervalTypeEl.value, mode: "timer", durationSeconds: secs });
  intervalTitleEl.value = "";
  renderPlan();
  savePlan();
});

document.getElementById("btnSavePlan").addEventListener("click", () => {
  savePlan();
  alert("Plan saved.");
});

document.getElementById("btnExport").addEventListener("click", async () => {
  const out = JSON.stringify(PLAN, null, 2);
  jsonBoxEl.value = out;
  try {
    await navigator.clipboard.writeText(out);
    alert("Export copied to clipboard.");
  } catch {
    alert("Export is in the box — copy it manually.");
  }
});

document.getElementById("btnImport").addEventListener("click", () => {
  try {
    const incoming = JSON.parse(jsonBoxEl.value);
    if (!incoming || !incoming.intervals || !incoming.startDate) throw new Error("Invalid format.");
    PLAN = incoming;
    savePlan();
    loadPlanToUI();
    renderPlan();
    alert("Imported plan saved.");
  } catch (e) {
    alert("Import failed: " + (e?.message || "Invalid JSON"));
  }
});

function savePlan() {
  PLAN.startDate = startDateEl.value || PLAN.startDate;
  saveJSON(LS_KEYS.plan, PLAN);
  refreshTodayFromPlan();
  renderCalendar();
}

function loadPlanToUI() {
  startDateEl.value = PLAN.startDate;
}

function renderPlan() {
  planListEl.innerHTML = "";
  PLAN.intervals.forEach((it, idx) => {
    const li = document.createElement("li");
    li.className = "listItem";
    li.innerHTML = `
      <div>
        <div><strong>${escapeHTML(it.title)}</strong></div>
        <div class="row" style="margin-top:6px">
          <span class="badge ${it.type}">${it.type.toUpperCase()}</span>
          <span class="muted">${formatTime(it.durationSeconds)}</span>
        </div>
      </div>
      <div class="itemActions">
        <button class="btn mini" data-act="up">Up</button>
        <button class="btn mini" data-act="down">Down</button>
        <button class="btn mini danger" data-act="del">Delete</button>
      </div>
    `;
    li.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "up" && idx > 0) {
        [PLAN.intervals[idx - 1], PLAN.intervals[idx]] = [PLAN.intervals[idx], PLAN.intervals[idx - 1]];
      } else if (act === "down" && idx < PLAN.intervals.length - 1) {
        [PLAN.intervals[idx + 1], PLAN.intervals[idx]] = [PLAN.intervals[idx], PLAN.intervals[idx + 1]];
      } else if (act === "del") {
        PLAN.intervals.splice(idx, 1);
      }
      renderPlan();
      savePlan();
    }));
    planListEl.appendChild(li);
  });
}

// =====================
// Today / Timer engine
// =====================
const currentTitleEl = document.getElementById("currentTitle");
const nextTitleEl = document.getElementById("nextTitle");
const timerStateEl = document.getElementById("timerState");
const timeLeftEl = document.getElementById("timeLeft");
const countHintEl = document.getElementById("countHint");
const todayListEl = document.getElementById("todayList");

document.getElementById("btnReloadToday").addEventListener("click", refreshTodayFromPlan);

const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnSkip = document.getElementById("btnSkip");
const btnBack = document.getElementById("btnBack");
const btnFinish = document.getElementById("btnFinish");

let session = [];
let state = "idle"; // idle | countdown | running | paused | finished
let idx = 0;
let remaining = 0;
let tickHandle = null;
let countdown = 5;

btnStart.addEventListener("click", () => {
  if (state === "idle" || state === "finished") startCountdown();
});

btnPause.addEventListener("click", () => {
  if (state === "running") pause();
  else if (state === "paused") resume();
});

btnSkip.addEventListener("click", () => {
  if (state === "running" || state === "paused") nextInterval();
});

btnBack.addEventListener("click", () => {
  if (state === "running" || state === "paused") prevInterval();
});

btnFinish.addEventListener("click", () => {
  if (session.length) finishSession(true);
});

function setHint(msg) { countHintEl.textContent = msg; }

function updateControls() {
  const hasSession = session.length > 0;

  btnStart.disabled = !(hasSession && (state === "idle" || state === "finished"));
  btnPause.disabled = !(hasSession && (state === "running" || state === "paused"));
  btnSkip.disabled = !(hasSession && (state === "running" || state === "paused"));
  btnBack.disabled = !(hasSession && (state === "running" || state === "paused") && idx > 0);
  btnFinish.disabled = !(hasSession && (state === "running" || state === "paused"));

  btnPause.textContent = (state === "paused") ? "Resume" : "Pause";
}

function refreshTodayFromPlan() {
  stopTick();

  const d = new Date();
  const isSunday = d.getDay() === 0;
  if (isSunday) {
    session = [];
    state = "idle";
    renderTodayList();
    currentTitleEl.textContent = "Rest Day (Sunday)";
    nextTitleEl.textContent = "—";
    timerStateEl.textContent = "Idle";
    timeLeftEl.textContent = "00:00";
    timeLeftEl.classList.remove("warn", "rest", "workout");
    setHint("Sunday is an automatic rest day.");
    updateControls();
    return;
  }

  const start = new Date(PLAN.startDate + "T00:00:00");
  const today = new Date(todayISO() + "T00:00:00");
  if (today < start) {
    session = [];
    state = "idle";
    renderTodayList();
    currentTitleEl.textContent = "Not started yet";
    nextTitleEl.textContent = "—";
    timerStateEl.textContent = "Idle";
    timeLeftEl.textContent = "00:00";
    timeLeftEl.classList.remove("warn", "rest", "workout");
    setHint("Your plan starts on " + PLAN.startDate);
    updateControls();
    return;
  }

  session = PLAN.intervals.map(x => ({ ...x }));
  idx = 0;
  remaining = session[0]?.durationSeconds ?? 0;
  state = "idle";
  countdown = 5;

  renderTodayList();
  updateTitles();
  updateTimeUI();
  timerStateEl.textContent = "Idle";
  setHint("Press Start to begin (5s countdown + beeps).");
  updateControls();
}

function renderTodayList() {
  todayListEl.innerHTML = "";
  if (!session.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No session for today.";
    todayListEl.appendChild(li);
    return;
  }
  session.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = `${i + 1}. ${it.title} (${it.type}) — ${formatTime(it.durationSeconds)}`;
    todayListEl.appendChild(li);
  });
}

function startCountdown() {
  if (!session.length) return;

  state = "countdown";
  countdown = 5;
  stopTick();

  timerStateEl.textContent = "Starting…";
  setHint("Get ready…");
  updateTitles();

  updateControls();

  // show 00:05 immediately
  timeLeftEl.textContent = "00:05";
  timeLeftEl.classList.remove("warn");
  beep(0.08, 880);

  tickHandle = setInterval(() => {
    countdown--;
    const text = "00:" + String(Math.max(0, countdown)).padStart(2, "0");
    timeLeftEl.textContent = text;

    if (countdown > 0) {
      timeLeftEl.classList.toggle("warn", countdown <= 2);
      beep(0.08, 880);
    }

    if (countdown <= 0) {
      stopTick();
      beginRunning();
    }
  }, 1000);
}

function beginRunning() {
  state = "running";
  idx = Math.min(idx, session.length - 1);
  remaining = session[idx].durationSeconds;

  timerStateEl.textContent = "Running";
  setHint("Last 5 seconds beep + colour change.");
  updateTitles();
  updateTimeUI();
  updateControls();

  stopTick();
  tickHandle = setInterval(tick, 1000);
}

function tick() {
  if (state !== "running") return;

  remaining = Math.max(0, remaining - 1);
  updateTimeUI();

  if (remaining > 0 && remaining <= 5) {
    beep(0.07, 740);
  }

  if (remaining === 0) {
    beep(0.12, 440);
    nextInterval();
  }
}

function pause() {
  if (state !== "running") return;
  state = "paused";
  timerStateEl.textContent = "Paused";
  setHint("Paused. Resume when ready.");
  stopTick();
  updateControls();
}

function resume() {
  if (state !== "paused") return;
  state = "running";
  timerStateEl.textContent = "Running";
  setHint("Last 5 seconds beep + colour change.");
  stopTick();
  tickHandle = setInterval(tick, 1000);
  updateControls();
}

function nextInterval() {
  idx++;
  if (idx >= session.length) {
    finishSession(true);
    return;
  }
  remaining = session[idx].durationSeconds;
  updateTitles();
  updateTimeUI();
  updateControls();
}

function prevInterval() {
  idx = Math.max(0, idx - 1);
  remaining = session[idx].durationSeconds; // restore full duration
  updateTitles();
  updateTimeUI();
  updateControls();
}

function finishSession(markComplete) {
  stopTick();
  state = "finished";
  timerStateEl.textContent = "Finished";
  updateTitles();
  updateTimeUI();
  updateControls();

  if (markComplete) {
    const iso = todayISO();
    DAYLOGS[iso] = { status: "completed", note: DAYLOGS[iso]?.note || "" };
    saveJSON(LS_KEYS.logs, DAYLOGS);
    renderCalendar();
    setHint("Completed! Marked green in Calendar.");
  }
}

function stopTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

function updateTitles() {
  if (!session.length) {
    currentTitleEl.textContent = "—";
    nextTitleEl.textContent = "—";
    timeLeftEl.classList.remove("rest", "workout");
    return;
  }
  const cur = session[idx];
  const next = session[idx + 1];
  currentTitleEl.textContent = cur ? cur.title : "—";
  nextTitleEl.textContent = next ? next.title : "—";

  timeLeftEl.classList.toggle("rest", cur?.type === "rest");
  timeLeftEl.classList.toggle("workout", cur?.type === "workout");
}

function updateTimeUI() {
  if (!session.length) {
    timeLeftEl.textContent = "00:00";
    timeLeftEl.classList.remove("warn");
    return;
  }
  timeLeftEl.textContent = formatTime(remaining);
  timeLeftEl.classList.toggle("warn", state === "running" && remaining > 0 && remaining <= 5);
}

// Beeps (no audio files needed)
let audioCtx = null;
function beep(duration = 0.08, freq = 880) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    setTimeout(() => { o.stop(); }, Math.max(10, duration * 1000));
  } catch {
    // If blocked by browser, ignore
  }
}

// =====================
// Calendar
// =====================
const calendarGridEl = document.getElementById("calendarGrid");
const calHeaderEl = document.getElementById("calHeader");
const dayDetailsEl = document.getElementById("dayDetails");
const restNoteBoxEl = document.getElementById("restNoteBox");
const restNoteEl = document.getElementById("restNote");
const btnSaveNoteEl = document.getElementById("btnSaveNote");

let calDate = new Date();
calDate.setDate(1);
let selectedISO = null;

document.getElementById("calPrev").addEventListener("click", () => { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); });
document.getElementById("calToday").addEventListener("click", () => { calDate = new Date(); calDate.setDate(1); renderCalendar(); });

btnSaveNoteEl.addEventListener("click", () => {
  if (!selectedISO) return;
  const existing = DAYLOGS[selectedISO] || { status: "rest", note: "" };
  existing.status = "rest";
  existing.note = restNoteEl.value || "";
  DAYLOGS[selectedISO] = existing;
  saveJSON(LS_KEYS.logs, DAYLOGS);
  renderCalendar();
  renderDayDetails(selectedISO);
  alert("Rest note saved.");
});

function renderCalendar() {
  calendarGridEl.innerHTML = "";

  const year = calDate.getFullYear();
  const month = calDate.getMonth();

  const monthName = calDate.toLocaleString(undefined, { month: "long", year: "numeric" });
  calHeaderEl.textContent = monthName;

  ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(dn => {
    const div = document.createElement("div");
    div.className = "dayName";
    div.textContent = dn;
    calendarGridEl.appendChild(div);
  });

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDay = first.getDay();
  const totalDays = last.getDate();

  for (let i = 0; i < startDay; i++) {
    const pad = document.createElement("div");
    pad.className = "day dim";
    calendarGridEl.appendChild(pad);
  }

  const planStart = new Date(PLAN.startDate + "T00:00:00");
  const today = new Date(todayISO() + "T00:00:00");

  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();

    const cell = document.createElement("div");
    cell.className = "day";

    const beforeStart = d < planStart;
    const isSunday = dow === 0;
    const isPast = d < today;

    const scheduled = (!beforeStart) && (!isSunday); // starter rule
    const log = DAYLOGS[iso];

    let status = "none";
    if (beforeStart) status = "none";
    else if (isSunday) status = "rest";
    else if (log?.status === "completed") status = "completed";
    else if (scheduled && isPast) status = "missed";

    if (status === "completed") cell.classList.add("green");
    if (status === "rest") cell.classList.add("orange");
    if (status === "missed") cell.classList.add("red");

    cell.innerHTML = `
      <div class="dnum">${day}</div>
      <div class="tag">${statusLabel(status, iso)}</div>
    `;

    cell.addEventListener("click", () => {
      selectedISO = iso;
      renderDayDetails(iso);
    });

    calendarGridEl.appendChild(cell);
  }
}

function statusLabel(status, iso) {
  if (status === "completed") return "Completed";
  if (status === "rest") return DAYLOGS[iso]?.note ? "Rest (note)" : "Rest";
  if (status === "missed") return "Missed";
  return "";
}

function renderDayDetails(iso) {
  const d = new Date(iso + "T00:00:00");
  const log = DAYLOGS[iso];
  const isSunday = d.getDay() === 0;
  const planStart = new Date(PLAN.startDate + "T00:00:00");
  const beforeStart = d < planStart;

  if (beforeStart) {
    dayDetailsEl.textContent = `${iso}: Before start date (${PLAN.startDate}).`;
    restNoteBoxEl.classList.add("hidden");
    return;
  }

  if (isSunday) {
    dayDetailsEl.textContent = `${iso}: Sunday rest day.`;
    restNoteBoxEl.classList.remove("hidden");
    restNoteEl.value = log?.note || "";
    return;
  }

  if (log?.status === "completed") {
    dayDetailsEl.textContent = `${iso}: Completed ✅`;
  } else {
    dayDetailsEl.textContent = `${iso}: Scheduled workout day.`;
  }

  restNoteBoxEl.classList.add("hidden");
}

// =====================
// Profile (starter)
// =====================
document.getElementById("btnSaveProfile").addEventListener("click", () => {
  PROFILE.height = document.getElementById("height").value || "";
  PROFILE.weight = document.getElementById("weight").value || "";
  PROFILE.lastWeightDate = todayISO();
  saveJSON(LS_KEYS.profile, PROFILE);
  document.getElementById("profileSaved").textContent = "Saved locally.";
});

function loadProfileUI() {
  document.getElementById("height").value = PROFILE.height || "";
  document.getElementById("weight").value = PROFILE.weight || "";
}

// =====================
// Init
// =====================
loadPlanToUI();
renderPlan();
refreshTodayFromPlan();
renderCalendar();
loadProfileUI();
updateControls();
