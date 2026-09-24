"""
Static GTFS (SEPTA bus) — the source of truth for DIRECT reachability.

Two origins near 15th St (verified from GTFS at load time, see verify_origins):
  PRIMARY_ORIGIN  14079  Walnut St & 15th St    — westbound (direction_id 1):
                         9 → Andorra, 21 → 69th St TC, 42 → Wycombe / 61st-Pine
  OPPOSITE_ORIGIN  6060  Chestnut St & 15th St  — eastbound (direction_id 0):
                         9 → 4th-Walnut, 21 → Columbus-Dock, 42 → 2nd-Spruce
They are on different streets (Walnut vs Chestnut), ~160 m apart.

A route is valid from an origin for a destination stop only if at least one
trip of that route serves the origin and then serves the destination stop
LATER in the SAME trip (higher stop_sequence). Direction comes from that, not
from coordinates or route membership.

Data: SEPTA's public GTFS (github.com/septadev/GTFS). The bus feed is
downloaded once into server/data/gtfs_bus/ (git-ignored) if missing.
"""

import csv
import io
import threading
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import requests

PRIMARY_ORIGIN = "14079"  # Walnut St & 15th St (westbound) — the kiosk's stop
OPPOSITE_ORIGIN = "6060"  # Chestnut St & 15th St (eastbound) — the other direction
ORIGINS = (PRIMARY_ORIGIN, OPPOSITE_ORIGIN)
ORIGIN_STOP = PRIMARY_ORIGIN  # backwards-compatible name
CANDIDATE_ROUTES = ("9", "21", "42")

GTFS_ZIP_URL = "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip"
DATA_DIR = Path(__file__).with_name("data") / "gtfs_bus"
NEEDED = ("stops.txt", "trips.txt", "stop_times.txt", "routes.txt", "calendar.txt", "calendar_dates.txt")


def ensure_downloaded(log=print):
    if all((DATA_DIR / f).exists() for f in NEEDED):
        return
    log(f"Downloading SEPTA GTFS from {GTFS_ZIP_URL} …")
    resp = requests.get(GTFS_ZIP_URL, timeout=120)
    resp.raise_for_status()
    outer = zipfile.ZipFile(io.BytesIO(resp.content))
    bus = zipfile.ZipFile(io.BytesIO(outer.read("google_bus.zip")))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in NEEDED:
        (DATA_DIR / name).write_bytes(bus.read(name))
    log(f"GTFS bus feed saved to {DATA_DIR}")


class GtfsIndex:
    def __init__(self):
        self.stops = {}  # stop_id -> {"id","name","lat","lon"}
        self.trip_route = {}  # trip_id -> route_id (candidate routes only)
        self.trip_direction = {}  # trip_id -> direction_id
        self.trip_headsign = {}
        # origin -> trip_id -> ordered stop_ids AFTER the origin (trips serving that origin)
        self.downstream = {o: {} for o in ORIGINS}
        # origin -> route_id -> {stop_id: number of trips reaching it after the origin}
        self.reach = {o: defaultdict(lambda: defaultdict(int)) for o in ORIGINS}
        # origin -> route -> Counter[(direction_id, headsign)]
        self.origin_service = {o: defaultdict(Counter) for o in ORIGINS}

    # ── loading ────────────────────────────────────────────────────────────
    def load(self):
        with open(DATA_DIR / "stops.txt", newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                try:
                    self.stops[r["stop_id"]] = {
                        "id": r["stop_id"],
                        "name": r["stop_name"],
                        "lat": float(r["stop_lat"]),
                        "lon": float(r["stop_lon"]),
                    }
                except (ValueError, KeyError):
                    continue

        with open(DATA_DIR / "trips.txt", newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r["route_id"] in CANDIDATE_ROUTES:
                    self.trip_route[r["trip_id"]] = r["route_id"]
                    self.trip_direction[r["trip_id"]] = r.get("direction_id", "")
                    self.trip_headsign[r["trip_id"]] = r.get("trip_headsign", "")

        seqs = defaultdict(list)
        with open(DATA_DIR / "stop_times.txt", newline="", encoding="utf-8-sig") as f:
            rd = csv.reader(f)
            h = next(rd)
            ti, si, qi = h.index("trip_id"), h.index("stop_id"), h.index("stop_sequence")
            for row in rd:
                if row[ti] in self.trip_route:
                    seqs[row[ti]].append((int(row[qi]), row[si]))

        for trip_id, s in seqs.items():
            s.sort()  # by stop_sequence
            ids = [stop for _, stop in s]
            route = self.trip_route[trip_id]
            for origin in ORIGINS:
                if origin not in ids:
                    continue
                after = ids[ids.index(origin) + 1 :]
                self.downstream[origin][trip_id] = after
                self.origin_service[origin][route][(self.trip_direction[trip_id], self.trip_headsign[trip_id])] += 1
                for stop in set(after):
                    self.reach[origin][route][stop] += 1
        self.verify_origins()
        return self

    def verify_origins(self):
        """Fail loudly if the configured origins don't match the current GTFS."""
        for origin in ORIGINS:
            if origin not in self.stops:
                raise RuntimeError(f"Origin stop {origin} not found in GTFS stops.txt")
            missing = [r for r in CANDIDATE_ROUTES if not self.origin_service[origin][r]]
            if missing:
                raise RuntimeError(f"Origin {origin} is not served by route(s) {missing} in this GTFS feed")
            dirs = {d for r in CANDIDATE_ROUTES for (d, _) in self.origin_service[origin][r]}
            if len(dirs) != 1:
                raise RuntimeError(f"Origin {origin} is served in more than one direction: {dirs}")
        d_primary = {d for r in CANDIDATE_ROUTES for (d, _) in self.origin_service[PRIMARY_ORIGIN][r]}
        d_opp = {d for r in CANDIDATE_ROUTES for (d, _) in self.origin_service[OPPOSITE_ORIGIN][r]}
        if d_primary == d_opp:
            raise RuntimeError("PRIMARY and OPPOSITE origins are served in the same direction")

    # ── queries ────────────────────────────────────────────────────────────
    def routes_reaching(self, stop_id, origin=PRIMARY_ORIGIN):
        """Candidate routes with ≥1 trip serving `origin` and then stop_id later in the same trip."""
        return [r for r in CANDIDATE_ROUTES if self.reach[origin][r].get(stop_id, 0) > 0]

    def trip_reaches(self, trip_id, stop_id, origin=PRIMARY_ORIGIN):
        """True/False if we know this trip from `origin`; None if not in static GTFS."""
        ds = self.downstream.get(origin, {})
        if trip_id not in ds:
            return None
        return stop_id in ds[trip_id]

    def origin_info(self, origin):
        return {
            "stop_id": origin,
            "name": self.stops[origin]["name"],
            "routes": {
                r: [
                    {"direction_id": d, "headsign": h, "trips": n}
                    for (d, h), n in self.origin_service[origin][r].most_common()
                ]
                for r in CANDIDATE_ROUTES
            },
        }

    def summary(self):
        return {
            "primary_origin": self.origin_info(PRIMARY_ORIGIN),
            "opposite_origin": self.origin_info(OPPOSITE_ORIGIN),
        }


_index = None
_lock = threading.Lock()


def get_index(log=print):
    global _index
    with _lock:
        if _index is None:
            ensure_downloaded(log)
            _index = GtfsIndex().load()
            log(f"GTFS loaded: {_index.summary()}")
        return _index
