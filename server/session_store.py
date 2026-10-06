"""
Shared prototype session — ONE in-memory rider session for a single bus-stop
installation (no accounts, no multiple simultaneous riders).

Three devices read/write it over HTTP (polling, no WebSockets):
  /input   (iPhone)  drives the conversation; its client-side state (state machine,
                     camera, microphone, speech) arrives via POST /api/session/update.
                     The backend's own actions (interpret-destination,
                     recommend-route) write the pipeline results here automatically.
  /output  (iPad)    reads only the LED part (route / ETA) — GET /api/session?view=output
  /monitor (laptop)  reads everything — GET /api/session

Two parts with separate lifetimes (mirrors the old AI-panel / LED split):
  • rider part  — status, transcript, AI interpretation, routing, message …
                  "Reset Input" returns /input to IDLE; it never touches the LED.
  • LED part    — route, eta_minutes, eta_source, trip_id, destination_stop …
                  set when Route 21 is recommended; kept when /input goes back
                  to IDLE; emptied only by "Clear Session / LED".

Live ETA refresh happens HERE (every LED_REFRESH_S while the LED is active), so
the iPad only has to display what the session says. Same rules as the old
browser-side refresh: follow the same trip; a failed refresh keeps the last ETA;
once the tracked bus was ≤ 1 min away and drops out of the live feed, the tile
holds ARRIVING and refreshing stops.

IMPORTANT: in-memory → the backend must run as ONE process (gunicorn
--workers 1 --threads 8; see gunicorn.conf.py). Each response carries
server.pid so the monitor can warn if requests hit different processes.
"""

from __future__ import annotations

import copy
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Callable

LED_REFRESH_S = 10
MAX_ERRORS = 25

RIDER_STATUSES = {
    "idle", "person_detected", "listening", "processing", "needs_clarification",
    "recommendation", "walk_recommended", "opposite_direction", "no_direct_route", "error",
}
# client-reported /input fields accepted by POST /api/session/update
INPUT_FIELDS = {
    "state", "prompt", "retry_count", "retry_reason", "transcript", "normalized_transcript",
    "speech_status", "voice", "speech_supported", "mic_status", "listening", "interim", "speech_error",
    "camera_status", "model_status", "person_present", "raw_detected", "score", "camera_error",
    "interpretation_phase", "interpretation_error", "routing_phase", "routing_error",
    "speech_unlocked", "user_agent", "viewport",
}

_lock = threading.Lock()
_started = time.time()
_eta_fetcher: Callable[[str, str, str | None, str | None], dict] | None = None
_refresh_inflight = False


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _blank_rider():
    return {
        "status": "idle",
        "raw_transcript": None,
        "local_hint": None,
        "interpreted_destination": None,
        "resolved_place": None,
        "resolved_address": None,
        "walking_minutes": None,
        "message": None,
        "interpretation": None,  # full /api/interpret-destination result (monitor)
        "interpretation_phase": None,  # pending | done | error
        "interpretation_error": None,
        "routing": None,  # full /api/recommend-route result (monitor)
        "routing_phase": None,
        "routing_error": None,
        "ride_started_at": None,
    }


def _blank_led():
    return {
        "route": None,
        "eta_minutes": None,
        "eta_source": None,
        "trip_id": None,
        "destination_stop": None,
        "destination_name": None,
        "origin_stop": None,
        "led_active": False,
        "led_mock": False,
        "led_assigned_at": None,
        "led_refreshed_at": None,
        "led_refresh_error": None,
        "led_arrived": False,  # holding ARRIVING, refresh stopped
        # mock countdown (test mode)
        "mock_start_eta": None,
        "mock_started_at": None,
        "mock_seconds_per_min": None,
    }


_session: dict = {
    "session_id": uuid.uuid4().hex[:12],
    "version": 0,
    **_blank_rider(),
    **_blank_led(),
    "input": {},
    "input_last_update": None,
    "input_last_poll": None,
    "output_last_poll": None,
    "input_reset_seq": 0,
    "errors": [],
    "updated_at": _now_iso(),
}


def set_eta_fetcher(fn):
    """fn(route, stop, dest, trip_id) → dict like GET /api/eta (status, eta_minutes,
    eta_source, trip_id, tracked_trip_missing, live_error); raises on failure."""
    global _eta_fetcher
    _eta_fetcher = fn


def _touch():
    _session["version"] += 1
    _session["updated_at"] = _now_iso()


