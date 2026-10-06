"""
Week 3 backend — AI destination interpretation (OpenAI) + direct-route
recommendation (static GTFS + live SEPTA).

POST /api/interpret-destination   { "transcript": "3737 Chestnut Street" }
POST /api/recommend-route         { "destination_text": "...", "intersection_or_address": "...", ... }
GET  /api/eta?route=21&stop=623&dest=21353&trip_id=…   (LED refresh, Route 21 only)

Destination recovery is retrieve-then-reason (destination_recovery.py): the raw
transcript becomes a few search variants, those are searched in REAL place data
(Photon / Nominatim / curated list / street grid), and OpenAI only ranks the real
places that came back. The AI never chooses routes, ETAs, stops, or anything
about SEPTA. Transit decisions come later from GTFS / SEPTA data.

The API key is read from the environment (server/.env, never committed).

Run:
    cd server
    python3 -m venv venv && source venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env        # then paste your OPENAI_API_KEY into .env
    python3 app.py              # → http://localhost:8788
"""

import json
import os
import threading
from datetime import datetime
from pathlib import Path

import openai
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from openai import OpenAI

import gtfs_static
import septa_live
import session_store
import walking
from destination_match import WALK_RADIUS_M, StopNameIndex, find_candidate_stops, stops_near
from destination_recovery import (
    RANK_PROMPT,
    RANK_SCHEMA,
    VARIANT_PROMPT,
    VARIANT_SCHEMA,
    PlaceSearchUnavailable,
    recover_destination,
)

load_dotenv(Path(__file__).with_name(".env"))

PORT = int(os.environ.get("PORT", "8788"))
MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")
# Reasoning is unnecessary for short parsing; "none" is fastest and allows temperature.
# Set OPENAI_REASONING_EFFORT= (empty) if you switch to a model without a reasoning setting.
REASONING_EFFORT = os.environ.get("OPENAI_REASONING_EFFORT", "none").strip()
MAX_TRANSCRIPT_CHARS = 300
AI_TIMEOUT_SECONDS = 20

app = Flask(__name__)

# CORS: only these frontend origins may call the API from a browser (no wildcard).
#   https://az1938.github.io  — deployed GitHub Pages frontend
#   http://localhost:5174     — local Vite dev server
# Applies to every /api/* route (health, interpret-destination, recommend-route, eta).
ALLOWED_ORIGINS = [
    "https://az1938.github.io",
    "http://localhost:5174",
]
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
    methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ─── Prompt + structured output ─────────────────────────────────────────────
# The destination-recovery prompt and JSON schema live in destination_recovery.py.

def error(code: str, message: str, http: int):
    return jsonify({"status": "error", "error_code": code, "error": message}), http


def call_openai(client: OpenAI, instructions: str, ai_input: str, schema: dict, name: str,
                max_tokens: int = 700) -> dict:
    """One structured-output call. Drops optional params the model rejects."""
    params = {
        "model": MODEL,
        "instructions": instructions,
        "input": ai_input,
        "max_output_tokens": max_tokens,
        "temperature": 0,
        "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema}},
    }
    if REASONING_EFFORT:
        params["reasoning"] = {"effort": REASONING_EFFORT}

    for _ in range(3):
        try:
            resp = client.responses.create(**params)
            break
        except openai.BadRequestError as e:
            msg = str(e).lower()
            # Some models don't accept temperature or a reasoning setting — retry without.
            if "temperature" in msg and "temperature" in params:
                params.pop("temperature")
                continue
            if "reasoning" in msg and "reasoning" in params:
                params.pop("reasoning")
                continue
            raise
    else:
        raise RuntimeError("OpenAI request could not be made with the given parameters")

    text = (resp.output_text or "").strip()
    if not text:
        raise ValueError("empty model output (possibly a refusal)")
    return json.loads(text)


# ─── Endpoint ───────────────────────────────────────────────────────────────


