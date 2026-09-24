"""
Destination matching — turns the AI-normalized destination into CANDIDATE
SEPTA stops near it. This module only answers "which stops are at / near the
destination?". It does NOT decide reachability (that's gtfs_static.py).

Methods, tried in order:
  0. place_alias        a known local place ("Penn Bookstore") → its real
     address / corner from place_aliases.py, then matched like methods 1–3.
  1. intersection_name  "6th St & Chestnut St"  → stops whose GTFS stop_name
     is that same street pair (e.g. "Chestnut St & 6th St").
  2. address_grid       "520 Chestnut St"  → Philadelphia's block-numbering
     grid: the 500 block of an east-west street lies between 5th and 6th, so
     candidates are the stops at Chestnut & 5th and Chestnut & 6th.
  3. geocode            anything else (landmarks, north-south addresses) →
     OpenStreetMap Nominatim, bounded to Philadelphia → stops within
     GEOCODE_RADIUS_M of that point.

Every method also yields a destination POINT (the matched stops' centre, or the
geocoded location). The router then also considers real GTFS stops within
WALK_RADIUS_M of that point — e.g. 3737 Chestnut St is served by westbound
buses on Walnut St one block south. Distances are reported, never hidden.

If nothing matches, it returns no candidates — it never invents a stop.
"""

import math
import re

import requests

from place_aliases import resolve_place

GEOCODE_RADIUS_M = 400
WALK_RADIUS_M = 300  # max walk from the destination to a usable stop
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_UA = "SeatLevelETA-ClassPrototype/0.3 (Penn design course; local demo)"
PHILLY_VIEWBOX = "-75.2803,40.1379,-74.9558,39.8670"  # lon1,lat1,lon2,lat2

_SUFFIXES = {
    "st", "street", "ave", "av", "avenue", "blvd", "boulevard", "rd", "road", "dr", "drive",
    "pl", "place", "ln", "lane", "pkwy", "parkway", "ct", "court", "sq", "square", "way", "ter",
}
_DIRECTIONS = {"n", "s", "e", "w", "north", "south", "east", "west"}


def norm_street(s: str) -> str:
    """'S. 6th Street' → '6th'; 'Chestnut St' → 'chestnut'; '14th St' → 'broad'."""
    s = re.sub(r"\s+-\s+.*$", "", s)  # drop GTFS suffixes like " - FS", " - MBNS"
    words = re.sub(r"[^a-z0-9 ]", " ", s.lower()).split()
    while words and words[0] in _DIRECTIONS:
        words = words[1:]
    while words and words[-1] in _SUFFIXES:
        words = words[:-1]
    core = " ".join(words)
    return "broad" if core == "14th" else core  # Broad St is Philadelphia's "14th"


def split_pair(name: str):
    parts = re.split(r"\s*(?:&|\band\b|/|@)\s*", name, flags=re.I)
    parts = [norm_street(p) for p in parts if p.strip()]
    return parts if len(parts) == 2 else None


def ordinal(n: int) -> str:
    if n == 1:
        return "front"  # the 100 block starts at Front St
    if n == 14:
        return "broad"
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class StopNameIndex:
    """(street A, street B) → stop ids, built from GTFS stop names."""

    def __init__(self, stops: dict):
        self.stops = stops
        self.by_pair = {}
        for sid, s in stops.items():
            pair = split_pair(s["name"])
            if pair:
                self.by_pair.setdefault(frozenset(pair), []).append(sid)

    def at(self, a: str, b: str):
        return list(self.by_pair.get(frozenset((a, b)), []))


def _intersection(idx: StopNameIndex, text: str):
    pair = split_pair(text or "")
    if not pair:
        return []
    return [(sid, 0.0) for sid in idx.at(*pair)]


# South-of-Market block numbering on north-south streets (Center City & University
# City share it): the 100 S block runs Chestnut → Walnut, 200 S Walnut → Spruce, …
_SOUTH_CROSS = ["market", "chestnut", "walnut", "spruce", "pine", "lombard", "south"]


def _address_grid(idx: StopNameIndex, text: str):
    """→ (candidates, point). The point is interpolated along the block:
    3601 Walnut sits at the 36th St end, 3650 mid-block, 3699 near 37th.
    East-west streets use numbered cross streets; "S <numbered> St" addresses use
    the south-of-Market street order (115 S 40th St → between Chestnut and Walnut)."""
    m = re.match(r"^\s*(\d{1,5})\s+(?:(s|south)\.?\s+)?(.+?)\s*$", text or "", re.I)
    if not m:
        return [], None
    number, south, street = int(m.group(1)), bool(m.group(2)), norm_street(m.group(3))
    block = number // 100
    if not street:
        return [], None
    if re.match(r"^\d", street):
        # numbered (north-south) street: only "S …" addresses south of Market are handled
        if not south or block + 1 >= len(_SOUTH_CROSS):
            return [], None
        low_name, up_name = _SOUTH_CROSS[block], _SOUTH_CROSS[block + 1]
    else:
        if not 1 <= block <= 63:
            return [], None
        low_name, up_name = ordinal(block), ordinal(block + 1)
    lower = idx.at(street, low_name)
    upper = idx.at(street, up_name)
    cands = [(sid, 0.0) for sid in lower + upper]
    if not cands:
        return [], None
    a, b = centroid(idx.stops, lower), centroid(idx.stops, upper)
    if a and b:
        f = (number % 100) / 100
        point = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
    else:
        point = a or b
    return cands, point


