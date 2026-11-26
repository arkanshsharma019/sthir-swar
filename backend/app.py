"""Sthir Swar ("steady voice") - backend.

A small FastAPI server that stores medicines, dose responses, symptoms,
contacts, caregiver notes and help events in SQLite, works out which doses
are due, and builds a doctor-visit summary.

No secret keys are needed. If ANTHROPIC_API_KEY is set, the "Speak" screen can
also answer free-form questions; otherwise /api/ask reports "key not set".

Times: the browser sends its own local time ("YYYY-MM-DDTHH:MM") with each
request, so reminders follow the user's clock even when the server runs in UTC.
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent

# Read keys from a local .env file (never committed). Real environment variables win.
if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if value.strip():
                os.environ.setdefault(key.strip(), value.strip().strip('"'))
STATIC_DIR = ROOT / "static"
DB_PATH = Path(os.environ.get("STHIR_DB", ROOT / "data" / "sthir.db"))
TIME_FMT = "%Y-%m-%dT%H:%M"

# A reminder stays open for this long; after that an unanswered dose counts as missed.
DUE_WINDOW_MIN = 60
SNOOZE_MIN = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, dose TEXT DEFAULT '', times TEXT NOT NULL,
    notes TEXT DEFAULT '', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dose_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medicine_id INTEGER NOT NULL, scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL, responded_at TEXT NOT NULL, source TEXT DEFAULT 'voice'
);
CREATE TABLE IF NOT EXISTS symptoms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, trend TEXT DEFAULT 'same', text TEXT DEFAULT '',
    created_at TEXT NOT NULL, reported_by TEXT DEFAULT 'patient'
);
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, phone TEXT NOT NULL, relation TEXT DEFAULT '',
    is_primary INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT NOT NULL,
    seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT DEFAULT 'caregiver', text TEXT NOT NULL, created_at TEXT NOT NULL
);
"""

SYMPTOM_KINDS = {
    "tremor", "stiffness", "slowness", "freezing", "fall", "dizziness",
    "sleep", "mood", "pain", "swallowing", "other",
}
# Symptoms that the caregiver has agreed to be told about straight away.
ALERT_SYMPTOMS = {"fall", "dizziness"}

app = FastAPI(title="Sthir Swar")


# ---------------------------------------------------------------- database --

@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


@app.on_event("startup")
def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)


def now_or(value: Optional[str]) -> datetime:
    """Parse the client's local time, falling back to the server clock."""
    if value:
        try:
            return datetime.strptime(value[:16], TIME_FMT)
        except ValueError:
            pass
    return datetime.now().replace(second=0, microsecond=0)


def fmt(dt: datetime) -> str:
    return dt.strftime(TIME_FMT)


def add_event(conn, kind: str, detail: str, at: datetime):
    conn.execute(
        "INSERT INTO events (type, detail, created_at) VALUES (?, ?, ?)",
        (kind, detail, fmt(at)),
    )


def parse_times(times: list[str]) -> list[str]:
    clean = []
    for t in times:
        t = t.strip()
        try:
            clean.append(datetime.strptime(t, "%H:%M").strftime("%H:%M"))
        except ValueError:
            raise HTTPException(400, f"Time '{t}' must look like 08:00")
    if not clean:
        raise HTTPException(400, "Add at least one time")
    return sorted(set(clean))


# ----------------------------------------------------------------- models --

class Settings(BaseModel):
    patient_name: Optional[str] = None
    language: Optional[str] = None
    caregiver_name: Optional[str] = None


class Medicine(BaseModel):
    name: str = Field(min_length=1)
    dose: str = ""
    times: list[str]
    notes: str = ""


class DoseResponse(BaseModel):
    medicine_id: int
    scheduled_for: str
    status: str  # taken | not_yet | missed
    now: Optional[str] = None
    source: str = "voice"


class Symptom(BaseModel):
    kind: str
    trend: str = "same"  # worse | better | same
    text: str = ""
    now: Optional[str] = None
    reported_by: str = "patient"


class Contact(BaseModel):
    name: str = Field(min_length=1)
    phone: str = Field(min_length=3)
    relation: str = ""
    is_primary: bool = False


class Event(BaseModel):
    type: str  # help_call | help_message | caregiver_alert
    detail: str = ""
    now: Optional[str] = None