def _payload(rv):
    """Flask view return value → (dict, http_status)."""
    resp, code = (rv if isinstance(rv, tuple) else (rv, None))
    return resp.get_json(silent=True) or {}, code or resp.status_code


@app.post("/api/interpret-destination")
def interpret_destination():
    """Runs the destination recovery AND records it in the shared session (monitor)."""
    body = request.get_json(silent=True) or {}
    transcript = str(body.get("transcript", "")).strip()[:MAX_TRANSCRIPT_CHARS]
    if transcript:
        session_store.interpretation_started(transcript, str(body.get("local_hint") or "").strip() or None)
    rv = _interpret_destination_impl()
    data, code = _payload(rv)
    if transcript:
        if code == 200 and data.get("status") != "error":
            session_store.interpretation_done(data)
        else:
            session_store.interpretation_failed(data.get("error_code", f"http_{code}"), data.get("error", ""))
    return rv


def _interpret_destination_impl():
    body = request.get_json(silent=True) or {}
    transcript = str(body.get("transcript", "")).strip()  # RAW browser transcript
    local_hint = str(body.get("local_hint") or "").strip()[:MAX_TRANSCRIPT_CHARS] or None

    if not transcript:
        return error("empty_transcript", "Transcript is empty — nothing to interpret.", 400)
    transcript = transcript[:MAX_TRANSCRIPT_CHARS]

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return error(
            "missing_api_key",
            "OPENAI_API_KEY is not set. Add it to server/.env and restart the server.",
            500,
        )

    client = OpenAI(api_key=api_key, timeout=AI_TIMEOUT_SECONDS, max_retries=1)
    try:
        names = get_name_index()
    except Exception as e:
        return error("gtfs_unavailable", f"Static GTFS could not be loaded: {e}", 503)

    # Retrieve, then reason (destination_recovery.py):
    #   transcript → search variants → REAL place search → AI ranks the real places → verified pick
    def ai_variants(raw):  # optional spelling fixes (search terms only) + an explicitly named town
        return call_openai(client, VARIANT_PROMPT, f"RAW TRANSCRIPT: {raw!r}", VARIANT_SCHEMA,
                           "search_variants", 250)

    def rank(ai_input):  # the AI may only choose among the real candidates in ai_input
        data = call_openai(client, RANK_PROMPT, ai_input, RANK_SCHEMA, "rank_real_places")
        if not isinstance(data, dict):
            raise ValueError("AI did not return a structured ranking")
        return data

    try:
        result = recover_destination(transcript, local_hint, names, rank, ai_variants, MODEL)
    except PlaceSearchUnavailable as e:
        return error("place_search_unavailable", f"Real place search is unreachable: {e}", 503)
    except openai.AuthenticationError:
        return error("invalid_api_key", "The OpenAI API key was rejected (invalid or revoked).", 502)
    except openai.PermissionDeniedError as e:
        return error("permission_denied", f"API key lacks permission for this model: {e}", 502)
    except openai.NotFoundError:
        return error("bad_model", f"Model '{MODEL}' not found for this key. Check OPENAI_MODEL.", 502)
    except openai.RateLimitError as e:
        if "insufficient_quota" in str(e):
            return error("insufficient_quota", "OpenAI account has no remaining credits/quota.", 402)
        return error("rate_limited", "AI API rate limit hit — try again shortly.", 503)
    except openai.APITimeoutError:
        return error("timeout", "AI API timed out.", 504)
    except openai.APIConnectionError as e:
        return error("network", f"Could not reach the AI API: {e}", 502)
    except openai.APIError as e:
        return error("ai_error", f"AI API error: {e}", 502)
    except (ValueError, json.JSONDecodeError, RuntimeError) as e:
        return error("bad_ai_output", f"AI did not return a structured ranking: {e}", 502)
    return jsonify(result)


