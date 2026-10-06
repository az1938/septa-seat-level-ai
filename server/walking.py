"""
Walking estimate from the kiosk's origin stop to a verified destination.

Source order:
  1. OSRM walking router on OpenStreetMap data (FOSSGIS public instance,
     routing.openstreetmap.de, "routed-foot" profile) → real sidewalk/street
     route distance + walking duration.
  2. Fallback when the router is unreachable: Philadelphia grid estimate =
     Manhattan distance (north–south + east–west legs, since the street grid is
     close to north/east-aligned here) at WALK_SPEED_M_PER_MIN. Labeled as an
     estimate so the DEV panel never presents it as a routed walk.

Walking is only a SUGGESTION to the rider (accessibility): this module just
measures; app.py decides what to say.
"""

from __future__ import annotations

import math
import threading

import requests

from destination_match import haversine_m

WALK_THRESHOLD_MIN = 10  # ≤ this → walk_recommended
WALK_SPEED_M_PER_MIN = 80  # ≈ 4.8 km/h, typical urban walking pace (fallback only)
OSRM_FOOT_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"
HTTP_TIMEOUT_S = 6
USER_AGENT = "SeatLevelETA-ClassPrototype/0.4 (Penn design course; local demo)"

_cache = {}
_lock = threading.Lock()


def _osrm_foot(origin, dest):
    url = OSRM_FOOT_URL.format(lat1=origin[0], lon1=origin[1], lat2=dest[0], lon2=dest[1])
    resp = requests.get(url, params={"overview": "false"}, headers={"User-Agent": USER_AGENT},
                        timeout=HTTP_TIMEOUT_S)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RuntimeError(f"walking router: {data.get('code')}")
    r = data["routes"][0]
    return float(r["distance"]), float(r["duration"])


def _grid_estimate_m(origin, dest):
    ns = haversine_m(origin[0], origin[1], dest[0], origin[1])
    ew = haversine_m(origin[0], origin[1], origin[0], dest[1])
    return ns + ew


def estimate_walk(origin, dest) -> dict:
    """origin/dest: (lat, lon). → {distance_m, minutes, walkable, source, straight_line_m,
    threshold_min, router_error?}. Never raises."""
    key = (round(origin[0], 5), round(origin[1], 5), round(dest[0], 5), round(dest[1], 5))
    with _lock:
        if key in _cache:
            return dict(_cache[key])
    straight = haversine_m(origin[0], origin[1], dest[0], dest[1])
    out = {"straight_line_m": round(straight), "threshold_min": WALK_THRESHOLD_MIN}
    try:
        dist, dur = _osrm_foot(origin, dest)
        out.update(distance_m=round(dist), minutes=max(1, math.ceil(dur / 60)),
                   source="OSRM walking route (OpenStreetMap, routing.openstreetmap.de)")
    except Exception as e:
        dist = _grid_estimate_m(origin, dest)
        out.update(distance_m=round(dist), minutes=max(1, math.ceil(dist / WALK_SPEED_M_PER_MIN)),
                   source=f"grid estimate (street-grid distance at {WALK_SPEED_M_PER_MIN} m/min; "
                          "walking router unreachable)",
                   router_error=str(e)[:200])
    out["walkable"] = out["minutes"] <= WALK_THRESHOLD_MIN
    with _lock:
        _cache[key] = dict(out)
    return out
