// Sthir Swar - voice-first companion for people with Parkinson's and their caregivers.
// Speech uses the browser's built-in Web Speech API, so no keys or paid services are needed.
import { LANGS, STRINGS_EN, setLang, getLang, t, addMedicineWords, detectIntent, detectTook, detectAnswer, detectSymptom, detectTrend } from "./i18n.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const localNow = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const state = { settings: {}, contacts: [], aiEnabled: false, overlayOpen: false };

// ------------------------------------------------------------------ API --
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body: { now: localNow(), ...body } });

// ---------------------------------------------------------------- voice --
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognition = null;

function stopListening() {
  try { activeRecognition?.abort(); } catch { /* already stopped */ }
  activeRecognition = null;
}

/** Listen once. Resolves with what was heard, or null. */
function listen({ onText, maxMs = 9000 } = {}) {
  return new Promise((resolve) => {
    if (!Recognition) return resolve(null);
    stopListening();
    const rec = new Recognition();
    rec.lang = LANGS[getLang()].speech;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let heard = "";
    rec.onresult = (e) => {
      heard = Array.from(e.results).map((r) => r[0].transcript).join(" ");
      onText?.(heard);
    };
    rec.onerror = () => {};
    rec.onend = () => { if (activeRecognition === rec) activeRecognition = null; resolve(heard.trim() || null); };
    activeRecognition = rec;
    try { rec.start(); } catch { resolve(null); }
    setTimeout(() => { try { rec.stop(); } catch { /* ended */ } }, maxMs);
  });
}

function pickVoice(code) {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === code) || voices.find((v) => v.lang?.startsWith(code.slice(0, 2)));
}

/** Speak aloud and wait until finished (so the mic does not hear us). */
function say(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const code = LANGS[getLang()].speech;
    u.lang = code;
    const voice = pickVoice(code);
    if (voice) u.voice = voice;
    u.rate = 0.92; // a little slower is easier to follow
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    setTimeout(finish, 1500 + text.length * 90); // some browsers never fire onend
    speechSynthesis.speak(u);
  });
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.35 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.35);
      osc.stop(ctx.currentTime + i * 0.35 + 0.32);
    });
  } catch { /* audio blocked until first tap */ }
  navigator.vibrate?.([400, 200, 400]);
}

function setMic(btn, on) {
  btn.classList.toggle("listening", on);
  btn.querySelector("[data-t]").textContent = on ? t("listening") : btn.dataset.idle;
}