# ─── Transit: destination → Route 21 reachability + live ETA ────────────────
#
# This prototype supports ONE route: Route 21 (gtfs_static.SUPPORTED_ROUTES).
# No route comparison, no fastest-route selection. Responsibilities stay separate:
#   destination_match  → which SEPTA stops are at/near the destination
#   gtfs_static        → does a Route 21 trip reach that stop directly (same trip,
#                        later stop_sequence) from the PRIMARY origin 623
#                        (Chestnut St & 37th St, eastbound) or the OPPOSITE origin
#                        21362 (Walnut St & 37th St, westbound)
#   septa_live         → live (or labeled scheduled) Route 21 ETA at the primary origin
#   walking            → walking time from the origin; ≤ 10 min → "walk_recommended"
#                        (checked FIRST, before Route 21; only a suggestion to the rider)
# The AI plays no part here.

AT_DESTINATION_M = 120  # a stop this close counts as "at" the destination

_name_index = None


def get_name_index():
    global _name_index
    if _name_index is None:
        _name_index = StopNameIndex(gtfs_static.get_index().stops)
    return _name_index


ROUTE = gtfs_static.ROUTE


def nearest_reachable(idx, candidates, origin):
    """Closest candidate stop that a Route 21 trip from `origin` serves later in the
    same trip → (stop_id, distance_m) or None."""
    for sid, d in sorted(candidates, key=lambda x: x[1]):
        if idx.reaches(sid, origin):
            return sid, d
    return None


@app.post("/api/recommend-route")
def recommend_route():
    """Route 21 decision AND shared-session update (status ok → the LED on /output)."""
    session_store.routing_started()
    rv = _recommend_route_impl()
    data, code = _payload(rv)
    if code == 200 and data.get("status") != "error":
        session_store.routing_done(data)
    else:
        session_store.routing_failed(data.get("error_code", f"http_{code}"), data.get("error", ""))
    return rv


