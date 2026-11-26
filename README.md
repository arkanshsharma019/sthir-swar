# Sthir Swar — "steady voice"

A voice-first companion for people with Parkinson's disease and their caregivers.
When shaking hands make phones hard to use, the voice takes over: speak in **English, Hindi, Tamil,
Bengali, Telugu, Marathi or Punjabi** (or a mix) to log symptoms, answer medicine reminders and call for help.

## Run it (one command)

```bash
docker compose up --build
```

Then open **http://localhost:8000** in **Chrome or Edge** (these have built-in speech recognition)
and allow the microphone.

No secret keys are needed: the app starts and every feature works without one.
Optionally, copy `.env.example` to `.env` and set `GEMINI_API_KEY` (Google AI Studio) or
`ANTHROPIC_API_KEY` (Claude). With a key, "How I feel" understands free speech and Speak
answers general questions; without one, keywords and big buttons are used instead.

**Try it quickly:** open **Caregiver → Load demo data**, then look at **Doctor summary**.
To see a reminder, add a medicine in Caregiver with the current time (e.g. `14:05`); it pops up within 30 seconds.

### Without Docker

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
.venv/bin/python -m uvicorn backend.app:app --port 8000
```

## What it does

| Screen | What happens |
|---|---|
| **Speak** (the big button on the home screen) | Tap once and talk; it listens right there. "My shaking is worse" logs a symptom, "I took my medicine" / "dawai le li" ticks the waiting dose, "I missed my tablet" records it and offers to notify the caregiver, "help" / "madad" / "உதவி" starts a call, "send a message" dictates one. Typing works too. |
| **How I feel** | Say anything in your own words: "subah se haath kaanp raha hai aur neend nahi aayi". With AI on, every symptom in the sentence is decoded (kind, worse/better, timing), saved, and shown with a **Not right** button to undo. Urgent things (fall with head injury, choking, fainting) bring up a Help button. Without AI, keywords decode it. Big symptom buttons always work. Falls and dizziness alert the caregiver. |
| **Medicines** | Full-screen, flashing, spoken reminder with a chime and vibration: "Did you take it?" Answer by voice ("haan", "not yet", "I missed it") or with one of three huge buttons. "Not yet" reminds again in 10 min; no answer in 60 min counts as missed and alerts the caregiver. Today's list has one big tick per dose (turns green when taken) and a "Not taken?" button; missed doses keep a "Notify on WhatsApp" button. The app never changes a dose. |
| **Help** | One giant button or saying "help". It asks "Shall I call Ravi?" and waits for yes/no before calling. Dictated messages are read back before sending (WhatsApp). |
| **Caregiver** | Set up medicines (pick from common Parkinson's medicines or type any name), contacts and names; see alerts; add observations. |
| **Doctor summary** | Printable, in the chosen language: doses taken/missed, symptom counts and timeline, hours since the last dose for each symptom, falls, help requests, caregiver notes, and neutral "things to discuss" (e.g. symptoms coming 3+ hours after a dose). It describes; the clinician decides. |

Built for shaky hands: every target is at least 56px (most 90px+), double taps within 0.8s are ignored,
text is large and high-contrast, and every spoken prompt is also shown on screen.

## How it is built

- **Frontend:** plain HTML/CSS/JavaScript (`static/`). Speech-to-text and text-to-speech use the browser's
  free Web Speech API (`en-IN`, `hi-IN`, `ta-IN`, `bn-IN`, `te-IN`, `mr-IN`, `pa-IN`). Without AI, understanding
  is keyword-based across all seven languages at once (`static/i18n.js`), so mixed speech works.
  Screen text lives in `static/i18n.js` and `static/i18n-pages.js`.
- **Backend:** Python FastAPI + SQLite (`backend/app.py`): medicines, dose answers, due-dose logic,
  symptoms, contacts, alerts, notes and the summary. Data lives in a Docker volume.
- **Optional AI (Gemini or Claude):** `/api/symptoms/understand` turns free speech into structured symptoms
  (JSON schema), and `/api/ask` answers general questions. Safety rules in the prompt: never advise on doses,
  never diagnose, point to Help for emergencies. Each call has a 12-second limit and falls back to a second
  model, then to keyword matching, so if the key is missing, the service is down or it becomes too costly,
  the app keeps working.

## Limits of this prototype

- Speech recognition in Chrome uses Google's speech service, so voice input needs internet. Firefox has no speech recognition (typing still works).
- Spoken replies in Tamil, Bengali, Telugu, Marathi and Punjabi depend on voices installed on the device (Android Chrome usually has them); the text is always shown on screen.
- Reminders pop up while the app is open in a tab. Reminders with the app closed (installable app + push notifications) are planned for the full version.
- **WhatsApp:** for concerning symptoms (pain, falls, dizziness, freezing, anything "worse") and missed doses, a "Notify Ravi on WhatsApp" button opens WhatsApp with the full message already written; the patient taps Send once. Sending with no tap at all is only possible through the WhatsApp Business Platform (a Meta-verified business number, pre-approved message templates and a per-message fee), which is planned for the full version.
- Translations should be reviewed by native speakers, and the whole design tested with people with Parkinson's, caregivers and neurologists.
- Not a medical device. It records and reminds; it does not diagnose or change treatment.

## 3-minute demo script

1. **Home (15 s):** the grandmother character, "Hello Kamala", and the big **Tap and speak** button. Switch the language to हिन्दी and back.
2. **Speak (45 s):** tap the big button and say "subah se haath bahut kaanp raha hai aur neend nahi aayi". The app logs two symptoms and answers in Hindi. Then say "I took my medicine" and the waiting dose turns green.
3. **Reminder (30 s):** in Caregiver, add a medicine for the current minute. The full-screen reminder chimes and asks "Did you take it?". Answer "I missed it" and show the **Notify Ravi on WhatsApp** button.
4. **Help (20 s):** press HELP. It asks "Shall I call Ravi?" and waits for yes or no.
5. **Doctor summary (40 s):** Caregiver → Load demo data, then open the Doctor summary: adherence, missed doses, symptom timeline and "Things to discuss" (symptoms 3+ hours after a dose). Switch to தமிழ் to show it in Tamil. Print.
6. **Close (20 s):** it works with no AI key (keywords and buttons), the AI only helps understand speech, and the app never changes a dose.