def geocode(query: str):
    """Nominatim (OpenStreetMap), bounded to Philadelphia. Returns (lat, lon, label) or None."""
    resp = requests.get(
        NOMINATIM_URL,
        params={"q": query, "format": "jsonv2", "limit": 1, "viewbox": PHILLY_VIEWBOX, "bounded": 1},
        headers={"User-Agent": NOMINATIM_UA},
        timeout=10,
    )
    resp.raise_for_status()
    results = resp.json()
    if not results:
        return None
    r = results[0]
    return float(r["lat"]), float(r["lon"]), r.get("display_name", query)


def _geocoded(stops: dict, point):
    lat, lon, _ = point
    near = []
    for sid, s in stops.items():
        d = haversine_m(lat, lon, s["lat"], s["lon"])
        if d <= GEOCODE_RADIUS_M:
            near.append((sid, round(d)))
    near.sort(key=lambda x: x[1])
    return near


def centroid(stops: dict, stop_ids):
    pts = [(stops[s]["lat"], stops[s]["lon"]) for s in stop_ids if s in stops]
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def stops_near(stops: dict, point, radius_m=WALK_RADIUS_M):
    """All GTFS stops within radius_m of point → [(stop_id, distance_m)] sorted by distance."""
    lat, lon = point
    out = []
    for sid, s in stops.items():
        d = haversine_m(lat, lon, s["lat"], s["lon"])
        if d <= radius_m:
            out.append((sid, round(d)))
    return sorted(out, key=lambda x: x[1])


def find_candidate_stops(idx: StopNameIndex, dest: dict):
    """
    dest: {destination_text, intersection_or_address, place_name, destination_type}
    Returns {"method", "candidates": [(stop_id, distance_m)], "geocode": ..., "errors": [...]}.
    """
    ioa = (dest.get("intersection_or_address") or "").strip()
    text = (dest.get("destination_text") or "").strip()
    place = (dest.get("place_name") or "").strip()
    first_part = text.split(",")[0].strip()
    errors = []

    # 0. known local place → its real address / corner, then the normal matchers
    alias = resolve_place(place, text, ioa)
    if alias:
        info = {"resolved_place": alias["place"], "resolved_address": alias["address"] + ", Philadelphia",
                "alias_source": alias["source"], "matched_alias": alias["matched_alias"]}
        c = _intersection(idx, alias["intersection"] or "")
        if c:
            pt = centroid(idx.stops, [sid for sid, _ in c])
            return {"method": "place_alias", "query": alias["intersection"], "candidates": c, "point": pt,
                    "errors": errors, **info}
        c, pt = _address_grid(idx, alias["address"])
        if c:
            return {"method": "place_alias", "query": alias["address"], "candidates": c, "point": pt,
                    "errors": errors, **info}
        try:
            g = geocode(f"{alias['address']}, Philadelphia, PA")
        except Exception as e:
            g = None
            errors.append(f"geocode failed for alias address {alias['address']!r}: {e}")
        if g:
            return {"method": "place_alias+geocoder", "query": alias["address"],
                    "geocode": {"lat": g[0], "lon": g[1], "label": g[2]},
                    "candidates": _geocoded(idx.stops, g), "point": (g[0], g[1]), "errors": errors, **info}
        # fall through to the generic matchers below

    for s in filter(None, (ioa, first_part)):
        c = _intersection(idx, s)
        if c:
            pt = centroid(idx.stops, [sid for sid, _ in c])
            return {"method": "intersection_name", "query": s, "candidates": c, "point": pt, "errors": errors}
    for s in filter(None, (ioa, first_part)):
        c, pt = _address_grid(idx, s)
        if c:
            return {"method": "address_grid", "query": s, "candidates": c, "point": pt, "errors": errors}

    for q in filter(None, dict.fromkeys((
        f"{place}, Philadelphia" if place else None,
        text or None,
        f"{ioa}, Philadelphia" if ioa else None,
    ))):
        try:
            point = geocode(q)
        except Exception as e:  # network / rate limit
            errors.append(f"geocode failed for {q!r}: {e}")
            continue
        if point and not _geocoded(idx.stops, point):
            errors.append(f"geocoder found {q!r} but no SEPTA stop within {GEOCODE_RADIUS_M} m")
            continue
        if point:
            return {
                "method": "geocode",
                "query": q,
                "geocode": {"lat": point[0], "lon": point[1], "label": point[2]},
                "candidates": _geocoded(idx.stops, point),
                "point": (point[0], point[1]),
                "errors": errors,
            }
    return {"method": None, "candidates": [], "point": None, "errors": errors}