def _recommend_route_impl():
    body = request.get_json(silent=True) or {}
    dest = {
        k: str(body.get(k) or "").strip()
        for k in ("destination_text", "intersection_or_address", "place_name", "destination_type",
                  "resolved_place", "resolved_address", "verification_method")
    }
    # coordinates of an AI-recovered destination that was verified against real place data
    dest["verified_lat"] = body.get("verified_lat")
    dest["verified_lon"] = body.get("verified_lon")
    if not (dest["destination_text"] or dest["intersection_or_address"] or dest["place_name"]):
        return error("empty_destination", "No destination given.", 400)

    try:
        idx = gtfs_static.get_index()
        names = get_name_index()
    except Exception as e:
        return error("gtfs_unavailable", f"Static GTFS could not be loaded: {e}", 503)

    origin = gtfs_static.PRIMARY_ORIGIN
    opposite = gtfs_static.OPPOSITE_ORIGIN
    base = {
        "origin_stop": origin,
        "origin_name": idx.stops[origin]["name"],
        "destination_input": dest,
        "checked_at": datetime.now(septa_live.APP_TZ).isoformat(),
    }

    # 1. destination → candidate stops (exact matches + real stops within walking distance)
    match = find_candidate_stops(names, dest)
    stop_info = lambda sid, d: {"stop_id": sid, "name": idx.stops[sid]["name"], "distance_m": d}
    base["match_method"] = match["method"]
    base["match_query"] = match.get("query")
    base["geocode"] = match.get("geocode")
    # DEV: what the destination resolved to before stop matching
    base["resolved_place"] = match.get("resolved_place") or dest["place_name"] or None
    base["resolved_address"] = match.get("resolved_address") or (
        match["geocode"]["label"] if match.get("geocode") else None
    )
    if match.get("matched_alias"):
        base["matched_alias"] = match["matched_alias"]
    if match["errors"]:
        base["match_errors"] = match["errors"]

    # 2. walkable? (decision order: verified destination → walking time → Route 21)
    #    Walking is only SUGGESTED to the rider; the Route 21 facts are still worked out
    #    below and kept in the response (DEV / internal state), but no ETA is fetched.
    dest_point = match.get("point")
    if not dest_point and match["candidates"]:
        s0 = idx.stops[min(match["candidates"], key=lambda x: x[1])[0]]
        dest_point = (s0["lat"], s0["lon"])
    o = idx.stops[origin]
    walk = walking.estimate_walk((o["lat"], o["lon"]), dest_point[:2]) if dest_point else {
        "walkable": False, "source": "unavailable (no destination point)"}
    base["walking"] = walk

    if not match["candidates"]:
        if walk.get("walkable"):  # a short walk even though no SEPTA stop is nearby
            return jsonify({**base, "status": "walk_recommended", "walking_minutes": walk["minutes"],
                            "walking_distance_m": walk["distance_m"],
                            "destination_name": base["resolved_place"] or dest["destination_text"] or None,
                            "destination_address": base["resolved_address"] or None,
                            "route21_if_not_walking": {"status": "destination_not_found"}, "candidate_stops": []})
        return jsonify({**base, "status": "destination_not_found", "candidate_stops": []})

    candidates = dict(match["candidates"])
    if match.get("point"):
        base["destination_point"] = {"lat": match["point"][0], "lon": match["point"][1]}
        for sid, d in stops_near(idx.stops, match["point"], WALK_RADIUS_M):
            candidates[sid] = d if sid not in candidates else min(candidates[sid] or d, d)
    candidates = sorted(candidates.items(), key=lambda x: x[1])
    base["candidate_stops"] = [stop_info(sid, d) for sid, d in candidates[:12]]

    # 3. static GTFS reachability on Route 21, in two distance tiers so a stop AT
    #    the destination always beats a stop a block away:
    #      tier 1: stops at the destination (≤ AT_DESTINATION_M)
    #      tier 2: stops within walking distance (≤ WALK_RADIUS_M)
    #    In each tier: PRIMARY origin first (A) → else OPPOSITE origin (B).
    hit = other = None
    for limit in (AT_DESTINATION_M, WALK_RADIUS_M):
        tier = [(sid, d) for sid, d in candidates if d <= limit]
        hit = nearest_reachable(idx, tier, origin)
        if hit:
            break
        other = nearest_reachable(idx, tier, opposite)
        if other:
            break

    if walk.get("walkable"):
        # Short walk → suggest walking; stop here (no bus recommendation, no ETA, no LED).
        transit = (
            {"status": "ok", "destination_stop": hit[0], "from_stop": origin} if hit
            else {"status": "opposite_direction", "destination_stop": other[0], "from_stop": opposite} if other
            else {"status": "no_direct_route"}
        )
        return jsonify({
            **base,
            "status": "walk_recommended",
            "walking_minutes": walk["minutes"],
            "walking_distance_m": walk["distance_m"],
            "destination_name": base["resolved_place"] or dest["destination_text"] or None,
            "destination_address": base["resolved_address"] or None,
            "route21_if_not_walking": transit,  # internal / DEV only — not used for the rider
        })

    base["route"] = ROUTE
    if hit is None:
        # B. Route 21 reaches it only from the OPPOSITE-direction stop
        if other:
            sid, d = other
            return jsonify(
                {
                    **base,
                    "status": "opposite_direction",
                    "current_stop_id": origin,
                    "current_stop_name": idx.stops[origin]["name"],
                    "recommended_stop_id": opposite,
                    "recommended_stop_name": idx.stops[opposite]["name"],
                    "destination_stop": sid,
                    "destination_name": idx.stops[sid]["name"],
                    "destination_distance_m": d,
                }
            )
        # C. neither direction of Route 21 reaches it (no transfers)
        return jsonify({**base, "status": "no_direct_route"})

    dest_stop, dist = hit
    base.update(
        destination_stop=dest_stop,
        destination_name=idx.stops[dest_stop]["name"],
        destination_distance_m=dist,
    )

    # 4. next valid Route 21 bus at the origin: live first (only trips that continue to
    #    the destination stop), else SEPTA's scheduled departure (labeled SCHEDULED)
    eta, live_error = None, None
    try:
        arrivals, fetched_at = septa_live.live_arrivals(
            origin,
            {ROUTE},
            trip_route_lookup=lambda t: idx.trip_route.get(t),
            trip_filter=lambda t: idx.trip_reaches(t, dest_stop, origin),
        )
        base["live_feed_fetched_at"] = datetime.fromtimestamp(fetched_at, septa_live.APP_TZ).isoformat()
        if arrivals:
            a = arrivals[0]
            eta = {
                "eta_minutes": septa_live.minutes_until(a["epoch"]),
                "eta_source": "LIVE",
                "predicted_arrival": datetime.fromtimestamp(a["epoch"], septa_live.APP_TZ).isoformat(),
                "selected_trip_id": a["trip_id"],
            }
    except Exception as e:
        live_error = f"live TripUpdates unavailable: {e}"
    if live_error:
        base["live_error"] = live_error

    if eta is None:
        try:
            t = septa_live.scheduled_next(origin, ROUTE)
        except Exception as e:
            base["scheduled_error"] = str(e)
            t = None
        if t:
            eta = {
                "eta_minutes": septa_live.minutes_until(t.timestamp()),
                "eta_source": "SCHEDULED",
                "predicted_arrival": t.isoformat(),
                "selected_trip_id": None,
            }
    if eta is None:
        return jsonify({**base, "status": "no_eta_available"})

    # A. reachable on Route 21 from this stop → recommend it (the LED gets route + ETA)
    return jsonify({**base, "status": "ok", "selected_route": ROUTE, **eta})


