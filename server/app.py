"""
Week 3 backend — AI destination interpretation (OpenAI) + direct-route
recommendation (static GTFS + live SEPTA).

POST /api/interpret-destination   { "transcript": "3737 Chestnut Street" }
POST /api/recommend-route         { "destination_text": "...", "intersection_or_address": "...", ... }
GET  /api/eta?route=21&stop=14079&dest=21363&trip_id=…   (LED refresh, chosen route only)

Sends the rider's spoken transcript to the OpenAI API and returns a small,
normalized DESTINATION object. The AI only interprets language: it never
chooses routes, ETAs, stops, or anything about SEPTA. Transit decisions come
later from GTFS / SEPTA data.

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
from openai import OpenAI

import gtfs_static
import septa_live
from destination_match import WALK_RADIUS_M, StopNameIndex, find_candidate_stops, stops_near

load_dotenv(Path(__file__).with_name(".env"))

PORT = int(os.environ.get("PORT", "8788"))
MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")
# Reasoning is unnecessary for short parsing; "none" is fastest and allows temperature.
# Set OPENAI_REASONING_EFFORT= (empty) if you switch to a model without a reasoning setting.
REASONING_EFFORT = os.environ.get("OPENAI_REASONING_EFFORT", "none").strip()
MAX_TRANSCRIPT_CHARS = 300
AI_TIMEOUT_SECONDS = 20

app = Flask(__name__)

# ─── Prompt + structured output ─────────────────────────────────────────────

SYSTEM_PROMPT = """You interpret a bus rider's spoken destination for a transit kiosk.
The rider is at a bus stop at 15th St & Chestnut St in Center City, Philadelphia, PA.
The input is a speech-to-text transcript, so expect recognition errors
(e.g. "sixth" / "6th", "chestnut" / "chess nut", missing "street", filler words).

Your ONLY job: understand WHERE the rider wants to go and normalize it.
Reply with the JSON object defined by the schema.

Rules:
- Assume Philadelphia, PA unless the rider clearly says otherwise.
- Normalize street names: numbered streets as "38th St", named streets as "Chestnut St",
  intersections as "<numbered street> & <named street>" (e.g. "38th St & Chestnut St").
- Street addresses: keep the number the rider said (e.g. "3737 Chestnut St").
- Landmarks / places (e.g. "Independence Hall"): set destination_type "landmark",
  put the official place name in place_name. Only fill intersection_or_address if you are
  highly confident of the well-known street location; otherwise use an empty string.
- Do NOT mention, choose, or guess bus routes, route numbers, stops, stop IDs, schedules,
  ETAs, directions of travel, or any SEPTA information. Never invent facts.
- If the destination is missing, unclear, or could reasonably mean several different
  places, use status "needs_clarification" with ONE short, friendly question.
