"""
Live SEPTA arrival times at the origin stop.

LIVE:      GTFS-Realtime TripUpdates (protobuf, official gtfs-realtime-bindings),
           StopTimeUpdates for ORIGIN_STOP. The feed is cached for FEED_TTL_S so
           one recommendation = one download for all candidate routes.
SCHEDULED: fallback per route when there is no live prediction — SEPTA's
           plain-text scheduled departures endpoint (/sms/<stop>/<route>),
           the same fallback Prototype 1 used. Labeled "SCHEDULED".

Never fabricates a time: if both are unavailable the route simply has no ETA.
"""

import math
import re
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from google.transit import gtfs_realtime_pb2

TRIP_UPDATES_URL = "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb"
SMS_URL_TEMPLATE = "https://www3.septa.org/sms/{stop_id}/{route}"
HTTP_TIMEOUT_S = 10
FEED_TTL_S = 15
APP_TZ = ZoneInfo("America/New_York")

_cache = {"at": 0.0, "feed": None}
_cache_lock = threading.Lock()


def _trip_updates_feed():
    with _cache_lock:
        if _cache["feed"] is not None and time.time() - _cache["at"] < FEED_TTL_S:
            return _cache["feed"], _cache["at"]
        resp = requests.get(TRIP_UPDATES_URL, timeout=HTTP_TIMEOUT_S)
        resp.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
        _cache.update(at=time.time(), feed=feed)
        return feed, _cache["at"]


def live_arrivals(stop_id: str, routes, trip_route_lookup, trip_filter=None):
    """
    All future live predictions at stop_id for the given routes.
    trip_route_lookup(trip_id) → route from static GTFS (used if the RT feed omits route_id).
    trip_filter(trip_id) → False to drop a trip (e.g. a short-turn that doesn't reach the destination).
    Returns (list of {route, trip_id, epoch}, feed_fetched_at).
    """
    feed, fetched_at = _trip_updates_feed()
    now = time.time()
    SKIPPED = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate.SKIPPED
    CANCELED = gtfs_realtime_pb2.TripDescriptor.CANCELED
    out = []
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        tu = entity.trip_update
        if tu.trip.schedule_relationship == CANCELED:
            continue
        route = tu.trip.route_id or trip_route_lookup(tu.trip.trip_id)
        if route not in routes:
            continue
        if trip_filter and trip_filter(tu.trip.trip_id) is False:
            continue
        for stu in tu.stop_time_update:
            if stu.stop_id != stop_id or stu.schedule_relationship == SKIPPED:
                continue
            epoch = None
            if stu.HasField("arrival") and stu.arrival.time:
                epoch = stu.arrival.time
            elif stu.HasField("departure") and stu.departure.time:
                epoch = stu.departure.time
            if epoch and epoch >= now - 30:
                out.append({"route": route, "trip_id": tu.trip.trip_id, "epoch": int(epoch)})
    out.sort(key=lambda a: a["epoch"])
    return out, fetched_at


_SMS_LINE_RE = re.compile(r"Rt\.\s*([A-Za-z0-9]+)\s*@\s*(\d{1,2}:\d{2})(?:\s+(\d{2}/\d{2}))?")


def scheduled_next(stop_id: str, route: str):
    """Next scheduled departure (datetime) from SEPTA's /sms endpoint, or None."""
    now = datetime.now(APP_TZ)
    resp = requests.get(SMS_URL_TEMPLATE.format(stop_id=stop_id, route=route), timeout=HTTP_TIMEOUT_S)
    resp.raise_for_status()
    times = []
    for m in _SMS_LINE_RE.finditer(resp.text):
        rte, hhmm, mmdd = m.groups()
        if rte != str(route):
            continue
        hour, minute = map(int, hhmm.split(":"))
        if mmdd:
            month, day = map(int, mmdd.split("/"))
            t = now.replace(month=month, day=day, hour=hour, minute=minute, second=0, microsecond=0)
        else:
            t = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if t < now - timedelta(minutes=2):
                t += timedelta(days=1)
        if t >= now - timedelta(minutes=1):
            times.append(t)
    return min(times) if times else None


def minutes_until(epoch: float) -> int:
    """Whole minutes, rounded down (0 = arriving now), never negative."""
    return max(0, math.floor((epoch - time.time()) / 60))