# ─── LED refresh: live ETA for the ALREADY-SELECTED route only ───────────────
#
# No AI, no destination matching, no route selection — just the next arrival of
# `route` at `stop` (default: the primary origin 623). If `dest` is given, only trips that reach
# that stop count (short-turns excluded). If `trip_id` is given and still in the
# live feed, that exact bus is tracked; otherwise the soonest valid trip is used
# and `tracked_trip_missing` is true (e.g. the tracked bus has already passed).


class EtaError(Exception):
    def __init__(self, code, message, http):
        super().__init__(message)
        self.code, self.message, self.http = code, message, http


def lookup_eta(route, stop=None, dest=None, trip_id=None) -> dict:
    """Next Route 21 arrival at `stop` (live, else scheduled). Used by GET /api/eta and
    by the shared session's LED refresh. Raises EtaError."""
    stop = stop or gtfs_static.ORIGIN_STOP
    if route not in gtfs_static.SUPPORTED_ROUTES:
        raise EtaError("bad_route", f"only Route {gtfs_static.ROUTE} is supported", 400)
    try:
        idx = gtfs_static.get_index()
    except Exception as e:
        raise EtaError("gtfs_unavailable", f"Static GTFS could not be loaded: {e}", 503)

    base = {"route": route, "stop": stop, "dest": dest, "checked_at": datetime.now(septa_live.APP_TZ).isoformat()}
    live_error = None
    try:
        arrivals, _ = septa_live.live_arrivals(
            stop,
            {route},
            trip_route_lookup=lambda t: idx.trip_route.get(t),
            trip_filter=(lambda t: idx.trip_reaches(t, dest, stop)) if dest else None,
        )
        if arrivals:
            tracked = next((a for a in arrivals if trip_id and a["trip_id"] == trip_id), None)
            a = tracked or arrivals[0]
            return {
                **base,
                "status": "ok",
                "eta_minutes": septa_live.minutes_until(a["epoch"]),
                "eta_source": "LIVE",
                "arrival_time": datetime.fromtimestamp(a["epoch"], septa_live.APP_TZ).isoformat(),
                "trip_id": a["trip_id"],
                "tracked_trip_missing": bool(trip_id) and tracked is None,
            }
    except Exception as e:
        live_error = f"live TripUpdates unavailable: {e}"

    try:
        t = septa_live.scheduled_next(stop, route)
    except Exception as e:
        raise EtaError("eta_unavailable", f"{live_error or 'no live prediction'}; scheduled fallback failed: {e}", 502)
    if not t:
        return {**base, "status": "no_eta", "live_error": live_error}
    return {
        **base,
        "status": "ok",
        "eta_minutes": septa_live.minutes_until(t.timestamp()),
        "eta_source": "SCHEDULED",
        "arrival_time": t.isoformat(),
        "trip_id": None,
        "tracked_trip_missing": bool(trip_id),
        "live_error": live_error,
    }