class Note(BaseModel):
    text: str = Field(min_length=1)
    author: str = "caregiver"
    now: Optional[str] = None


class Ask(BaseModel):
    text: str
    language: str = "en"


# --------------------------------------------------------------- settings --

@app.get("/api/status")
def status():
    return {"ai_enabled": ai_provider() is not None, "ai_provider": ai_provider()}


@app.get("/api/settings")
def get_settings():
    with db() as conn:
        data = {r["key"]: r["value"] for r in rows(conn, "SELECT * FROM settings")}
    return {"patient_name": "", "language": "en", "caregiver_name": "", **data}


@app.post("/api/settings")
def save_settings(s: Settings):
    with db() as conn:
        for key, value in s.model_dump(exclude_none=True).items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
    return get_settings()


# -------------------------------------------------------------- medicines --

def medicine_out(r: dict) -> dict:
    return {**r, "times": json.loads(r["times"]), "active": bool(r["active"])}


@app.get("/api/medicines")
def list_medicines():
    with db() as conn:
        return [medicine_out(r) for r in rows(conn, "SELECT * FROM medicines WHERE active = 1 ORDER BY name")]


@app.post("/api/medicines")
def add_medicine(m: Medicine):
    times = parse_times(m.times)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO medicines (name, dose, times, notes) VALUES (?, ?, ?, ?)",
            (m.name.strip(), m.dose.strip(), json.dumps(times), m.notes.strip()),
        )
        return medicine_out(rows(conn, "SELECT * FROM medicines WHERE id = ?", (cur.lastrowid,))[0])


@app.delete("/api/medicines/{med_id}")
def remove_medicine(med_id: int):
    # Soft delete keeps past dose history readable in the summary.
    with db() as conn:
        conn.execute("UPDATE medicines SET active = 0 WHERE id = ?", (med_id,))
    return {"ok": True}


def latest_logs(conn, since: str) -> dict:
    """Latest response for each (medicine, scheduled time) since a moment."""
    latest = {}
    for r in rows(conn, "SELECT * FROM dose_logs WHERE scheduled_for >= ? ORDER BY id", (since,)):
        latest[(r["medicine_id"], r["scheduled_for"])] = r
    return latest


@app.get("/api/doses/due")
def doses_due(now: Optional[str] = None):
    """Doses waiting for an answer right now.

    Also closes out doses nobody answered within the window: they are logged
    as missed and the caregiver gets an alert.
    """
    current = now_or(now)
    window_start = current - timedelta(hours=26)
    due = []
    with db() as conn:
        meds = [medicine_out(r) for r in rows(conn, "SELECT * FROM medicines WHERE active = 1")]
        latest = latest_logs(conn, fmt(window_start))
        for med in meds:
            for day in (current.date() - timedelta(days=1), current.date()):
                for t in med["times"]:
                    sched = datetime.combine(day, datetime.strptime(t, "%H:%M").time())
                    if sched > current or sched < window_start:
                        continue
                    key = (med["id"], fmt(sched))
                    last = latest.get(key)
                    if last and last["status"] in ("taken", "missed"):
                        continue
                    if current - sched > timedelta(minutes=DUE_WINDOW_MIN):
                        conn.execute(
                            "INSERT INTO dose_logs (medicine_id, scheduled_for, status, responded_at, source) "
                            "VALUES (?, ?, 'missed', ?, 'auto')",
                            (med["id"], fmt(sched), fmt(current)),
                        )
                        add_event(conn, "missed_noanswer", f"{med['name']} {med['dose']} · {t}", current)
                        continue
                    if last and last["status"] == "not_yet":
                        snoozed_until = now_or(last["responded_at"]) + timedelta(minutes=SNOOZE_MIN)
                        if snoozed_until > current:
                            continue
                    due.append({
                        "medicine_id": med["id"], "name": med["name"], "dose": med["dose"],
                        "time": t, "scheduled_for": fmt(sched),
                        "asked_before": bool(last),
                    })
    return sorted(due, key=lambda d: d["scheduled_for"])


