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
import threading
import time

import requests

from place_aliases import resolve_place

GEOCODE_RADIUS_M = 400
WALK_RADIUS_M = 300  # max walk from the destination to a usable stop
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_UA = "SeatLevelETA-ClassPrototype/0.3 (Penn design course; local demo)"
PHILLY_VIEWBOX = "-75.2803,40.1379,-74.9558,39.8670"  # lon1,lat1,lon2,lat2
PHILLY_BBOX = (-75.2803, 39.8670, -74.9558, 40.1379)  # min lon, min lat, max lon, max lat
PHOTON_URL = "https://photon.komoot.io/api/"

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


# ─── Geocoding (real place data) ────────────────────────────────────────────
# Nominatim (OpenStreetMap) first, Photon (also OpenStreetMap data) as fallback.
# Results are restricted to the Philadelphia bounding box. Nominatim's usage
# policy allows ≤ 1 request/second, so calls are throttled and cached.

_geo_lock = threading.Lock()
_geo_last = [0.0]
_geo_cache = {}


def _in_philly(lat, lon):
    return PHILLY_BBOX[1] <= lat <= PHILLY_BBOX[3] and PHILLY_BBOX[0] <= lon <= PHILLY_BBOX[2]


def _nominatim(query, limit, near=None):
    """near=None → bounded to the Philadelphia box; near=(lat, lon) → bounded to a box
    around that point (only used when the rider explicitly named a place outside Philadelphia)."""
    with _geo_lock:
        wait = 1.05 - (time.time() - _geo_last[0])
        if wait > 0:
            time.sleep(wait)
        _geo_last[0] = time.time()
    if near:
        d = NEAR_BOX_DEG
        viewbox = f"{near[1] - d},{near[0] + d},{near[1] + d},{near[0] - d}"
    else:
        viewbox = PHILLY_VIEWBOX
    resp = requests.get(
        NOMINATIM_URL,
        params={"q": query, "format": "jsonv2", "limit": limit, "viewbox": viewbox,
                "bounded": 1, "addressdetails": 1, "countrycodes": "us"},
        headers={"User-Agent": NOMINATIM_UA},
        timeout=10,
    )
    resp.raise_for_status()
    return [_from_nominatim(r) for r in resp.json()]


def _from_nominatim(r):
    a = r.get("address") or {}
    street = " ".join(x for x in (a.get("house_number"), a.get("road")) if x)
    city = a.get("city") or a.get("town") or a.get("village") or a.get("municipality") or a.get("hamlet") or ""
    return {
        "name": r.get("name") or (r.get("display_name") or "").split(",")[0],
        "address": ", ".join(x for x in (street, city, a.get("state"), a.get("postcode")) if x)
        or r.get("display_name", ""),
        "display_name": r.get("display_name", ""),
        "lat": float(r["lat"]), "lon": float(r["lon"]),
        "kind": f"{r.get('category', '')}/{r.get('type', '')}",
        "city": city, "county": a.get("county") or "", "state": a.get("state") or "",
        "source": "nominatim",
    }


# University City — where most riders from this stop head; Photon results are biased
# toward it (and bounded to the Philadelphia box).
UNIVERSITY_CITY = (39.9522, -75.1932)
NEAR_BOX_DEG = 0.15  # ≈ 15 km box around an explicitly named outside place


def _photon(query, limit, bias=None, near=None):
    if near:
        d = NEAR_BOX_DEG
        b = (near[1] - d, near[0] - d, near[1] + d, near[0] + d)
        bias = near
    else:
        b = PHILLY_BBOX
    params = {"q": query, "limit": limit, "bbox": f"{b[0]},{b[1]},{b[2]},{b[3]}"}
    if bias:
        params.update(lat=bias[0], lon=bias[1])
    resp = requests.get(PHOTON_URL, params=params, headers={"User-Agent": NOMINATIM_UA}, timeout=10)
    resp.raise_for_status()
    return [_from_photon(f) for f in resp.json().get("features", [])]


def _from_photon(f):
    p = f.get("properties") or {}
    lon, lat = f["geometry"]["coordinates"][:2]
    street = " ".join(x for x in (p.get("housenumber"), p.get("street")) if x)
    return {
        "name": p.get("name") or street,
        "address": ", ".join(x for x in (street, p.get("city"), p.get("state"), p.get("postcode")) if x),
        "display_name": ", ".join(x for x in (p.get("name"), street, p.get("city")) if x),
        "lat": float(lat), "lon": float(lon),
        "kind": f"{p.get('osm_key', '')}/{p.get('osm_value', '')}",
        "city": p.get("city") or p.get("town") or p.get("village") or "",
        "county": p.get("county") or "", "state": p.get("state") or "",
        "source": "photon",
    }


# ─── Is a place really IN Philadelphia? ─────────────────────────────────────
# The Philadelphia bounding box also covers Camden, Pennsauken, Cherry Hill, Maple
# Shade … in New Jersey and suburbs in PA. So the box is only a search window; the
# real test uses the city / county / state the map data reports for the place.
_CORE_PHILLY = (-75.2803, 39.8670, -75.1350, 40.1379)  # west of the Delaware at Center City


def philly_status(r: dict):
    """→ ("YES" | "YES (inferred)" | "NO" | "UNKNOWN", "City, State")."""
    city = (r.get("city") or "").strip()
    county = (r.get("county") or "").strip().lower()
    state = (r.get("state") or "").strip()
    label = ", ".join(x for x in (city, state) if x)
    if state and state.lower() not in ("pennsylvania", "pa"):
        return "NO", label
    if city.lower() == "philadelphia" or county in ("philadelphia county", "philadelphia"):
        return "YES", label or "Philadelphia, PA"
    if city:
        return "NO", label  # another Pennsylvania municipality (Upper Darby, Cheltenham, …)
    # no admin data at all → only trust coordinates well west of the Delaware River
    lat, lon = r["lat"], r["lon"]
    b = _CORE_PHILLY
    if b[1] <= lat <= b[3] and b[0] <= lon <= b[2]:
        return "YES (inferred)", "Philadelphia, PA (from coordinates)"
    return "UNKNOWN", label