def _error(source: str, message: str):
    _session["errors"] = ([{"at": _now_iso(), "source": source, "message": str(message)[:400]}]
                          + _session["errors"])[:MAX_ERRORS]


# ─── reads ───────────────────────────────────────────────────────────────────


def _server_info():
    return {"pid": os.getpid(), "started_at": datetime.fromtimestamp(_started, timezone.utc).isoformat()}


def snapshot(view: str = "full") -> dict:
    """view = full (monitor) | output (LED only) | input (commands for /input)."""
    _maybe_refresh_led()
    with _lock:
        now = time.time()
        if view == "output":
            _session["output_last_poll"] = now
        elif view == "input":
            _session["input_last_poll"] = now
        s = _session
        if view == "output":
            keys = ("session_id", "version", "route", "eta_minutes", "eta_source", "led_active", "led_arrived",
                    "led_mock", "updated_at")
            return {**{k: s[k] for k in keys}, "server": _server_info()}
        if view == "input":
            return {"session_id": s["session_id"], "version": s["version"], "status": s["status"],
                    "input_reset_seq": s["input_reset_seq"], "server": _server_info()}
        out = copy.deepcopy(s)
        out["server"] = _server_info()
        out["now"] = now
        return out


# ─── /input client state ─────────────────────────────────────────────────────


def update_from_input(body: dict):
    """Merge whitelisted client-reported fields from /input."""
    with _lock:
        inp = body.get("input") or {}
        prev_state = _session["input"].get("state")
        clean = {k: inp[k] for k in INPUT_FIELDS if k in inp}
        _session["input"].update(clean)
        _session["input_last_update"] = time.time()
        new_state = _session["input"].get("state")

        # a new rider: IDLE → PERSON_DETECTED with the first "Where are you going?"
        if new_state == "PERSON_DETECTED" and prev_state != "PERSON_DETECTED" and _session["input"].get("prompt") == "ask":
            _session.update(_blank_rider())
            _session["ride_started_at"] = _now_iso()

        status = body.get("status")
        if status in RIDER_STATUSES:
            _session["status"] = status
        if "message" in body:
            _session["message"] = (str(body["message"])[:300] if body["message"] else None)
        for e in (body.get("errors") or [])[:5]:
            _error("input", e)
        _touch()


# ─── backend actions (called from app.py endpoints) ──────────────────────────


def interpretation_started(transcript: str, local_hint: str | None):
    with _lock:
        _session.update(status="processing", raw_transcript=transcript, local_hint=local_hint,
                        interpretation=None, interpretation_phase="pending", interpretation_error=None,
                        interpreted_destination=None, resolved_place=None, resolved_address=None,
                        routing=None, routing_phase=None, routing_error=None, walking_minutes=None)
        _touch()


def interpretation_done(result: dict):
    with _lock:
        v = result.get("verification") or {}
        _session.update(interpretation=result, interpretation_phase="done",
                        interpreted_destination=result.get("interpreted_destination"),
                        resolved_place=v.get("resolved_place"), resolved_address=v.get("resolved_address"))
        if result.get("status") in ("needs_clarification", "not_a_destination"):
            _session["status"] = "needs_clarification"
            _session["message"] = "Sorry, I didn't catch that. Please say your destination again."
        _touch()


def interpretation_failed(code: str, message: str):
    with _lock:
        _session.update(interpretation_phase="error", interpretation_error=f"{code}: {message}", status="error")
        _error("interpret-destination", f"{code}: {message}")
        _touch()


def routing_started():
    with _lock:
        _session.update(routing=None, routing_phase="pending", routing_error=None)
        _touch()


def routing_done(result: dict):
    """Route 21 / walk / opposite / none. Only status 'ok' assigns the LED."""
    with _lock:
        st = result.get("status")
        _session.update(routing=result, routing_phase="done")
        if result.get("resolved_place"):
            _session["resolved_place"] = result["resolved_place"]
        if result.get("resolved_address"):
            _session["resolved_address"] = result["resolved_address"]
        walk = result.get("walking") or {}
        _session["walking_minutes"] = result.get("walking_minutes") or walk.get("minutes")
        if st == "ok":
            _session["status"] = "recommendation"
            _assign_led_locked(result)
        elif st in ("walk_recommended", "opposite_direction", "no_direct_route"):
            _session["status"] = st
        else:  # destination_not_found / no_eta_available
            _session["status"] = "error"
            _error("recommend-route", st or "unknown routing result")
        _touch()


