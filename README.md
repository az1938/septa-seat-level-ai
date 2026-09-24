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

Origins (verified from GTFS at every backend start — it refuses to run if they
stop matching the feed):

| | stop | name | direction | routes |
|---|---|---|---|---|
| PRIMARY (this kiosk) | 14079 | Walnut St & 15th St | westbound (dir 1) | 9 Andorra · 21 69th St TC · 42 Wycombe / 61st-Pine |
| OPPOSITE | 6060 | Chestnut St & 15th St | eastbound (dir 0) | 9 4th-Walnut · 21 Columbus-Dock · 42 2nd-Spruce |

1. **Destination → stops** (`server/destination_match.py`): GTFS stop-name match
   for intersections, Philadelphia block-number grid for addresses, Nominatim
   geocode otherwise; plus real stops within 300 m walking distance.
2. **Reachability** (`server/gtfs_static.py`): same trip serves the origin and
   then the destination stop later (stop_sequence). Stops at the destination
   (≤120 m) are tried before walking-distance stops. PRIMARY first →
   `ok`; else OPPOSITE → `opposite_direction` ("please use the Chestnut St &
   15th St stop", no ETA, no LED); else `no_direct_route`.
3. **ETA** (`server/septa_live.py`): live TripUpdates at 14079 for trips that
   reach the destination stop; scheduled `/sms` fallback labeled `SCHEDULED`.

## Recommendation + LED live refresh

- RECOMMENDATION speaks once: "Take Route 21. It arrives in 3 minutes. Please have
  a seat and follow the display in front of you." (1 → "1 minute"; 0 → "Route 21
  is arriving now. …"). 2 s after it finishes, Frame 1 returns to IDLE.
- The LED keeps the route and polls `GET /api/eta?route=&stop=14079&dest=&trip_id=`
  every 10 s (chosen route only — no AI, matching or re-selection). It tracks the
  same bus; when that bus reaches the stop the tile holds ARRIVING.
- A failed refresh keeps the last ETA (DEV panel shows the error) and retries on
  the next poll. The LED is cleared only with DEV "Clear LED" for now.

## Dev controller (bottom-right)

- **Next ▸** / `→` / `Space` — send the normal event for the current state
- **1–5** — jump straight to a state
- **Reset** / `Esc` — back to IDLE
- `` ` `` — hide / show the controller
- Mock route (9 / 21 / 42) and ETA (12 / 6 / 2 / arriving) to preview LED colors

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