@app.post("/api/doses")
def log_dose(d: DoseResponse):
    if d.status not in ("taken", "not_yet", "missed"):
        raise HTTPException(400, "status must be taken, not_yet or missed")
    current = now_or(d.now)
    with db() as conn:
        med = rows(conn, "SELECT * FROM medicines WHERE id = ?", (d.medicine_id,))
        if not med:
            raise HTTPException(404, "Medicine not found")
        conn.execute(
            "INSERT INTO dose_logs (medicine_id, scheduled_for, status, responded_at, source) VALUES (?, ?, ?, ?, ?)",
            (d.medicine_id, d.scheduled_for, d.status, fmt(current), d.source),
        )
        if d.status == "missed":
            add_event(conn, "missed_dose", f"{med[0]['name']} {med[0]['dose']} · {d.scheduled_for[-5:]}", current)
    return {"ok": True}


@app.delete("/api/doses")
def undo_dose(medicine_id: int, scheduled_for: str):
    """Un-tick a dose marked by mistake: removes the answers for that one dose."""
    with db() as conn:
        conn.execute("DELETE FROM dose_logs WHERE medicine_id = ? AND scheduled_for = ?", (medicine_id, scheduled_for))
    return {"ok": True}


@app.get("/api/doses/today")
def doses_today(now: Optional[str] = None):
    current = now_or(now)
    day = current.strftime("%Y-%m-%d")
    with db() as conn:
        meds = [medicine_out(r) for r in rows(conn, "SELECT * FROM medicines WHERE active = 1")]
        latest = latest_logs(conn, day + "T00:00")
    out = []
    for med in meds:
        for t in med["times"]:
            last = latest.get((med["id"], f"{day}T{t}"))
            out.append({
                "medicine_id": med["id"], "name": med["name"], "dose": med["dose"], "time": t,
                "status": last["status"] if last else ("upcoming" if f"{day}T{t}" > fmt(current) else "waiting"),
            })
    return sorted(out, key=lambda x: x["time"])


# --------------------------------------------------------------- symptoms --

@app.post("/api/symptoms")
def add_symptom(s: Symptom):
    kind = s.kind if s.kind in SYMPTOM_KINDS else "other"
    trend = s.trend if s.trend in ("worse", "better", "same") else "same"
    current = now_or(s.now)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO symptoms (kind, trend, text, created_at, reported_by) VALUES (?, ?, ?, ?, ?)",
            (kind, trend, s.text.strip(), fmt(current), s.reported_by),
        )
        if kind in ALERT_SYMPTOMS:
            add_event(conn, "symptom_alert", f"{kind}: {s.text.strip()}", current)
    return {"ok": True, "id": cur.lastrowid, "kind": kind, "alerted": kind in ALERT_SYMPTOMS}


@app.get("/api/symptoms")
def list_symptoms(limit: int = 30):
    with db() as conn:
        return rows(conn, "SELECT * FROM symptoms ORDER BY created_at DESC LIMIT ?", (limit,))


# ------------------------------------------------------- contacts & help --

@app.get("/api/contacts")
def list_contacts():
    with db() as conn:
        return rows(conn, "SELECT * FROM contacts ORDER BY is_primary DESC, name")


@app.post("/api/contacts")
def add_contact(c: Contact):
    with db() as conn:
        if c.is_primary:
            conn.execute("UPDATE contacts SET is_primary = 0")
        has_any = conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
        conn.execute(
            "INSERT INTO contacts (name, phone, relation, is_primary) VALUES (?, ?, ?, ?)",
            (c.name.strip(), c.phone.strip(), c.relation.strip(), int(c.is_primary or not has_any)),
        )
    return list_contacts()


@app.delete("/api/contacts/{contact_id}")
def remove_contact(contact_id: int):
    with db() as conn:
        conn.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    return {"ok": True}


@app.post("/api/events")
def log_event(e: Event):
    with db() as conn:
        add_event(conn, e.type, e.detail, now_or(e.now))
    return {"ok": True}


@app.get("/api/alerts")
def alerts(limit: int = 40):
    with db() as conn:
        return rows(conn, "SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?", (limit,))


@app.post("/api/alerts/seen")
def alerts_seen():
    with db() as conn:
        conn.execute("UPDATE events SET seen = 1")
    return {"ok": True}


