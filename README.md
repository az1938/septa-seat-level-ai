# Seat-Level ETA — Week 3 refined (Prototype 1)

A new, separate version of Prototype 1. The original project in
`../septa-seat-level-eta/` is untouched and kept as a backup.

**Week 3 AI capability:** the AI interprets a rider's naturally spoken
destination, recommends the most suitable SEPTA route using live transit data,
and personalizes the seat-level display with that route's ETA.

| Layer | Job |
|---|---|
| Camera detection | *triggers* the interaction |
| Speech recognition | *transcribes* the rider |
| AI | *interprets* the destination |
| SEPTA / GTFS data | determines valid routes and the *live ETA* |
| LED tile | *displays* the personalized result |

## Status — step 1 only

Visual structure + interaction state machine, driven by a developer
controller. **Not connected yet:** camera, microphone, speech, AI, SEPTA.
The route/ETA shown in RECOMMENDATION comes from the dev controller's
clearly-labelled *mock* fields, only so the states and LED colors can be
previewed.

## Run

```bash
cd ~/Documents/prototype1-week3-refined
npm install
npm run dev
```

Open **http://localhost:5174** (the old prototype uses 5173, so both can run).

## Camera person detection

- On load the page asks for camera permission (works on `http://localhost`).
- Detection: MediaPipe Tasks Vision `ObjectDetector` (EfficientDet-Lite0),
  category `person` only, running in the browser. Frames are never saved,
  drawn, or uploaded. The WASM runtime + model are fetched once from public
  CDNs (jsDelivr / Google Cloud Storage) and cached.
- Debounce: a person must be seen continuously for 0.7 s to count as present,
  and be gone for 1 s to count as absent.
- In IDLE, a confirmed person automatically sends `PERSON_DETECTED`. The camera
  never sends anything in other states. After a session returns to IDLE, the
  scene must be empty once before the next person can trigger it.
- If the camera or model fails, the DEV preview shows the error and the manual
  controls still work.

## Spoken prompt + listening

- PERSON_DETECTED speaks "Where are you going?" (speechSynthesis, en-US voice).
  Click the page once after loading — browsers block speech before a gesture.
- When the prompt finishes → PROMPT_FINISHED → LISTENING.
- LISTENING starts one SpeechRecognition (en-US, continuous=false, interim
  results). The final phrase → SPEECH_CAPTURED(transcript) → PROCESSING.
- Silence retries once automatically; after that use DEV "Listen again".
- No audio is recorded or saved by the app; the transcript lives only in the
  current session (cleared on IDLE). Chrome's speech service does the
  speech-to-text. Target browsers: Chrome / Edge.

## AI destination interpretation (backend)

`server/app.py` (Flask, port 8788) exposes `POST /api/interpret-destination`
`{ "transcript": "..." }`. It asks the OpenAI API (Responses API + strict JSON
Structured Outputs; default model `gpt-6-luna`, override with `OPENAI_MODEL`)
to normalize the destination ONLY — no routes, stops, ETAs or SEPTA facts.
Vite proxies `/api` to it. The API key lives in `server/.env` (git-ignored)
as `OPENAI_API_KEY`.

```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # paste OPENAI_API_KEY
python3 app.py
```

## Transit routing (static GTFS + live SEPTA)

`POST /api/recommend-route` (same backend, port 8788). The AI plays no part.

Route 21 only — there is no route comparison. Origins (verified from GTFS at
every backend start — it refuses to run if they stop matching the feed):

| | stop | name | Route 21 direction | trips |
|---|---|---|---|---|
| PRIMARY (this kiosk) | 623 | Chestnut St & 37th St | eastbound (dir 0) → Columbus-Dock | 229 |
| OPPOSITE | 21362 | Walnut St & 37th St | westbound (dir 1) → 69th St TC | 229 |

0. **Walkable?** (`server/walking.py`) — checked FIRST, after the destination is
   verified: walking route from stop 623 (OSRM foot router on OpenStreetMap,
   routing.openstreetmap.de; street-grid estimate at 80 m/min if unreachable).
   ≤ 10 min → `walk_recommended`: Frame 1 "This destination is within walking
   distance. / About N minutes on foot.", spoken once ("…Walking may be faster
   than waiting for the bus." — a suggestion, never "you should walk"), then
   IDLE after ~3 s. No Route 21 ETA is fetched and the LED is not touched; the
   Route 21 facts are still returned for the DEV panel.
1. **Destination → stops** (`server/destination_match.py`): GTFS stop-name match
   for intersections, Philadelphia block-number grid for addresses, Nominatim
   geocode otherwise; plus real stops within 300 m walking distance.