// ---------------------------------------------------------- small UI bits --
let toastTimer;
function toast(html, ms = 6000) {
  const el = $("#toast");
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function showBubble(el, label, text) {
  el.hidden = false;
  el.innerHTML = label ? `<small>${esc(label)}</small>${esc(text)}` : esc(text);
}

const primaryContact = () => state.contacts.find((c) => c.is_primary) || state.contacts[0];
const caregiverName = () => state.settings.caregiver_name || primaryContact()?.name || "your caregiver";
const waLink = (phone, text) => `https://wa.me/${String(phone).replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

/**
 * "Notify Ravi on WhatsApp": opens WhatsApp with the whole message already written,
 * so the patient only taps Send. (Sending with no tap at all needs the paid WhatsApp
 * Business API; see README.)
 */
function notifyButton(message) {
  const c = primaryContact();
  if (!c) return "";
  return `<a class="notify" data-notify target="_blank" rel="noopener" href="${waLink(c.phone, message)}">💬 ${esc(t("tellCaregiver", { caregiver: c.name }))}</a>`;
}

const patientName = () => state.settings.patient_name || "Patient";
const clock = () => new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/** A ready-to-send message a caregiver can read at a glance. */
function symptomMessage(items, text, urgent) {
  const lines = items.map((x) => `• ${t(`kind_${x.kind}`)}${x.trend !== "same" ? ` (${t(`trend_${x.trend}`)})` : ""}${x.detail ? `: ${x.detail}` : ""}`);
  return [
    `${urgent ? "⚠️ URGENT – " : ""}Sthir Swar update: ${patientName()} reported at ${clock()}:`,
    ...lines,
    text ? `In their words: "${text}"` : "",
    urgent ? "Please call them now." : "",
  ].filter(Boolean).join("\n");
}

// Symptoms worth telling the caregiver about straight away.
const CONCERNING = new Set(["fall", "dizziness", "pain", "swallowing", "freezing"]);
const isConcerning = (items, urgent) => urgent || items.some((x) => CONCERNING.has(x.kind) || x.trend === "worse");

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-notify]");
  if (link) post("/api/events", { type: "caregiver_notified", detail: primaryContact()?.name || "" }).catch(() => {});
});

// Shaking hands often tap twice. Ignore a second tap on the same control within 800 ms.
let lastTap = { el: null, at: 0 };
document.addEventListener("click", (e) => {
  const target = e.target.closest("button, a");
  if (!target) return;
  const now = Date.now();
  if (lastTap.el === target && now - lastTap.at < 800) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  lastTap = { el: target, at: now };
}, true);

// ------------------------------------------------------------- overlays --
/** Show a question with big buttons and also accept a spoken answer. */
function askWithVoice({ overlay, statusEl, prompt, buttonsAttr, interpret }) {
  return new Promise((resolve) => {
    let settled = false;
    const buttons = overlay.querySelectorAll(`[${buttonsAttr}]`);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stopListening();
      buttons.forEach((b) => { b.onclick = null; });
      overlay.hidden = true;
      state.overlayOpen = false;
      resolve(value);
    };
    buttons.forEach((b) => { b.onclick = () => finish(b.getAttribute(buttonsAttr)); });
    overlay.hidden = false;
    state.overlayOpen = true;

    (async () => {
      await say(prompt);
      for (let attempt = 0; attempt < 3 && !settled && Recognition; attempt++) {
        statusEl.textContent = `🎙️ ${t("listening")}`;
        const heard = await listen({ onText: (txt) => { statusEl.textContent = `🎙️ “${txt}”`; } });
        if (settled) return;
        const value = heard && interpret(heard);
        if (value) return finish(value);
        if (heard) await say(t("notUnderstood"));
      }
      statusEl.textContent = "";
    })();
  });
}

function confirmByVoice(question) {
  $("#confirm-text").textContent = question;
  return askWithVoice({
    overlay: $("#confirm"), statusEl: $("#confirm-status"), prompt: question, buttonsAttr: "data-confirm",
    interpret: (heard) => {
      const a = detectAnswer(heard);
      return a === "yes" ? "yes" : a === "no" || a === "not_yet" ? "no" : null;
    },
  }).then((v) => v === "yes");
}

// ------------------------------------------------------------ reminders --
async function remind(dose) {
  if (state.overlayOpen) return;
  const title = t("reminder", { name: dose.name, dose: dose.dose });
  $("#reminder-title").textContent = title;
  chime();
  const answer = await askWithVoice({
    overlay: $("#reminder"), statusEl: $("#reminder-status"), prompt: `${title} ${t("didYouTake")}`, buttonsAttr: "data-answer",
    interpret: (heard) => ({ yes: "taken", missed: "missed", not_yet: "not_yet", no: "not_yet" }[detectAnswer(heard)] || null),
  });
  await post("/api/doses", { medicine_id: dose.medicine_id, scheduled_for: dose.scheduled_for, status: answer, source: "app" });
  const reply = answer === "taken" ? t("takenOk") : answer === "not_yet" ? t("snoozeOk") : t("missedOk", { caregiver: caregiverName() });
  toast(esc(reply));
  if (answer === "missed") toast(notifyButton(`Sthir Swar update: ${patientName()} missed ${dose.name} ${dose.dose} (due ${dose.time}). They have not taken an extra dose.`), 20000);
  if (location.hash === "#meds") renderMeds();
  if (location.hash === "#home" || !location.hash) renderHome();
  await say(reply);
}

async function checkDue() {
  if (state.overlayOpen) return;
  try {
    const due = await api(`/api/doses/due?now=${encodeURIComponent(localNow())}`);
    if (due.length) remind(due[0]);
  } catch { /* server unreachable; try again next tick */ }
}

// ------------------------------------------------------------- symptoms --
/** Keyword path: always works, no AI needed. */
async function logSymptom(text, kind = detectSymptom(text) || "other", trend = detectTrend(text)) {
  const res = await post("/api/symptoms", { kind, trend, text });
  const label = [t(`kind_${res.kind}`), t(`trend_${trend}`)].filter(Boolean).join(" – ");
  let reply = t("symptomSaved", { kind: label });
  if (res.alerted) reply += " " + t("symptomAlerted", { caregiver: caregiverName() });
  return { reply, items: [{ id: res.id, kind: res.kind, trend, detail: "" }], urgent: false };
}

/** Show what was saved: each item with "Not right", plus Help / Notify buttons when needed. */
function showFeelingResult(replyEl, { reply, items, urgent }, text) {
  replyEl.hidden = false;
  replyEl.innerHTML = `${esc(reply)}${items.length ? `<small>${esc(t("notedThese"))}</small>` : ""}
    <ul class="decoded">${items.map((x) => `<li data-id="${x.id}"><span><b>${esc(t(`kind_${x.kind}`))}</b> ${esc(t(`trend_${x.trend}`))}${x.detail ? ` <small>· ${esc(x.detail)}</small>` : ""}</span><button class="x" type="button">✕ ${esc(t("notRight"))}</button></li>`).join("")}</ul>
    ${urgent ? `<a class="notify go-help" href="#help">🆘 ${esc(t("goHelp"))}</a>` : ""}
    ${items.length && isConcerning(items, urgent) ? notifyButton(symptomMessage(items, text, urgent)) : ""}`;
  replyEl.querySelectorAll(".decoded li").forEach((li) => {
    li.querySelector("button").onclick = async () => {
      await api(`/api/symptoms/${li.dataset.id}`, { method: "DELETE" });
      li.remove();
      if (location.hash === "#symptoms") renderSymptomList();
      say(t("removed"));
    };
  });
  if (location.hash === "#symptoms") renderSymptomList();
}

/**
 * Record how the person feels from free speech. With an AI key, the AI decodes
 * every symptom in the sentence; otherwise (or if the AI fails) keywords do it.
 */
async function recordFeeling(text, replyEl) {
  let result = null;
  if (state.aiEnabled) {
    showBubble(replyEl, "", t("understanding"));
    const res = await post("/api/symptoms/understand", { text, language: getLang() }).catch(() => ({}));
    if (res.ok) {
      result = {
        reply: res.reply || t("symptomSaved", { kind: res.symptoms.map((x) => t(`kind_${x.kind}`)).join(", ") }),
        items: res.symptoms, urgent: res.urgent,
      };
    }
  }
  if (!result) result = await logSymptom(text); // keyword fallback
  showFeelingResult(replyEl, result, text);
  return say(result.reply);
}

// ----------------------------------------------------------------- help --
async function callFlow(contact = primaryContact()) {
  const reply = $("#help-reply");
  if (!contact) { showBubble(reply, "", t("noContact")); return say(t("noContact")); }
  const ok = await confirmByVoice(t("callConfirm", { name: contact.name }));
  if (!ok) { showBubble(reply, "", t("cancelled")); return say(t("cancelled")); }
  await post("/api/events", { type: "help_call", detail: `${contact.name} (${contact.phone})` });
  showBubble(reply, "", t("calling", { name: contact.name }));
  await say(t("calling", { name: contact.name }));
  location.href = `tel:${contact.phone.replace(/[^\d+]/g, "")}`;
}

async function messageFlow() {
  const contact = primaryContact();
  const reply = $("#help-reply");
  if (!contact) { showBubble(reply, "", t("noContact")); return say(t("noContact")); }
  await say(`${t("messageTo", { name: contact.name })} ${t("dictatePrompt")}`);
  showBubble(reply, "", `🎙️ ${t("listening")}`);
  let msg = await listen({ maxMs: 15000, onText: (txt) => showBubble(reply, t("youSaid"), txt) });
  if (!Recognition) msg = window.prompt(t("dictatePrompt")) || null;
  if (!msg) { showBubble(reply, "", t("notUnderstood")); return say(t("notUnderstood")); }
  showBubble(reply, t("youSaid"), msg);
  const ok = await confirmByVoice(t("readBack", { msg }));
  if (!ok) { showBubble(reply, "", t("cancelled")); return say(t("cancelled")); }
  await post("/api/events", { type: "help_message", detail: `${contact.name}: ${msg}` });
  showBubble(reply, "", t("sent"));
  await say(t("sent"));
  window.open(waLink(contact.phone, msg), "_blank", "noopener");
}

// ---------------------------------------------- understanding speech --
async function handleUtterance(text, heard = $("#speak-heard"), replyEl = $("#speak-reply")) {
  showBubble(heard, t("youSaid"), text);
  const respond = async (msg) => { showBubble(replyEl, "", msg); await say(msg); };

  const intent = detectIntent(text);
  if (intent === "help") { location.hash = "#help"; return callFlow(); }
  if (intent === "message") { location.hash = "#help"; return messageFlow(); }
  if (intent === "call") { location.hash = "#help"; return callFlow(); }
  // "I took my tablet" / "I missed my tablet": record the dose without opening anything.
  const took = intent === "medicine" && detectTook(text); // needs a medicine word, so "I took a walk" doesn't count
  const missed = intent === "medicine" && detectAnswer(text) === "missed";
  if (took || missed) {
    const dose = await doseToAnswer(took);
    if (!dose) {
      const next = await nextDose();
      await respond(`${t("noDoseNow")}${next ? " " + t("nextDose", next) : ""}`);
    } else {
      await post("/api/doses", { medicine_id: dose.medicine_id, scheduled_for: dose.scheduled_for, status: took ? "taken" : "missed", source: "voice" });
      if (took) {
        await respond(t("takenNamed", { name: dose.name, time: dose.time }));
      } else {
        const msg = t("missedOk", { caregiver: caregiverName() });
        showBubble(replyEl, "", msg);
        replyEl.insertAdjacentHTML("beforeend", notifyButton(`Sthir Swar update: ${patientName()} missed ${dose.name} ${dose.dose} (due ${dose.time}). They have not taken an extra dose.`));
        await say(msg);
      }
      if (location.hash === "#meds") renderMeds();
      if (location.hash === "#home" || !location.hash) renderHome();
    }
    if (detectSymptom(text)) return recordFeeling(text, replyEl); // "I took it but I'm still shaking"
    return;
  }
  if (detectSymptom(text)) return recordFeeling(text, replyEl);
  if (intent === "medicine") {
    const due = await api(`/api/doses/due?now=${encodeURIComponent(localNow())}`);
    if (due.length) return remind(due[0]);
    location.hash = "#meds";
    const next = await nextDose();
    return say(next ? t("nextDose", next) : t("medsToday"));
  }
  if (intent === "summary") { location.hash = "#summary"; return say(t("summary")); }
  if (intent === "symptoms") { location.hash = "#symptoms"; return say(t("symptomPrompt")); }
  if (intent === "home") { location.hash = "#home"; return; }
  if (intent === "time") return respond(t("timeNow", { time: new Date().toLocaleTimeString(LANGS[getLang()].speech, { hour: "numeric", minute: "2-digit" }) }));
  if (intent === "capabilities") return respond(t("guide"));
  if (intent === "greet") return respond(t("greetReply", { name: state.settings.patient_name || "" }));

  // Not an app command: a general question. Without an AI key, guide the person
  // to what the app can do; the key note is shown on screen but not spoken.
  const guideWithNote = async () => {
    showBubble(replyEl, "", t("guide"));
    replyEl.insertAdjacentHTML("beforeend", `<small>${esc(t("keyNote"))}</small>`);
    await say(t("guide"));
  };
  if (!state.aiEnabled) return guideWithNote();
  showBubble(replyEl, "", "…");
  const res = await post("/api/ask", { text, language: getLang() }).catch(() => ({}));
  if (res.configured === false) return guideWithNote();
  return respond(res.answer || t("aiError"));
}

// ---------------------------------------------------------------- views --
/** The dose a spoken "I took it" / "I missed it" refers to: one due now, else the latest earlier one still open. */
async function doseToAnswer(allowMissed) {
  const due = await api(`/api/doses/due?now=${encodeURIComponent(localNow())}`);
  if (due.length) return due[0];
  const now = localNow();
  const day = now.slice(0, 10);
  const open = allowMissed ? ["waiting", "not_yet", "missed"] : ["waiting", "not_yet"];
  const today = await api(`/api/doses/today?now=${encodeURIComponent(now)}`);
  const past = today.filter((d) => open.includes(d.status) && `${day}T${d.time}` <= now);
  const dose = past[past.length - 1];
  return dose ? { ...dose, scheduled_for: `${day}T${dose.time}` } : null;
}

async function nextDose() {
  const today = await api(`/api/doses/today?now=${encodeURIComponent(localNow())}`);
  return today.find((d) => d.status === "upcoming" || d.status === "waiting" || d.status === "not_yet");
}

async function renderHome() {
  const name = state.settings.patient_name;
  $("#greeting").textContent = name ? t("hello", { name }) : t("tagline");
  const next = await nextDose().catch(() => null);
  const el = $("#next-dose");
  el.hidden = !next;
  if (next) el.textContent = `💊 ${t("nextDose", next)}`;
}

const QUICK_SYMPTOMS = ["tremor", "stiffness", "slowness", "freezing", "fall", "dizziness", "pain", "sleep", "mood"];

async function renderSymptoms() {
  $("#sym-quick").innerHTML = QUICK_SYMPTOMS.map((k) => `<button type="button" data-kind="${k}">${esc(t(`kind_${k}`))}</button>`).join("");
  $("#sym-quick").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      const result = await logSymptom(t(`kind_${b.dataset.kind}`), b.dataset.kind, "same");
      showFeelingResult($("#sym-reply"), result, "");
      say(result.reply);
    };
  });
  renderSymptomList();
}

async function renderSymptomList() {
  const list = await api("/api/symptoms?limit=8");
  $("#sym-list").innerHTML = list.map((s) =>
    `<li><span><b>${esc(t(`kind_${s.kind}`))}</b> ${s.trend !== "same" ? esc(t(`trend_${s.trend}`)) : ""}<br><small class="muted">${esc(s.text)}</small></span><span class="tag">${esc(s.created_at.replace("T", " "))}</span></li>`
  ).join("");
}

async function renderMeds() {
  const today = await api(`/api/doses/today?now=${encodeURIComponent(localNow())}`);
  const list = $("#dose-list");
  if (!today.length) { list.innerHTML = `<li>${esc(t("noMeds"))}</li>`; return; }
  const day = localNow().slice(0, 10);
  // Each dose: a big tick ("I took it") and, if not taken, a "Not taken?" button that opens
  // the full choice (Taken / Not yet / I missed it). Missed doses keep a Notify button.
  list.innerHTML = today.map((d, i) => {
    const taken = d.status === "taken";
    const missedMsg = `Sthir Swar update: ${patientName()} missed ${d.name} ${d.dose} (due ${d.time}). They have not taken an extra dose.`;
    return `
    <li class="s-${d.status}" data-i="${i}">
      <button class="tick" type="button" aria-pressed="${taken}" aria-label="${esc(t("yesTaken"))}: ${esc(d.name)} ${esc(d.time)}">✓</button>
      <span class="dose-info"><span class="name">${esc(d.name)}</span><span class="meta">${esc(d.time)}${d.dose ? ` · ${esc(d.dose)}` : ""}</span></span>
      <span class="dose-side">
        <span class="dose-state">${taken ? "✓ " : ""}${esc(t(`status_${d.status}`))}</span>
        ${taken ? "" : `<button class="not-taken" type="button">${esc(t("notTaken"))}</button>`}
      </span>
      ${d.status === "missed" ? `<div class="dose-notify">${notifyButton(missedMsg)}</div>` : ""}
    </li>`;
  }).join("");
  list.querySelectorAll("li").forEach((li) => {
    const d = today[li.dataset.i];
    const scheduled_for = `${day}T${d.time}`;
    li.querySelector(".tick").onclick = async () => {
      if (d.status === "taken") {
        await api(`/api/doses?medicine_id=${d.medicine_id}&scheduled_for=${encodeURIComponent(scheduled_for)}`, { method: "DELETE" });
      } else {
        await post("/api/doses", { medicine_id: d.medicine_id, scheduled_for, status: "taken", source: "tick" });
        say(t("takenOk"));
      }
      renderMeds();
    };
    const other = li.querySelector(".not-taken");
    if (other) other.onclick = () => remind({ ...d, scheduled_for }); // reminder re-renders this list
  });
}

function renderHelp() {
  $("#help-contacts").innerHTML = state.contacts.map((c, i) =>
    `<button type="button" data-i="${i}">📞 ${esc(c.name)} <small>${esc(c.relation)}</small></button>`).join("");
  $("#help-contacts").querySelectorAll("button").forEach((b) => { b.onclick = () => callFlow(state.contacts[b.dataset.i]); });
}

// Dates and times written the way the chosen language writes them.
// Some browsers have no Punjabi month names (they print "M11"), so we carry our own.
const locale = () => LANGS[getLang()].speech;
const PA_MONTHS = ["ਜਨਵਰੀ", "ਫ਼ਰਵਰੀ", "ਮਾਰਚ", "ਅਪ੍ਰੈਲ", "ਮਈ", "ਜੂਨ", "ਜੁਲਾਈ", "ਅਗਸਤ", "ਸਤੰਬਰ", "ਅਕਤੂਬਰ", "ਨਵੰਬਰ", "ਦਸੰਬਰ"];
const PA_DAYS = ["ਐਤਵਾਰ", "ਸੋਮਵਾਰ", "ਮੰਗਲਵਾਰ", "ਬੁੱਧਵਾਰ", "ਵੀਰਵਾਰ", "ਸ਼ੁੱਕਰਵਾਰ", "ਸ਼ਨਿੱਚਰਵਾਰ"];
function formatDate(date, { weekday = false, year = false, long = false } = {}) {
  const text = date.toLocaleDateString(locale(), { day: "numeric", month: long ? "long" : "short", ...(weekday && { weekday: "long" }), ...(year && { year: "numeric" }) });
  if (!/M\d/.test(text)) return text;
  if (getLang() === "pa") return `${weekday ? PA_DAYS[date.getDay()] + ", " : ""}${date.getDate()} ${PA_MONTHS[date.getMonth()]}${year ? " " + date.getFullYear() : ""}`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "numeric", ...(year && { year: "numeric" }) });
}
const dateText = (iso) => formatDate(new Date(iso.length > 10 ? iso : `${iso}T00:00`));
const when = (iso) => `${dateText(iso)} ${iso.slice(11, 16)}`;

/** An alert line in the chosen language. Details hold names, times and the patient's own words. */
function eventText(e) {
  const icon = { missed_dose: "💊", missed_noanswer: "💊", symptom_alert: "⚠️", help_call: "📞", help_message: "✉️", caregiver_notified: "💬" }[e.type] || "•";
  if (e.type === "missed_noanswer") return `${icon} ${t("ev_missed_dose")} (${t("ev_no_answer")}): ${e.detail}`;
  if (e.type === "symptom_alert") {
    const [kind, ...rest] = e.detail.split(": ");
    const label = STRINGS_EN[`kind_${kind}`] ? t(`kind_${kind}`) : kind;
    return `${icon} ${t("ev_symptom_alert")}: ${label}${rest.length ? ` – “${rest.join(": ")}”` : ""}`;
  }
  const label = { missed_dose: "ev_missed_dose", help_call: "ev_help_call", help_message: "ev_help_message", caregiver_notified: "ev_caregiver_notified" }[e.type];
  return `${icon} ${label ? t(label) + ": " : ""}${e.detail}`;
}

async function renderCaregiver() {
  const [alerts, meds, notes] = await Promise.all([api("/api/alerts"), api("/api/medicines"), api("/api/notes")]);
  const form = $("#cg-settings");
  form.patient_name.value = state.settings.patient_name || "";
  form.caregiver_name.value = state.settings.caregiver_name || "";
  $("#cg-alerts").innerHTML = alerts.length
    ? alerts.map((a) => `<li class="${a.seen ? "" : "alert-unseen"}"><span>${esc(eventText(a))}</span><span class="tag">${esc(when(a.created_at))}</span></li>`).join("")
    : `<li>${esc(t("cg_noAlerts"))}</li>`;
  if (alerts.some((a) => !a.seen)) api("/api/alerts/seen", { method: "POST" });
  $("#cg-meds").innerHTML = meds.map((m) =>
    `<li><span><b>${esc(m.name)}</b> ${esc(m.dose)} · ${esc(m.times.join(", "))}</span><button class="x" data-med="${m.id}" type="button" aria-label="Remove">✕</button></li>`).join("") || `<li>${esc(t("cg_noMeds"))}</li>`;
  $("#cg-contacts").innerHTML = state.contacts.map((c) =>
    `<li><span><b>${esc(c.name)}</b> ${esc(c.phone)} ${c.is_primary ? "⭐" : ""} <small class="muted">${esc(c.relation)}</small></span><button class="x" data-contact="${c.id}" type="button" aria-label="Remove">✕</button></li>`).join("") || `<li>${esc(t("cg_noContacts"))}</li>`;
  $("#cg-notes").innerHTML = notes.map((n) => `<li><span>${esc(n.text)}</span><span class="tag">${esc(dateText(n.created_at))}</span></li>`).join("");
  $("#cg-ai").textContent = state.aiEnabled
    ? t("cg_aiOn", { provider: state.aiProvider === "claude" ? "Claude" : "Gemini" })
    : t("cg_aiOff");

  document.querySelectorAll("[data-med]").forEach((b) => { b.onclick = async () => { await api(`/api/medicines/${b.dataset.med}`, { method: "DELETE" }); renderCaregiver(); }; });
  document.querySelectorAll("[data-contact]").forEach((b) => { b.onclick = async () => { await api(`/api/contacts/${b.dataset.contact}`, { method: "DELETE" }); await loadContacts(); renderCaregiver(); }; });
}

function bindCaregiverForms() {
  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  const guard = (fn) => async (e) => { e.preventDefault(); try { await fn(e.target); } catch (err) { toast(esc(err.message)); } };

  $("#cg-settings").onsubmit = guard(async (form) => {
    state.settings = await post("/api/settings", formData(form));
    toast(esc(t("cg_saved")));
  });
  // Common Parkinson's medicines in a list, with "Other" to type any name.
  const pick = $("#cg-med-pick");
  const otherBox = $("#cg-med-other");
  pick.onchange = () => {
    otherBox.hidden = pick.value !== "__other";
    otherBox.querySelector("input").required = !otherBox.hidden;
    if (!otherBox.hidden) otherBox.querySelector("input").focus();
  };
  $("#cg-med-form").onsubmit = guard(async (form) => {
    const d = formData(form);
    const name = d.pick === "__other" ? d.name : d.pick;
    await post("/api/medicines", { name, dose: d.dose, times: d.times.split(/[,\s]+/).filter(Boolean) });
    form.reset(); otherBox.hidden = true; renderCaregiver(); toast(esc(t("cg_medAdded")));
  });
  $("#cg-contact-form").onsubmit = guard(async (form) => {
    const d = formData(form);
    state.contacts = await post("/api/contacts", { ...d, is_primary: !!d.is_primary });
    form.reset(); renderCaregiver(); toast(esc(t("cg_contactAdded")));
  });
  $("#cg-note-form").onsubmit = guard(async (form) => {
    await post("/api/notes", formData(form));
    form.reset(); renderCaregiver(); toast(esc(t("cg_noteSaved")));
  });
  $("#cg-demo").onclick = async () => { await post("/api/demo", { language: getLang() }); await loadBasics(); renderCaregiver(); toast(esc(t("cg_demoLoaded"))); };
  $("#cg-reset").onclick = async () => {
    if (!confirm(t("cg_confirmClear"))) return;
    await post("/api/reset"); await loadBasics(); renderCaregiver(); toast(esc(t("cg_cleared")));
  };
}

async function renderSummary() {
  const days = $("#sum-days").value;
  const s = await api(`/api/summary?days=${days}&now=${encodeURIComponent(localNow())}`);
  const totalSymptoms = Object.values(s.symptom_counts).reduce((a, b) => a + b, 0);
  const dayHeading = (iso) => formatDate(new Date(`${iso}T00:00`), { weekday: true, long: true });
  const trendText = (tr) => (tr !== "same" ? ` (${t(`trend_${tr}`)})` : "");

  const medRows = s.medicines.map((m) => {
    const total = m.taken + m.missed;
    const pct = total ? Math.round((100 * m.taken) / total) : 0;
    const missed = m.missed_at.slice(-3).map(when).join(", ");
    return `<div class="bar-row"><span class="label">${esc(m.name)}<small>${esc(m.dose)}${missed ? ` · ${esc(t("sum_missedAt"))}: ${esc(missed)}` : ""}</small></span>
      <span class="bar"><i style="width:${pct}%"></i></span><span class="num">${m.taken}/${total}</span></div>`;
  }).join("");

  const maxCount = Math.max(1, ...Object.values(s.symptom_counts));
  const symRows = Object.entries(s.symptom_counts).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
    `<div class="bar-row"><span class="label">${esc(t(`kind_${k}`))}</span><span class="bar sym"><i style="width:${(100 * n) / maxCount}%"></i></span><span class="num">${n}</span></div>`).join("");

  // Timeline grouped by day, newest first.
  const byDay = {};
  s.symptoms.slice(-20).reverse().forEach((x) => { (byDay[x.created_at.slice(0, 10)] ||= []).push(x); });
  const timeline = Object.entries(byDay).map(([day, items]) => `<div class="day"><h3>${esc(dayHeading(day))}</h3>
    ${items.map((x) => `<div class="event"><span class="time">${esc(x.created_at.slice(11))}</span><span><b>${esc(t(`kind_${x.kind}`))}</b>${esc(trendText(x.trend))} – “${esc(x.text)}”
      ${x.hours_since_dose != null ? `<span class="gap"><br>${esc(t("sum_afterDose", { h: x.hours_since_dose }))}</span>` : ""}</span></div>`).join("")}</div>`).join("");

  const listOrEmpty = (arr, fn) => arr.length ? `<ul class="list compact">${arr.map(fn).join("")}</ul>` : `<p class="empty">${esc(t("sum_nothing"))}</p>`;
  const name = state.settings.patient_name || t("sum_patient");

  $("#summary-body").innerHTML = `
    <div class="report-head">
      <div><div class="who">${esc(name)}</div><div class="period">${esc(dateText(s.from))} – ${esc(dateText(s.to))} (${esc(t("sum_days", { n: s.period_days }))})</div></div>
      <div class="muted">${esc(t("sum_prepared"))}<br>${esc(formatDate(new Date(), { long: true, year: true }))}</div>
    </div>

    <section class="sum-section">
      <h2>${esc(t("sum_glance"))}</h2>
      <div class="stats">
        <div class="stat good"><b>${s.adherence_pct ?? "–"}${s.adherence_pct != null ? "%" : ""}</b><span>${esc(t("sum_taken"))}</span></div>
        <div class="stat ${s.doses_missed ? "bad" : "good"}"><b>${s.doses_missed}</b><span>${esc(t("sum_missed"))}</span></div>
        <div class="stat info"><b>${totalSymptoms}</b><span>${esc(t("sum_reports"))}</span></div>
        <div class="stat ${s.symptom_counts.fall ? "bad" : "good"}"><b>${s.symptom_counts.fall || 0}</b><span>${esc(t("sum_falls"))}</span></div>
      </div>
    </section>

    ${s.patterns.length ? `<section class="sum-section discuss"><h2>${esc(t("sum_discuss"))}</h2>
      <ul class="discuss-list">${s.patterns.map((p) => `<li>${esc(t(p.key, p))}</li>`).join("")}</ul></section>` : ""}

    <section class="sum-section"><h2>${esc(t("sum_meds"))}</h2><div class="bars">${medRows || `<p class="empty">${esc(t("sum_noDoses"))}</p>`}</div></section>
    <section class="sum-section"><h2>${esc(t("sum_symptoms"))}</h2><div class="bars">${symRows || `<p class="empty">${esc(t("sum_none"))}</p>`}</div></section>
    <section class="sum-section"><h2>${esc(t("sum_timeline"))}</h2>${timeline || `<p class="empty">${esc(t("sum_noSymptoms"))}</p>`}</section>

    <div class="two-col">
      <section class="sum-section"><h2>${esc(t("sum_help"))}</h2>${listOrEmpty(s.help_events, (e) => `<li><span>${esc(eventText(e))}</span><span class="tag">${esc(dateText(e.created_at))}</span></li>`)}</section>
      <section class="sum-section"><h2>${esc(t("sum_notes"))}</h2>${listOrEmpty(s.caregiver_notes, (n) => `<li><span>${esc(n.text)}</span><span class="tag">${esc(dateText(n.created_at))}</span></li>`)}</section>
    </div>

    <p class="disclaimer">${esc(t("sum_disclaimer"))}</p>`;
}

// --------------------------------------------------------------- router --
const VIEWS = { home: renderHome, speak: null, symptoms: renderSymptoms, meds: renderMeds, help: renderHelp, caregiver: renderCaregiver, summary: renderSummary };

function route() {
  const name = (location.hash || "#home").slice(1);
  const view = name in VIEWS ? name : "home";
  stopListening();
  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $("#home-fab").hidden = view === "home";
  window.scrollTo(0, 0);
  Promise.resolve().then(() => VIEWS[view]?.()).catch((err) => toast(esc(err.message)));
}

// ------------------------------------------------------------- language --
function applyLang() {
  document.documentElement.lang = getLang();
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll("[data-t-ph]").forEach((el) => { el.placeholder = t(el.dataset.tPh); });
  document.querySelectorAll("[data-t-label]").forEach((el) => { el.label = t(el.dataset.tLabel); });
  document.querySelectorAll("[data-t-n]").forEach((el) => { el.textContent = t("lastDays", { n: el.dataset.tN }); });
  document.querySelectorAll(".mic").forEach((b) => { b.dataset.idle = b.querySelector("[data-t]").textContent; });
  $("#langs").innerHTML = Object.entries(LANGS).map(([code, l]) =>
    `<button type="button" data-lang="${code}" aria-pressed="${code === getLang()}">${l.label}</button>`).join("");
  $("#langs").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      setLang(b.dataset.lang);
      applyLang();
      route();
      say(t("tagline"));
      state.settings = await post("/api/settings", { language: b.dataset.lang }).catch(() => state.settings);
    };
  });
}

// ----------------------------------------------------------------- start --
async function loadContacts() { state.contacts = await api("/api/contacts"); }
async function loadBasics() {
  const [settings, status] = await Promise.all([api("/api/settings"), api("/api/status")]);
  state.settings = settings;
  state.aiEnabled = status.ai_enabled;
  state.aiProvider = status.ai_provider;
  setLang(settings.language || "en");
  await loadContacts();
  addMedicineWords((await api("/api/medicines")).map((m) => m.name)); // "I missed the Syndopa" counts as medicine
  applyLang();
}

function bindMic(btn, onHeard) {
  btn.onclick = async () => {
    if (!Recognition) { toast(esc(t("noSpeech")), 8000); return; }
    if (btn.classList.contains("listening")) { stopListening(); return; }
    speechSynthesis.cancel();
    setMic(btn, true);
    const heard = await listen();
    setMic(btn, false);
    if (!heard) return say(t("notUnderstood"));
    onHeard(heard);
  };
}

async function start() {
  await loadBasics();
  bindCaregiverForms();
  bindMic($("#speak-mic"), (text) => handleUtterance(text).catch((e) => toast(esc(e.message))));
  // The big home button listens in place and answers on the home screen.
  bindMic($("#home-mic"), (text) => handleUtterance(text, $("#home-heard"), $("#home-reply")).catch((e) => toast(esc(e.message))));
  const feel = (text) => {
    showBubble($("#sym-heard"), t("youSaid"), text);
    recordFeeling(text, $("#sym-reply")).catch((err) => toast(esc(err.message)));
  };
  bindMic($("#sym-mic"), feel);
  $("#sym-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#sym-text").value.trim();
    if (text) { $("#sym-text").value = ""; feel(text); }
  };
  $("#speak-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#speak-text").value.trim();
    if (text) { $("#speak-text").value = ""; handleUtterance(text).catch((err) => toast(esc(err.message))); }
  };
  $("#help-big").onclick = () => callFlow();
  $("#help-message").onclick = () => messageFlow();
  $("#sum-days").onchange = renderSummary;
  if (!Recognition) toast(esc(t("noSpeech")), 8000);
  speechSynthesis?.getVoices(); // warm up the voice list
  window.addEventListener("hashchange", route);
  route();
  checkDue();
  setInterval(checkDue, 30000);
}

start().catch((err) => { document.body.insertAdjacentHTML("afterbegin", `<p class="pattern">Could not start: ${esc(err.message)}</p>`); });