@app.post("/api/notes")
def add_note(n: Note):
    with db() as conn:
        conn.execute(
            "INSERT INTO notes (author, text, created_at) VALUES (?, ?, ?)",
            (n.author, n.text.strip(), fmt(now_or(n.now))),
        )
    return {"ok": True}


@app.get("/api/notes")
def list_notes(limit: int = 20):
    with db() as conn:
        return rows(conn, "SELECT * FROM notes ORDER BY created_at DESC LIMIT ?", (limit,))


# ------------------------------------------------------- doctor summary --

def hours_since_last_dose(taken_times: list[datetime], at: datetime) -> Optional[float]:
    before = [t for t in taken_times if t <= at]
    if not before:
        return None
    return round((at - max(before)).total_seconds() / 3600, 1)


@app.get("/api/summary")
def summary(days: int = 14, now: Optional[str] = None):
    """Facts for a doctor visit. It describes; it never recommends a dose change."""
    current = now_or(now)
    start = fmt(current - timedelta(days=days))
    with db() as conn:
        meds = {r["id"]: medicine_out(r) for r in rows(conn, "SELECT * FROM medicines")}
        logs = rows(conn, "SELECT * FROM dose_logs WHERE scheduled_for >= ? ORDER BY id", (start,))
        symptoms = rows(conn, "SELECT * FROM symptoms WHERE created_at >= ? ORDER BY created_at", (start,))
        events = rows(conn, "SELECT * FROM events WHERE created_at >= ? AND type LIKE 'help%' ORDER BY created_at", (start,))
        notes = rows(conn, "SELECT * FROM notes WHERE created_at >= ? ORDER BY created_at", (start,))

    # Final answer for each scheduled dose (later answers replace "not yet").
    final = {}
    for log in logs:
        if log["status"] != "not_yet" or (log["medicine_id"], log["scheduled_for"]) not in final:
            final[(log["medicine_id"], log["scheduled_for"])] = log
    per_med = {}
    for (med_id, sched), log in final.items():
        if log["status"] == "not_yet":
            continue
        name = meds.get(med_id, {}).get("name", "Unknown")
        entry = per_med.setdefault(name, {"name": name, "dose": meds.get(med_id, {}).get("dose", ""), "taken": 0, "missed": 0, "missed_at": []})
        entry[log["status"]] += 1
        if log["status"] == "missed":
            entry["missed_at"].append(sched)
    taken = sum(m["taken"] for m in per_med.values())
    missed = sum(m["missed"] for m in per_med.values())

    # Pattern hint: do symptoms tend to come late after the last dose?
    taken_times = sorted(now_or(s) for (_, s), log in final.items() if log["status"] == "taken")
    counts, timeline = {}, []
    late, timed = 0, 0
    for s in symptoms:
        at = now_or(s["created_at"])
        gap = hours_since_last_dose(taken_times, at)
        counts[s["kind"]] = counts.get(s["kind"], 0) + 1
        if gap is not None and s["kind"] in ("tremor", "stiffness", "slowness", "freezing"):
            timed += 1
            late += gap >= 3
        timeline.append({**s, "hours_since_dose": gap})

    # Findings are sent as a key plus numbers; the browser words them in the chosen language.
    patterns = []
    if timed >= 3 and late / timed >= 0.5:
        patterns.append({"key": "pat_late", "late": late, "timed": timed})
    missed_days = {s[:10] for m in per_med.values() for s in m["missed_at"]}
    symptom_days_after_miss = sum(1 for s in symptoms if s["created_at"][:10] in missed_days)
    if missed_days and symptom_days_after_miss:
        patterns.append({"key": "pat_missedDays", "n": symptom_days_after_miss})
    if counts.get("fall"):
        patterns.append({"key": "pat_falls", "n": counts["fall"]})

    return {
        "period_days": days, "from": start, "to": fmt(current),
        "adherence_pct": round(100 * taken / (taken + missed)) if taken + missed else None,
        "doses_taken": taken, "doses_missed": missed,
        "medicines": sorted(per_med.values(), key=lambda m: m["name"]),
        "symptom_counts": counts, "symptoms": timeline[-40:],
        "help_events": events, "caregiver_notes": notes, "patterns": patterns,
    }