2. **Reachability** (`server/gtfs_static.py`): a Route 21 trip serves the origin
   and then the destination stop later (stop_sequence). Stops at the destination
   (≤120 m) are tried before walking-distance stops. PRIMARY first →
   `ok`; else OPPOSITE → `opposite_direction` ("please use the Walnut St &
   37th St stop", no ETA, no LED); else `no_direct_route`. No transfers.
3. **ETA** (`server/septa_live.py`): live Route 21 TripUpdates at 623 for trips
   that continue to the destination stop; scheduled `/sms` fallback labeled `SCHEDULED`.

## Three synchronized interfaces (bus-stop test)

| page | device | shows |
|---|---|---|
| `/monitor` | laptop (researcher only) | full pipeline + controls |
| `/input` | iPhone, portrait, on the bus-stop wall | rider-facing AI panel only (face, prompts, speech) |
| `/output` | iPad at the seat | the LED tile only |

URLs — local: `http://localhost:5174/monitor` · `/input` · `/output` (or `/#/monitor` …).
Deployed (GitHub Pages needs the hash form):
`https://az1938.github.io/septa-seat-level-ai/#/monitor` · `#/input` · `#/output`.

**Shared session.** The backend keeps ONE in-memory rider session
(`server/session_store.py`; single installation, no accounts):

- `GET /api/session` — full session (`/monitor`, polled every 1 s)
- `GET /api/session?view=output` — LED part only (`/output`, every 1 s)
- `GET /api/session?view=input` — status + reset counter (`/input`, every 1 s)
- `POST /api/session/update` — `/input` reports its client state (state machine,
  camera, microphone, speech support)
- `POST /api/session/reset` — `{"scope":"input"}` **Reset Input** (/input → IDLE,
  LED kept) · `{"scope":"led"}` **Clear Session / LED** (route, ETA, trip cleared →
  /output blank; /input untouched)
- `POST /api/session/mock` — test mode: `{"eta_minutes":5,"seconds_per_min":60|10|null}`

`/api/interpret-destination` and `/api/recommend-route` write their results into
the session automatically. A Route 21 recommendation (status `ok`) assigns the LED;
walking, opposite-direction, no-route and clarification results never do. `/input`
returning to IDLE never clears the LED.

**LED live refresh** now runs in the backend: while the LED is active, the session
re-checks the next Route 21 arrival at 623 every 10 s (same trip, scheduled
fallback). A failed refresh keeps the last ETA; once the tracked bus was ≤ 1 min
away and leaves the live feed, the tile holds ARRIVING. Cleared only by
**Clear Session / LED** (or replaced by the next recommendation).

**Render:** the session is in memory, so the backend must be ONE process:
start command `gunicorn app:app --workers 1 --threads 8` (also set in
`server/gunicorn.conf.py`). `/monitor` warns if responses come from different
processes.

**Spoken recommendation** (unchanged): "Take Route 21. It arrives in 3 minutes.
Please have a seat and follow the display in front of you." — then /input returns
to IDLE.

**iPhone notes:** camera + microphone need HTTPS (or `localhost`). /input opens
straight into IDLE (no setup screen). iOS may block spoken audio until the screen
has been touched once — any tap unlocks it silently; until then prompts and
results are still shown as text. `/monitor` shows "audio unlocked: NO" in that
case, and a red alert if the phone's browser has no SpeechRecognition API.

### Test all three screens on one Mac

1. `cd server && source venv/bin/activate && python3 app.py` (backend :8788)
2. `npm run dev` (frontend :5174)
3. Open three windows: `localhost:5174/monitor`, `/input`, `/output`
   (Safari → Develop → Enter Responsive Design Mode for iPhone / iPad sizes).
4. On /monitor: **Mock Route 21** (fast countdown) → /output shows 21 · 5 MIN and
   counts down; **Reset Input** → /input to IDLE, LED stays; **Clear Session / LED**
   → /output blank.
5. Real flow: speak into /input on the Mac (Chrome) → /output lights up for Route 21.
6. Other devices on the same Wi-Fi: `npm run dev -- --host` and open
   `http://<mac-ip>:5174/output` (LED + monitor work over http; /input needs
   HTTPS for camera/mic → use the deployed GitHub Pages URL on the iPhone).

## Structure

```
src/
  state/interactionMachine.ts   states, events, pure reducer (the state machine)
  components/AiPanel.tsx        Frame 1 — AI interaction panel
  components/AiFace.tsx         the face (mood per state)
  components/Waveform.tsx       listening waveform (visual only for now)
  components/LedTile.tsx        Frame 2 — seat-level LED tile
  components/DevController.tsx  developer-only controls
  lib/led.ts                    LED color thresholds
  App.tsx                       one reducer, two frames
```

## LED color rules

| ETA | Color |
|---|---|
| > 8 min | red |
| 4–8 min | yellow |
| 1–3 min | green |
| < 1 min ("ARRIVING") | white |