def routing_failed(code: str, message: str):
    with _lock:
        _session.update(routing_phase="error", routing_error=f"{code}: {message}", status="error")
        _error("recommend-route", f"{code}: {message}")
        _touch()


def _assign_led_locked(result: dict):
    _session.update(_blank_led())
    _session.update(
        session_id=uuid.uuid4().hex[:12],
        route=result.get("selected_route"),
        eta_minutes=result.get("eta_minutes"),
        eta_source=result.get("eta_source"),
        trip_id=result.get("selected_trip_id"),
        destination_stop=result.get("destination_stop"),
        destination_name=result.get("destination_name"),
        origin_stop=result.get("origin_stop"),
        led_active=True,
        led_assigned_at=time.time(),
        led_refreshed_at=time.time(),
    )


# ─── researcher actions ──────────────────────────────────────────────────────


def reset_input():
    """RESET INPUT: /input back to IDLE (it sees input_reset_seq change). LED untouched."""
    with _lock:
        _session["input_reset_seq"] += 1
        _session["status"] = "idle"
        _session["message"] = None
        _touch()


def clear_led():
    """CLEAR SESSION / LED: route, ETA, trip cleared → /output goes blank. /input untouched."""
    with _lock:
        _session.update(_blank_led())
        _session["session_id"] = uuid.uuid4().hex[:12]
        _touch()


def mock_led(eta_minutes: float, seconds_per_min: float | None):
    """TEST MODE: Route 21 with a mock ETA (no SEPTA). If seconds_per_min is set, the
    ETA counts down by 1 every seconds_per_min seconds until ARRIVING."""
    with _lock:
        _session.update(_blank_led())
        _session.update(
            session_id=uuid.uuid4().hex[:12],
            route="21", eta_minutes=max(0, int(eta_minutes)), eta_source="MOCK", led_active=True, led_mock=True,
            led_assigned_at=time.time(), led_refreshed_at=time.time(),
            mock_start_eta=max(0, int(eta_minutes)), mock_started_at=time.time(),
            mock_seconds_per_min=seconds_per_min if seconds_per_min and seconds_per_min > 0 else None,
        )
        _touch()


# ─── LED live refresh (lazy: driven by the 1 s polls) ────────────────────────


def _maybe_refresh_led():
    global _refresh_inflight
    with _lock:
        s = _session
        if not s["led_active"] or s["led_arrived"]:
            return
        if s["led_mock"]:
            if s["mock_seconds_per_min"]:
                elapsed = time.time() - s["mock_started_at"]
                eta = max(0, s["mock_start_eta"] - int(elapsed // s["mock_seconds_per_min"]))
                if eta != s["eta_minutes"]:
                    s["eta_minutes"] = eta
                    s["led_refreshed_at"] = time.time()
                    if eta == 0:
                        s["led_arrived"] = True
                    _touch()
            return
        if _refresh_inflight or _eta_fetcher is None:
            return
        if time.time() - (s["led_refreshed_at"] or 0) < LED_REFRESH_S:
            return
        _refresh_inflight = True
        args = (s["route"], s["origin_stop"], s["destination_stop"], s["trip_id"], s["session_id"], s["eta_minutes"])
        s["led_refreshed_at"] = time.time()  # also spaces out retries after a failure
    threading.Thread(target=_refresh_worker, args=args, daemon=True).start()


def _refresh_worker(route, stop, dest, trip_id, sid, last_eta):
    global _refresh_inflight
    try:
        body = _eta_fetcher(route, stop, dest, trip_id)
        err = None
    except Exception as e:  # network / SEPTA down → keep last ETA
        body, err = None, str(e)
    with _lock:
        _refresh_inflight = False
        s = _session
        if s["session_id"] != sid or not s["led_active"]:
            return  # LED was cleared / replaced meanwhile
        if err or not body or body.get("status") != "ok":
            s["led_refresh_error"] = err or (body or {}).get("live_error") or "no live or scheduled ETA right now"
            _touch()
            return
        if body.get("tracked_trip_missing") and last_eta is not None and last_eta <= 1:
            # our bus was ~1 min out and is no longer predicted → it is at / past the stop
            s.update(eta_minutes=0, led_arrived=True, led_refresh_error=None)
        else:
            s.update(eta_minutes=body.get("eta_minutes"), eta_source=body.get("eta_source"),
                     trip_id=body.get("trip_id") or s["trip_id"], led_refresh_error=None)
        _touch()