@app.get("/api/eta")
def eta_refresh():
    try:
        return jsonify(lookup_eta(
            (request.args.get("route") or "").strip(),
            (request.args.get("stop") or "").strip() or None,
            (request.args.get("dest") or "").strip() or None,
            (request.args.get("trip_id") or "").strip() or None,
        ))
    except EtaError as e:
        return error(e.code, e.message, e.http)


# The shared session refreshes the LED's ETA with the same lookup (every 10 s while active).
session_store.set_eta_fetcher(lookup_eta)


# ─── Shared prototype session (three synchronized pages) ─────────────────────
#
#   GET  /api/session                 full session (/monitor)
#   GET  /api/session?view=output     LED part only (/output, every 1 s)
#   GET  /api/session?view=input      status + reset counter (/input, every 1 s)
#   POST /api/session/update          /input reports its client state
#   POST /api/session/reset           {"scope": "input"} → RESET INPUT (LED kept)
#                                     {"scope": "led"}   → CLEAR SESSION / LED
#   POST /api/session/mock            TEST MODE: {"eta_minutes": 5, "seconds_per_min": 60|null}
# No secrets are stored or returned. Single installation, single rider session.


@app.get("/api/session")
def get_session():
    view = request.args.get("view", "full")
    if view not in ("full", "output", "input"):
        view = "full"
    resp = jsonify(session_store.snapshot(view))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/session/update")
def update_session():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return error("bad_request", "JSON object expected", 400)
    session_store.update_from_input(body)
    return jsonify({"ok": True})


@app.post("/api/session/reset")
def reset_session():
    scope = ((request.get_json(silent=True) or {}).get("scope") or "input").strip()
    if scope == "input":
        session_store.reset_input()
    elif scope == "led":
        session_store.clear_led()
    else:
        return error("bad_scope", 'scope must be "input" or "led"', 400)
    return jsonify({"ok": True, "scope": scope})


@app.post("/api/session/mock")
def mock_session():
    body = request.get_json(silent=True) or {}
    try:
        eta = float(body.get("eta_minutes", 5))
        spm = body.get("seconds_per_min")
        spm = float(spm) if spm not in (None, "", 0) else None
    except (TypeError, ValueError):
        return error("bad_request", "eta_minutes / seconds_per_min must be numbers", 400)
    session_store.mock_led(eta, spm)
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "provider": "openai",
            "model": MODEL,
            "api_key_configured": bool(os.environ.get("OPENAI_API_KEY", "").strip()),
            "gtfs": gtfs_static._index.summary() if gtfs_static._index else "not loaded yet",
        }
    )


if __name__ == "__main__":
    print(f"AI interpretation server on http://localhost:{PORT}  (OpenAI model: {MODEL})")
    if not os.environ.get("OPENAI_API_KEY", "").strip():
        print("WARNING: OPENAI_API_KEY is not set — add it to server/.env")
    # Warm the static GTFS index in the serving process (not the reloader parent).
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=gtfs_static.get_index, daemon=True).start()
    app.run(host="127.0.0.1", port=PORT, debug=True, threaded=True)