# ------------------------------------------------------------- optional AI --
# The app never needs AI. If a key is set, AI does two jobs:
#   1. /api/symptoms/understand - turns free speech into structured symptoms.
#   2. /api/ask - answers general spoken questions.
# Claude is used if ANTHROPIC_API_KEY is set, otherwise Gemini if GEMINI_API_KEY
# is set. Any failure (no internet, busy model, bad key) falls back to keywords.

AI_TIMEOUT_S = 12
GEMINI_MODELS = [m for m in os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",") if m]

SAFETY_RULES = (
    "Never suggest changing, skipping or adding medicine doses; the doctor decides that. "
    "Never diagnose. If the person mentions a fall with injury, chest pain, choking, trouble breathing, "
    "fainting or feeling unsafe, tell them to press the Help button or say 'help' to call their family."
)

ASK_SYSTEM = (
    "You are Sthir Swar, a calm voice companion for a person living with Parkinson's disease. "
    "Your reply is read aloud, so answer in 1-3 short, plain sentences with no lists or markdown. "
    "Reply in the language given in [language: ..] (en English, hi Hindi, ta Tamil, bn Bengali, "
    "te Telugu, mr Marathi, pa Punjabi in Gurmukhi script); "
    "the person may mix languages. " + SAFETY_RULES
)

UNDERSTAND_SYSTEM = (
    "You help a person with Parkinson's disease record how they feel. They speak freely, possibly mixing "
    "English, Hindi, Tamil, Bengali, Telugu, Marathi and Punjabi, and speech recognition may have small errors. "
    "List every symptom or feeling they describe as a separate item. Use these kinds: "
    "tremor (shaking, trembling), stiffness (rigid, tight muscles), slowness (slow movement, hard to start), "
    "freezing (feet stuck, cannot start walking), fall (fell or nearly fell), dizziness (light-headed, giddy, faint), "
    "sleep (poor sleep, daytime sleepiness, vivid dreams), mood (sad, anxious, low, worried), pain (any pain or cramps), "
    "swallowing (trouble swallowing, choking, drooling), other (anything else health-related, e.g. constipation, "
    "hallucinations, nausea, tiredness). "
    "trend: worse if they say it is worse, more, bad or new; better if improving; otherwise same. "
    "detail: a short English note with any timing or context they gave (e.g. 'since morning, left hand'). "
    "If they describe no symptom, return an empty list. "
    "urgent: true only for a fall with injury or head hit, choking, chest pain, trouble breathing, fainting, "
    "or confusion. "
    "reply: one or two short, warm sentences, to be read aloud in the language given in [language: ..] "
    "(en English, hi Hindi, ta Tamil, bn Bengali, te Telugu, mr Marathi, pa Punjabi in Gurmukhi script), "
    "saying what you noted. If urgent, also tell them to press Help. " + SAFETY_RULES
)

UNDERSTAND_SCHEMA = {
    "type": "object",
    "properties": {
        "symptoms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": sorted(SYMPTOM_KINDS)},
                    "trend": {"type": "string", "enum": ["worse", "better", "same"]},
                    "detail": {"type": "string"},
                },
                "required": ["kind", "trend", "detail"],
                "additionalProperties": False,
            },
        },
        "urgent": {"type": "boolean"},
        "reply": {"type": "string"},
    },
    "required": ["symptoms", "urgent", "reply"],
    "additionalProperties": False,
}


def ai_provider() -> Optional[str]:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    return None