- If the transcript is not a destination at all, use status "not_a_destination".
- Use empty strings for fields that do not apply.
- confidence is 0–1: how sure you are that the normalized destination is what the rider meant.
"""

# Strict JSON schema (OpenAI Structured Outputs): every field required, no extras.
DESTINATION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "status": {"type": "string", "enum": ["ok", "needs_clarification", "not_a_destination"]},
        "destination_type": {
            "type": "string",
            "enum": ["address", "intersection", "landmark", "area", "unknown"],
        },
        "destination_text": {
            "type": "string",
            "description": "Full normalized destination incl. city, e.g. '38th St & Chestnut St, Philadelphia'. Empty if not ok.",
        },
        "intersection_or_address": {
            "type": "string",
            "description": "Street address or intersection only, e.g. '3737 Chestnut St'. Empty if unknown.",
        },
        "place_name": {"type": "string", "description": "Landmark / place name, else empty."},
        "confidence": {"type": "number", "description": "0 to 1"},
        "clarification_question": {
            "type": "string",
            "description": "Only when status is needs_clarification; else empty.",
        },
    },
    "required": [
        "status",
        "destination_type",
        "destination_text",
        "intersection_or_address",
        "place_name",
        "confidence",
        "clarification_question",
    ],
}


def error(code: str, message: str, http: int):
    return jsonify({"status": "error", "error_code": code, "error": message}), http


def call_openai(client: OpenAI, transcript: str) -> dict:
    """One structured-output call. Drops optional params the model rejects."""
    params = {
        "model": MODEL,
        "instructions": SYSTEM_PROMPT,
        "input": f"Rider transcript: {transcript!r}",
        "max_output_tokens": 400,
        "temperature": 0,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "destination",
                "strict": True,
                "schema": DESTINATION_SCHEMA,
            }
        },
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


@app.post("/api/interpret-destination")
def interpret_destination():
    body = request.get_json(silent=True) or {}
    transcript = str(body.get("transcript", "")).strip()

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
        data = call_openai(client, transcript)
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
        return error("bad_ai_output", f"AI did not return a structured destination: {e}", 502)

    if not isinstance(data, dict):
        return error("bad_ai_output", "AI did not return a structured destination.", 502)
    return jsonify(normalize(transcript, data))


def normalize(transcript: str, d: dict) -> dict:
    """Shape the AI output into the stable response the frontend expects."""
    status = (
        d.get("status")
        if d.get("status") in ("ok", "needs_clarification", "not_a_destination")
        else "needs_clarification"
    )
    try:
        confidence = max(0.0, min(1.0, float(d.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0.0

    out = {
        "status": status,
        "raw_transcript": transcript,
        "destination_type": d.get("destination_type") or "unknown",
        "destination_text": (d.get("destination_text") or "").strip() or None,
        "intersection_or_address": (d.get("intersection_or_address") or "").strip() or None,
        "place_name": (d.get("place_name") or "").strip() or None,
        "confidence": round(confidence, 2),
        "clarification_question": None,
        "model": MODEL,
    }
    if status != "ok":
        # never pass along an invented destination when the AI wasn't sure
        out["destination_text"] = out["intersection_or_address"] = out["place_name"] = None
        out["clarification_question"] = (d.get("clarification_question") or "").strip() or (
            "Sorry, where would you like to go?"
        )
    elif not out["destination_text"]:
        out["status"] = "needs_clarification"
        out["clarification_question"] = "Sorry, where would you like to go?"
    return out


# ─── Transit: destination → direct route + live ETA ─────────────────────────
#
# Responsibilities stay separate:
#   destination_match  → which SEPTA stops are at/near the destination
#   gtfs_static        → which of routes 9/21/42 reach that stop directly
#                        (same trip, later stop_sequence) from the PRIMARY
#                        origin 14079 (westbound) or the OPPOSITE origin 6060
#   septa_live         → live (or labeled scheduled) ETA at the primary origin
# The AI plays no part here.

AT_DESTINATION_M = 120  # a stop this close counts as "at" the destination

_name_index = None


def get_name_index():
    global _name_index
    if _name_index is None:
        _name_index = StopNameIndex(gtfs_static.get_index().stops)
    return _name_index


def best_reachable(idx, candidates, origin):
    """Closest candidate stop reachable directly from `origin` → (stop_id, distance_m, routes) or None."""
    reachable = []
    for sid, d in candidates:
        routes = idx.routes_reaching(sid, origin)
        if routes:
            reachable.append((d, -len(routes), sid, routes))
    if not reachable:
        return None
    d, _, sid, routes = min(reachable)
    return sid, d, routes


@app.post("/api/recommend-route")
def recommend_route():
    body = request.get_json(silent=True) or {}
    dest = {
        k: str(body.get(k) or "").strip()
        for k in ("destination_text", "intersection_or_address", "place_name", "destination_type")
    }
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
    if not match["candidates"]:
        return jsonify({**base, "status": "destination_not_found", "candidate_stops": []})

    candidates = dict(match["candidates"])
    if match.get("point"):
        base["destination_point"] = {"lat": match["point"][0], "lon": match["point"][1]}
        for sid, d in stops_near(idx.stops, match["point"], WALK_RADIUS_M):
            candidates[sid] = d if sid not in candidates else min(candidates[sid] or d, d)
    candidates = sorted(candidates.items(), key=lambda x: x[1])
    base["candidate_stops"] = [stop_info(sid, d) for sid, d in candidates[:12]]

    # 2. static GTFS reachability, in two distance tiers so a stop AT the destination
    #    always beats a stop a block away:
    #      tier 1: stops at the destination (≤ AT_DESTINATION_M)
    #      tier 2: stops within walking distance (≤ WALK_RADIUS_M)
    #    In each tier: PRIMARY origin first (a) → else OPPOSITE origin (b).
    hit = other = None
    for limit in (AT_DESTINATION_M, WALK_RADIUS_M):
        tier = [(sid, d) for sid, d in candidates if d <= limit]
        hit = best_reachable(idx, tier, origin)
        if hit:
            break
        other = best_reachable(idx, tier, opposite)
        if other:
            break
    if hit is None:
        # 2b. only reachable from the OPPOSITE-direction stop
        if other:
            sid, d, routes = other
            return jsonify(
                {
                    **base,
                    "status": "opposite_direction",
                    "current_stop_id": origin,
                    "current_stop_name": idx.stops[origin]["name"],
                    "recommended_stop_id": opposite,
                    "recommended_stop_name": idx.stops[opposite]["name"],
                    "valid_routes": routes,
                    "destination_stop": sid,
                    "destination_name": idx.stops[sid]["name"],
                    "destination_distance_m": d,
                }
            )
        # 2c. neither direction
        return jsonify({**base, "status": "no_direct_route", "valid_routes": []})

    dest_stop, dist, valid = hit
    base.update(
        destination_stop=dest_stop,
        destination_name=idx.stops[dest_stop]["name"],
        destination_distance_m=dist,
        valid_routes=valid,
    )

    # 3. live ETA at the origin for each valid route (only trips that reach the destination)
    per_route, live_error = {}, None
    try:
        arrivals, fetched_at = septa_live.live_arrivals(
            origin,
            set(valid),
            trip_route_lookup=lambda t: idx.trip_route.get(t),
            trip_filter=lambda t: idx.trip_reaches(t, dest_stop, origin),
        )
        base["live_feed_fetched_at"] = datetime.fromtimestamp(fetched_at, septa_live.APP_TZ).isoformat()
        for a in arrivals:
            if a["route"] not in per_route:
                per_route[a["route"]] = {
                    "route": a["route"],
                    "eta_minutes": septa_live.minutes_until(a["epoch"]),
                    "eta_source": "LIVE",
                    "arrival_time": datetime.fromtimestamp(a["epoch"], septa_live.APP_TZ).isoformat(),
                    "trip_id": a["trip_id"],
                }
    except Exception as e:
        live_error = f"live TripUpdates unavailable: {e}"

    sched_errors = {}
    for r in valid:
        if r in per_route:
            continue
        try:
            t = septa_live.scheduled_next(origin, r)
        except Exception as e:
            sched_errors[r] = str(e)
            continue
        if t:
            per_route[r] = {
                "route": r,
                "eta_minutes": septa_live.minutes_until(t.timestamp()),
                "eta_source": "SCHEDULED",
                "arrival_time": t.isoformat(),
                "trip_id": None,
            }

    base["route_etas"] = [per_route[r] for r in valid if r in per_route]
    if live_error:
        base["live_error"] = live_error
    if sched_errors:
        base["scheduled_errors"] = sched_errors
    if not per_route:
        return jsonify({**base, "status": "no_eta_available"})

    # 4. choose the valid route with the soonest ETA (LIVE wins a tie)
    best = min(per_route.values(), key=lambda p: (p["eta_minutes"], p["eta_source"] != "LIVE"))
    return jsonify(
        {
            **base,
            "status": "ok",
            "selected_route": best["route"],
            "eta_minutes": best["eta_minutes"],
            "eta_source": best["eta_source"],
            "predicted_arrival": best["arrival_time"],
            "selected_trip_id": best["trip_id"],
        }
    )


# ─── LED refresh: live ETA for the ALREADY-SELECTED route only ───────────────
#
# No AI, no destination matching, no route selection — just the next arrival of
# `route` at `stop` (default: the primary origin 14079). If `dest` is given, only trips that reach
# that stop count (short-turns excluded). If `trip_id` is given and still in the
# live feed, that exact bus is tracked; otherwise the soonest valid trip is used
# and `tracked_trip_missing` is true (e.g. the tracked bus has already passed).


@app.get("/api/eta")
def eta_refresh():
    route = (request.args.get("route") or "").strip()
    stop = (request.args.get("stop") or gtfs_static.ORIGIN_STOP).strip()
    dest = (request.args.get("dest") or "").strip() or None
    trip_id = (request.args.get("trip_id") or "").strip() or None
    if route not in gtfs_static.CANDIDATE_ROUTES:
        return error("bad_route", f"route must be one of {', '.join(gtfs_static.CANDIDATE_ROUTES)}", 400)

    try:
        idx = gtfs_static.get_index()
    except Exception as e:
        return error("gtfs_unavailable", f"Static GTFS could not be loaded: {e}", 503)

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
            return jsonify(
                {
                    **base,
                    "status": "ok",
                    "eta_minutes": septa_live.minutes_until(a["epoch"]),
                    "eta_source": "LIVE",
                    "arrival_time": datetime.fromtimestamp(a["epoch"], septa_live.APP_TZ).isoformat(),
                    "trip_id": a["trip_id"],
                    "tracked_trip_missing": bool(trip_id) and tracked is None,
                }
            )
    except Exception as e:
        live_error = f"live TripUpdates unavailable: {e}"

    try:
        t = septa_live.scheduled_next(stop, route)
    except Exception as e:
        return error("eta_unavailable", f"{live_error or 'no live prediction'}; scheduled fallback failed: {e}", 502)
    if not t:
        return jsonify({**base, "status": "no_eta", "live_error": live_error})
    return jsonify(
        {
            **base,
            "status": "ok",
            "eta_minutes": septa_live.minutes_until(t.timestamp()),
            "eta_source": "SCHEDULED",
            "arrival_time": t.isoformat(),
            "trip_id": None,
            "tracked_trip_missing": bool(trip_id),
            "live_error": live_error,
        }
    )


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
    app.run(host="127.0.0.1", port=PORT, debug=True)