_search_cache = {}


def place_search(query: str, provider: str, limit: int = 6, near=None):
    """Broad real-place DISCOVERY for one search string (used by destination_recovery).
    provider: "photon" (fuzzy) or "nominatim" (≤ 1 req/s).
    near=None → the Philadelphia search window (Photon biased to University City);
    near=(lat, lon) → a window around a place the rider explicitly named.
    No name filtering and no Philadelphia decision here — the caller classifies results.
    Raises on network / HTTP errors (the caller records them)."""
    key = (provider, query.strip().lower(), limit, near)
    if key in _search_cache:
        return _search_cache[key]
    if provider == "photon":
        res = _photon(query, limit, bias=UNIVERSITY_CITY, near=near)
    elif provider == "nominatim":
        res = _nominatim(query, limit, near=near)
    else:
        raise ValueError(f"unknown provider {provider}")
    res = [r for r in res if r.get("name")]
    if not near:
        res = [r for r in res if _in_philly(r["lat"], r["lon"])]
    _search_cache[key] = res
    return res


REGION_VIEWBOX = "-76.2,40.7,-74.2,39.3"  # greater Philadelphia region (bias for locality lookups)


def locality_search(phrase: str):
    """Is `phrase` a real town / city / county / state? → list of
    {name, lat, lon, city, county, state, kind, source} (settlement or admin-area results only)."""
    key = ("locality", phrase.strip().lower())
    if key in _search_cache:
        return _search_cache[key]
    out, errors = [], []
    try:
        with _geo_lock:
            wait = 1.05 - (time.time() - _geo_last[0])
            if wait > 0:
                time.sleep(wait)
            _geo_last[0] = time.time()
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": phrase, "format": "jsonv2", "limit": 5, "viewbox": REGION_VIEWBOX, "bounded": 0,
                    "addressdetails": 1, "countrycodes": "us"},
            headers={"User-Agent": NOMINATIM_UA}, timeout=10,
        )
        resp.raise_for_status()
        out = [_from_nominatim(r) for r in resp.json()]
    except Exception as e:
        errors.append(f"nominatim: {e}")
    if not out:
        try:
            resp = requests.get(PHOTON_URL, params={"q": phrase, "limit": 5, "lat": 39.95, "lon": -75.16},
                                headers={"User-Agent": NOMINATIM_UA}, timeout=10)
            resp.raise_for_status()
            out = [_from_photon(f) for f in resp.json().get("features", [])]
        except Exception as e:
            errors.append(f"photon: {e}")
    if errors and not out:
        raise RuntimeError("; ".join(errors))
    out = [r for r in out if r["kind"].split("/")[0] in ("place", "boundary")]
    _search_cache[key] = out
    return out


def geocode_search(query: str, limit: int = 5):
    """Real place lookup, Philadelphia only → list of {name, address, lat, lon, kind, source}.
    Raises only if BOTH geocoders fail; an empty list means "not found"."""
    key = (query.strip().lower(), limit)
    if key in _geo_cache:
        return _geo_cache[key]
    errors = []
    results = None
    for fn in (_nominatim, _photon):
        try:
            results = [r for r in fn(query, limit) if _in_philly(r["lat"], r["lon"])]
        except Exception as e:  # network / rate limit → try the next geocoder
            errors.append(f"{fn.__name__.strip('_')}: {e}")
            continue
        if results:
            break
    if results is None:
        raise RuntimeError("; ".join(errors))
    _geo_cache[key] = results
    return results


def geocode(query: str):
    """Single best Philadelphia result → (lat, lon, label) or None (kept for existing callers)."""
    res = geocode_search(query, limit=1)
    if not res:
        return None
    r = res[0]
    return r["lat"], r["lon"], r["display_name"] or r["name"]


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
    dest: {destination_text, intersection_or_address, place_name, destination_type,
           optional verified_lat / verified_lon / resolved_place / resolved_address / verification_method}
    Returns {"method", "candidates": [(stop_id, distance_m)], "geocode": ..., "errors": [...]}.
    """
    # AI-recovered destination that was already verified against real place data
    # (see destination_recovery.py): use its coordinates directly.
    try:
        vlat, vlon = float(dest.get("verified_lat")), float(dest.get("verified_lon"))
    except (TypeError, ValueError):
        vlat = vlon = None
    if vlat is not None and _in_philly(vlat, vlon):
        return {
            "method": "AI recovery → " + (dest.get("verification_method") or "verified"),
            "query": dest.get("resolved_place") or dest.get("destination_text"),
            "candidates": _geocoded(idx.stops, (vlat, vlon, "")),
            "point": (vlat, vlon),
            "resolved_place": dest.get("resolved_place"),
            "resolved_address": dest.get("resolved_address"),
            "errors": [],
        }

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


def locate_street_destination(idx: StopNameIndex, text: str):
    """Offline check of a street address / intersection against real Philadelphia street
    data (GTFS stop names + the block-number grid). → {point, method, label} or None."""
    c = _intersection(idx, text or "")
    if c:
        return {"point": centroid(idx.stops, [sid for sid, _ in c]), "method": "street_grid (intersection)",
                "label": text}
    c, pt = _address_grid(idx, text or "")
    if c and pt:
        return {"point": pt, "method": "street_grid (address block)", "label": text}
    return None