def ai_call(system: str, user: str, schema: Optional[dict] = None) -> str:
    """One request to whichever AI is configured. Returns text (JSON text if a schema is given)."""
    provider = ai_provider()
    if provider == "claude":
        import anthropic

        client = anthropic.Anthropic(timeout=AI_TIMEOUT_S, max_retries=1)
        output_config = {"effort": "low"}
        if schema:
            output_config["format"] = {"type": "json_schema", "schema": schema}
        response = client.beta.messages.create(
            model="claude-opus-5-5",
            max_tokens=2048,
            system=system,
            output_config=output_config,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": user}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError("refused")
        return "".join(b.text for b in response.content if b.type == "text").strip()

    if provider == "gemini":
        from google import genai
        from google.genai import types

        client = genai.Client(http_options=types.HttpOptions(timeout=AI_TIMEOUT_S * 1000))
        config = types.GenerateContentConfig(system_instruction=system)
        if schema:
            config.response_mime_type = "application/json"
            config.response_json_schema = schema
        last_error: Exception = RuntimeError("no Gemini model")
        for model in GEMINI_MODELS:  # a busy or retired model falls through to the next
            try:
                return (client.models.generate_content(model=model, contents=user, config=config).text or "").strip()
            except Exception as exc:
                last_error = exc
        raise last_error

    raise RuntimeError("no AI key set")


class Understand(BaseModel):
    text: str = Field(min_length=1)
    language: str = "en"
    now: Optional[str] = None
    reported_by: str = "patient"


@app.post("/api/symptoms/understand")
def understand_symptoms(u: Understand):
    """Decode free speech into symptoms with AI and save them.

    Returns configured=False (or ok=False) so the browser can fall back to keyword matching.
    """
    if not ai_provider():
        return {"configured": False, "ok": False}
    try:
        data = json.loads(ai_call(UNDERSTAND_SYSTEM, f"[language: {u.language}] {u.text}", UNDERSTAND_SCHEMA))
    except Exception as exc:
        return {"configured": True, "ok": False, "error": type(exc).__name__}

    current = now_or(u.now)
    saved, alerted = [], False
    with db() as conn:
        for item in data.get("symptoms", [])[:8]:
            kind = item.get("kind") if item.get("kind") in SYMPTOM_KINDS else "other"
            trend = item.get("trend") if item.get("trend") in ("worse", "better", "same") else "same"
            detail = str(item.get("detail", "")).strip()[:200]
            text = f"{u.text.strip()}" + (f" [{detail}]" if detail else "")
            cur = conn.execute(
                "INSERT INTO symptoms (kind, trend, text, created_at, reported_by) VALUES (?, ?, ?, ?, ?)",
                (kind, trend, text, fmt(current), u.reported_by),
            )
            saved.append({"id": cur.lastrowid, "kind": kind, "trend": trend, "detail": detail})
            if kind in ALERT_SYMPTOMS or data.get("urgent"):
                alerted = True
        if alerted:
            first = saved[0]["kind"] if saved else "other"
            add_event(conn, "symptom_alert", f"{first}: {u.text.strip()}", current)
    return {
        "configured": True, "ok": True, "symptoms": saved,
        "urgent": bool(data.get("urgent")), "alerted": alerted,
        "reply": str(data.get("reply", "")).strip(),
    }


@app.delete("/api/symptoms/{symptom_id}")
def remove_symptom(symptom_id: int):
    """Lets the person undo a symptom the app got wrong."""
    with db() as conn:
        conn.execute("DELETE FROM symptoms WHERE id = ?", (symptom_id,))
    return {"ok": True}


@app.post("/api/ask")
def ask(q: Ask):
    if not ai_provider():
        return {"configured": False, "answer": None}
    try:
        return {"configured": True, "answer": ai_call(ASK_SYSTEM, f"[language: {q.language}] {q.text}")}
    except Exception as exc:  # network down, bad key, busy model: the app keeps working
        return {"configured": True, "answer": None, "error": type(exc).__name__}


# ---------------------------------------------------------------- demo data --

# What the demo patient "said", in each language, so a demo in any language reads naturally.
DEMO_WORDS = {
    "en": ("My shaking is worse", "I am stiff", "I fell in the bathroom", "Walking slower in the evenings this week."),
    "hi": ("मेरा कांपना बढ़ गया है", "मुझे अकड़न है", "मैं बाथरूम में गिर गई", "इस हफ़्ते शाम को धीरे चल रही हैं।"),
    "ta": ("என் நடுக்கம் அதிகமாகிவிட்டது", "உடம்பு விறைப்பா இருக்கு", "நான் குளியலறையில் விழுந்துவிட்டேன்", "இந்த வாரம் மாலையில் மெதுவாக நடக்கிறார்."),
    "bn": ("আমার কাঁপুনি বেড়েছে", "শরীর শক্ত লাগছে", "আমি বাথরুমে পড়ে গেছি", "এই সপ্তাহে সন্ধ্যায় ধীরে হাঁটছেন।"),
    "te": ("నా వణుకు ఎక్కువైంది", "ఒళ్ళు బిగుసుకుపోయింది", "నేను బాత్రూంలో పడిపోయాను", "ఈ వారం సాయంత్రం నెమ్మదిగా నడుస్తున్నారు."),
    "mr": ("माझी थरथर वाढली आहे", "अंग ताठ झाले आहे", "मी बाथरूममध्ये पडले", "या आठवड्यात संध्याकाळी हळू चालतात."),
    "pa": ("ਮੇਰੀ ਕੰਬਣੀ ਵੱਧ ਗਈ ਹੈ", "ਸਰੀਰ ਆਕੜਿਆ ਹੋਇਆ ਹੈ", "ਮੈਂ ਬਾਥਰੂਮ ਵਿੱਚ ਡਿੱਗ ਗਈ", "ਇਸ ਹਫ਼ਤੇ ਸ਼ਾਮ ਨੂੰ ਹੌਲੀ ਤੁਰਦੇ ਹਨ।"),
}


class Demo(BaseModel):
    now: Optional[str] = None
    language: str = "en"


@app.post("/api/demo")
def load_demo(d: Demo):
    """Two weeks of example data so the summary screen has something to show."""
    current = now_or(d.now)
    shaking, stiff, fell, note = DEMO_WORDS.get(d.language, DEMO_WORDS["en"])
    with db() as conn:
        for table in ("medicines", "dose_logs", "symptoms", "contacts", "events", "notes"):
            conn.execute(f"DELETE FROM {table}")
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('patient_name', 'Kamala')")
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('caregiver_name', 'Ravi')")
        demo_meds = [("Levodopa-Carbidopa", "100/25 mg", ["07:00", "13:00", "19:00"]), ("Pramipexole", "0.25 mg", ["08:00", "20:00"])]
        ids = []
        for name, dose, times in demo_meds:
            ids.append((conn.execute("INSERT INTO medicines (name, dose, times) VALUES (?, ?, ?)", (name, dose, json.dumps(times))).lastrowid, times))
        conn.execute("INSERT INTO contacts (name, phone, relation, is_primary) VALUES ('Ravi', '+919800000000', 'Son', 1)")
        conn.execute("INSERT INTO contacts (name, phone, relation, is_primary) VALUES ('Ambulance', '108', 'Emergency', 0)")
        for d in range(14, -1, -1):
            day = (current - timedelta(days=d)).date()
            for med_id, times in ids:
                for i, t in enumerate(times):
                    sched = f"{day}T{t}"
                    # Today: earlier doses are answered; a dose due right now is left open for the reminder.
                    if d == 0 and sched > fmt(current - timedelta(minutes=DUE_WINDOW_MIN)):
                        continue
                    status = "missed" if (d and d % 5 == 0 and i == 1) else "taken"
                    conn.execute("INSERT INTO dose_logs (medicine_id, scheduled_for, status, responded_at, source) VALUES (?, ?, ?, ?, 'demo')", (med_id, sched, status, sched))
            if d == 0:
                continue
            if d % 2 == 0:
                conn.execute("INSERT INTO symptoms (kind, trend, text, created_at) VALUES ('tremor', 'worse', ?, ?)", (shaking, f"{day}T11:40"))
            if d % 3 == 0:
                conn.execute("INSERT INTO symptoms (kind, trend, text, created_at) VALUES ('stiffness', 'worse', ?, ?)", (stiff, f"{day}T18:30"))
        fall_day = (current - timedelta(days=4)).date()
        conn.execute("INSERT INTO symptoms (kind, trend, text, created_at) VALUES ('fall', 'worse', ?, ?)", (fell, f"{fall_day}T21:15"))
        conn.execute("INSERT INTO events (type, detail, created_at) VALUES ('symptom_alert', ?, ?)", (f"fall: {fell}", f"{fall_day}T21:15"))
        conn.execute("INSERT INTO notes (author, text, created_at) VALUES ('caregiver', ?, ?)", (note, fmt(current - timedelta(days=2))))
    return {"ok": True}


@app.post("/api/reset")
def reset():
    with db() as conn:
        for table in ("medicines", "dose_logs", "symptoms", "contacts", "events", "notes", "settings"):
            conn.execute(f"DELETE FROM {table}")
    return {"ok": True}


# ------------------------------------------------------------------ static --

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def no_stale_files(request, call_next):
    # Always serve the latest page and scripts after an update.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
