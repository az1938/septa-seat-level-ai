"""
Destination recovery — RETRIEVE, THEN REASON, with Philadelphia as a HARD prior.

    Browser SpeechRecognition → RAW transcript ("Uno on Chestnut")
      1. search variants      a few strings that stay CLOSE TO THE SPEECH
                               ("Uno on Chestnut", "Uno Chestnut", "Uno Chestnut Street",
                               "Uno Chestnut Philadelphia"). Optional AI spelling fixes
                               are kept only if every word corresponds to a heard word —
                               no invented business identities ("… Pizzeria & Grill").
      2. real place discovery  Photon + Nominatim inside the Philadelphia search window,
                               curated place list, street grid. ALL real results collected.
      3. Philadelphia filter   each result's city / county / state from the map data decides
                               whether it is IN Philadelphia (the search window also covers
                               South Jersey). Outside places are REJECTED — unless the rider
                               explicitly named that outside town / state ("Uno in Maple
                               Shade"), in which case places near it are searched and allowed.
      4. AI ranking            OpenAI gets the raw transcript + the numbered ELIGIBLE real
                               places and picks one. It may only choose from that list.
      5. decision              final confidence = AI + name similarity + real-place evidence
                               + street context + distance → ok, or ask the rider again
      → verified destination (lat/lon of a real place) → GTFS routing (unchanged)

Routes / stops / ETAs are never produced here.
"""

from __future__ import annotations

import difflib
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from destination_match import (
    StopNameIndex,
    haversine_m,
    locality_search,
    locate_street_destination,
    norm_street,
    philly_status,
    place_search,
)
from place_aliases import resolve_place

# ─── Tunables ───────────────────────────────────────────────────────────────

MAX_RULE_VARIANTS = 6  # rule-based search variants (incl. the local alias hint)
MAX_AI_VARIANTS = 3  # extra AI spelling fixes (search terms only, filtered — see _close_to_speech)
PHOTON_LIMIT = 6  # results per Photon query
NOMINATIM_LIMIT = 5  # results per Nominatim query
NOMINATIM_MAX_QUERIES = 3  # Nominatim allows 1 req/s → only the top variants go there
MAX_CANDIDATES_TO_AI = 10  # eligible real places shown to the ranking model
DEDUPE_DISTANCE_M = 300  # same name within this distance = same place (street-grid points are block-level)
OUTSIDE_MATCH_RADIUS_M = 10_000  # outside place must be this close to the town the rider named
LOCALITY_MAX_DISTANCE_M = 80_000  # a named town must be in the greater Philadelphia region

# decision (see recover_destination())
ACCEPT_FINAL = 0.6  # final confidence needed to accept the AI's pick …
ACCEPT_AI = 0.5  # … and the AI itself must be at least this sure
AMBIGUITY_MARGIN = 0.1  # runner-up this close in AI confidence …
AMBIGUITY_DISTANCE_M = 500  # … and this far away → ask "A or B?"
# final confidence weights
W_AI, W_NAME, W_EVIDENCE, W_STREET, W_NEAR = 0.45, 0.25, 0.15, 0.10, 0.05

ORIGIN_POINT = (39.954867, -75.196549)  # stop 623, Chestnut St & 37th St (GTFS) — the kiosk

# ─── Step 1: search variants (close to the speech) ──────────────────────────

_LEAD_FILLER = {
    "i", "im", "i'm", "am", "going", "want", "wanna", "need", "to", "go", "get", "take", "me",
    "heading", "headed", "um", "uh", "please", "the", "a", "an", "so", "like", "can", "you",
    "id", "i'd", "would", "let's", "lets", "we're", "were", "trying",
}
_TAIL_FILLER = {"please", "um", "uh", "thanks", "thank", "you"}
# generic words a recognizer adds / a rider says that are usually NOT part of the name
_GENERIC = {"store", "shop", "place", "building", "spot", "location", "area", "there"}
_CONNECTORS = {"on", "at", "by", "near", "of", "in"}
# common speech-recognition confusions (letter names, homophones)
_SOUND_ALIKE = {"t": "tea", "tee": "tea", "c": "sea", "see": "sea", "b": "bee", "pen": "penn", "u": "you"}
_STREET_SUFFIX = {"st", "street", "ave", "avenue", "rd", "road", "blvd", "boulevard", "dr", "drive", "ln", "lane"}
# an explicitly named place OUTSIDE the destination name ("… in Maple Shade", "… in New Jersey")
_LOCATION_PHRASE = re.compile(r"\b(?:in|near|over in|out in)\s+([A-Za-z][A-Za-z .'-]*)$", re.I)
_STATE_WORDS = re.compile(r"\b(new jersey|jersey|nj|delaware|new york|maryland)\b", re.I)


def _tokens(s: str):
    return re.findall(r"[A-Za-z0-9'&.-]+", s or "")


def known_streets(names: StopNameIndex):
    """Philadelphia street names (normalized, e.g. 'chestnut', '40th') from GTFS stop names."""
    cached = getattr(names, "_street_set", None)
    if cached is None:
        cached = {s for pair in names.by_pair for s in pair if s}
        names._street_set = cached
    return cached


def mentioned_streets(text: str, streets: set):
    """Streets the rider explicitly placed the destination on: '… on Chestnut',
    '… at Walnut', 'Chestnut Street …'. A word that merely is also a street name
    ('Reading', 'Hall') does not count."""
    words = [w.lower() for w in _tokens(text)]
    found = []
    for n in (2, 1):
        for i in range(len(words) - n + 1):
            cand = norm_street(" ".join(words[i : i + n]))
            if not cand or cand not in streets or cand.isdigit() or len(cand) <= 2 or cand in found:
                continue
            before = words[i - 1] if i > 0 else ""
            after = words[i + n] if i + n < len(words) else ""
            if before in ("on", "at", "along", "off") or after in _STREET_SUFFIX:
                found.append(cand)
    return found


def split_location(raw: str):
    """'Uno in Maple Shade' → ('Uno', 'Maple Shade'); 'Uno on Chestnut' → ('Uno on Chestnut', None)."""
    text = (raw or "").strip().rstrip(".?!")
    m = _LOCATION_PHRASE.search(text)
    if m and m.start() > 0:
        return text[: m.start()].strip(), m.group(1).strip()
    m = _STATE_WORDS.search(text)
    if m:
        rest = (text[: m.start()] + text[m.end() :]).strip(" ,")
        rest = re.sub(r"\b(in|near)\s*$", "", rest, flags=re.I).strip(" ,")
        return rest or text, m.group(1)
    return text, None


def rule_variants(raw: str, local_hint: str | None, streets: set, location: str | None = None):
    """→ [{"text", "origin"}] — small, ordered, de-duplicated, close to the raw speech."""
    business, _ = split_location(raw) if location else (raw, None)
    toks = _tokens(business)
    while toks and toks[0].lower() in _LEAD_FILLER and len(toks) > 1:
        toks.pop(0)
    while toks and toks[-1].lower() in _TAIL_FILLER and len(toks) > 1:
        toks.pop()
    cleaned = " ".join(toks)
    core_toks = [t for t in toks if t.lower() not in _GENERIC] or toks
    core = " ".join(core_toks)
    bare_toks = [t for t in core_toks if t.lower() not in _CONNECTORS] or core_toks
    bare = " ".join(bare_toks)
    sound = " ".join((_SOUND_ALIKE[t.lower()].title() if t.lower() in _SOUND_ALIKE else t) for t in core_toks)
    street_words = mentioned_streets(core, streets)
    with_street = None
    if street_words and not any(t.lower() in _STREET_SUFFIX for t in bare_toks):
        last = bare_toks[-1].lower() if bare_toks else ""
        if norm_street(last) in street_words:
            with_street = f"{bare} Street"

    out = []

    def add(text, origin):
        text = (text or "").strip()
        if text and text.lower() not in {v["text"].lower() for v in out} and len(out) < MAX_RULE_VARIANTS:
            out.append({"text": text, "origin": origin})

    add(core, "noise words removed" if core != cleaned else "transcript")
    add(bare, "connector words removed")
    add(sound, "sound-alike spelling")
    add(with_street, "street name completed")
    if local_hint:
        add(local_hint, "local alias hint")
    if location:
        add(f"{bare} {location}", "with the place the rider named")
        add(" ".join(_tokens(raw)), "transcript")
    add(cleaned, "transcript")
    head = core_toks[0] if core_toks else ""
    if len(core_toks) >= 2 and head.isalpha() and len(head) >= 4:
        add(head, "leading proper noun")
    if street_words and not location:
        add(f"{bare} Philadelphia", "with city")
    return out


def _close_to_speech(variant: str, raw: str) -> bool:
    """An AI spelling fix is allowed only if EVERY word corresponds to a heard word
    (spelling / sound-alike), so it cannot add a business identity the rider never said."""
    heard = [w.lower() for w in _tokens(raw)]
    allowed_extra = _STREET_SUFFIX | {"the", "&", "and", "philadelphia"}
    for w in (x.lower() for x in _tokens(variant)):
        if w in allowed_extra or w in heard:
            continue
        ok = any(
            _SOUND_ALIKE.get(h) == w
            or difflib.SequenceMatcher(None, w, h).ratio() >= 0.6
            or (w.isalpha() and h.isalpha() and soundex(w) == soundex(h))
            for h in heard
        )
        if not ok:
            return False
    return True


VARIANT_PROMPT = """A rider at a bus stop in Philadelphia, PA said where they want to go.
The text is a browser speech-recognition transcript and may be garbled: wrong but
similar-sounding words, letters instead of words, split or merged words.

1. variants: up to 3 short MAP SEARCH strings that fix the SPELLING of the words the rider
   actually said. Stay close to the speech: correct misheard words, but do NOT add words the
   rider did not say — no guessed full business names, no "Restaurant", "Pizzeria", "Grill",
   "Cafe", no city or state. Examples: "Frank Lynn institute" → "Franklin Institute";
   "Ritten house square" → "Rittenhouse Square"; "sweet green on walnut" → "Sweetgreen Walnut".
2. explicit_location: a town, city, county, state or region the rider EXPLICITLY said
   (e.g. "… in Cherry Hill" → "Cherry Hill"), exactly as said; "" if none. Never infer one.

These are ONLY search terms; a real map search decides what exists.
Never mention bus routes, stops or ETAs."""

VARIANT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "variants": {"type": "array", "items": {"type": "string"}},
        "explicit_location": {"type": "string"},
    },
    "required": ["variants", "explicit_location"],
}

# ─── Step 4: AI ranking of REAL, ELIGIBLE candidates ────────────────────────

RANK_PROMPT = """You help a rider at a SEPTA bus stop at 37th St & Chestnut St (University City) in Philadelphia.
Their spoken destination was captured by browser speech recognition, which is often wrong.

You receive (a) the RAW transcript and (b) a numbered list of REAL places that a map search
returned for variants of that transcript. Every listed place is in Philadelphia, unless the
rider explicitly named an outside town (then it is stated). Decide which ONE of these places
the rider most likely said.

Consider:
- how the words SOUND aloud, not how they are spelled; a spoken word may be transcribed as a
  single letter or a homophone (e.g. "Bee" ↔ "B", "See" ↔ "C"), and words may be split or merged
- typical speech-recognition substitutions
- extra generic words ("store", "shop", "place", "the") that may be recognition noise
- STREET CONTEXT: if the rider names a street ("… on Chestnut"), a place on that street is
  much more likely; a name that literally contains "on <street>" is a strong match
- business naming: riders usually omit branch suffixes ("UPenn", "Center City")
- location: University City and Center City are the usual destinations from here
A match on only one common word (e.g. just "Hall", "Street", "Market") is NOT enough.

Rules:
- Choose ONLY from the numbered candidates. Never invent or rename a place.
- selected: the candidate number, or 0 if none is plausible.
- ranking: up to 3 most plausible candidates (by number), each with confidence 0–1 =
  probability the rider meant it.
- confidence: your confidence in the selected candidate (0 if selected is 0).
- status: "ok" one clear answer; "candidates" two or more DIFFERENT places remain about equally
  plausible; "needs_clarification" none is plausible; "not_a_destination" the speech is not
  about going somewhere.
- interpreted_destination: the selected candidate's name, or "".
- clarification_question: when status is not "ok", one short friendly question (for
  "candidates": "Did you mean A or B?"); otherwise "".
- Never mention bus routes, route numbers, stops, schedules or ETAs."""

RANK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "status": {"type": "string", "enum": ["ok", "candidates", "needs_clarification", "not_a_destination"]},
        "selected": {"type": "integer"},
        "interpreted_destination": {"type": "string"},
        "ranking": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "candidate": {"type": "integer"},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["candidate", "confidence", "reason"],
            },
        },
        "confidence": {"type": "number"},
        "clarification_question": {"type": "string"},
    },
    "required": ["status", "selected", "interpreted_destination", "ranking", "confidence",
                 "clarification_question"],
}


def build_rank_input(raw: str, cands: list, streets_said: list, outside: dict | None) -> str:
    lines = [f"RAW TRANSCRIPT: {raw!r}"]
    if streets_said:
        lines.append("STREET(S) THE RIDER MENTIONED: " + ", ".join(s.title() for s in streets_said))
    if outside:
        lines.append(f"THE RIDER EXPLICITLY NAMED A PLACE OUTSIDE PHILADELPHIA: {outside['label']}")
    lines += ["", "REAL CANDIDATES:"]
    for i, c in enumerate(cands, 1):
        bits = [c["name"]]
        if c.get("address"):
            bits.append(c["address"].split(",")[0])
        bits.append(c["city_state"] or "?")
        if c.get("category"):
            bits.append(c["category"])
        if c.get("street_match") is not None:
            bits.append("on the street the rider said" if c["street_match"] else "NOT on the street the rider said")
        bits.append(f"{c['distance_from_stop_m'] / 1000:.1f} km from the rider")
        lines.append(f"{i}. " + " — ".join(bits))
    lines += ["", "Which real place is the rider most likely trying to say?"]
    return "\n".join(lines)


# ─── Similarity (spelling + phonetic) ───────────────────────────────────────

_FILLER = _LEAD_FILLER | {"at", "near", "philadelphia", "philly", "pa"}


def _words(s: str):
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split() if w]


def soundex(word: str) -> str:
    if not word:
        return ""
    if word[0].isdigit():
        return word  # numbers compare literally
    codes = {**dict.fromkeys("bfpv", "1"), **dict.fromkeys("cgjkqsxz", "2"), **dict.fromkeys("dt", "3"),
             "l": "4", **dict.fromkeys("mn", "5"), "r": "6"}
    out, last = word[0].upper(), codes.get(word[0], "")
    for ch in word[1:]:
        c = codes.get(ch, "")
        if c and c != last:
            out += c
        if ch not in "hw":
            last = c
    return (out + "000")[:4]


def similarity(heard: str, name: str) -> float:
    """0–1 spelling + phonetic similarity between what was heard and a place name.
    Filler words are ignored; the best-matching word window of the longer side is used."""
    a = [w for w in _words(heard) if w not in _FILLER] or _words(heard)
    b = [w for w in _words(name) if w not in _FILLER] or _words(name)
    if not a or not b:
        return 0.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    best_char = 0.0
    for i in range(len(long_) - len(short) + 1):
        window = long_[i : i + len(short)]
        best_char = max(best_char, difflib.SequenceMatcher(None, " ".join(short), " ".join(window)).ratio())
    sx_long = {soundex(w) for w in long_}
    phon = sum(1 for w in short if soundex(w) in sx_long) / len(short)
    coverage = len(short) / len(long_)
    return round(max(best_char, phon) * (0.85 + 0.15 * coverage), 3)


def _norm_name(s: str) -> str:
    return " ".join(_words(s))


def _clamp(x):
    try:
        return max(0.0, min(1.0, float(x)))
    except (TypeError, ValueError):
        return 0.0


# ─── Step 2: real place discovery ───────────────────────────────────────────


def _local_candidates(variant: str, names: StopNameIndex):
    """Offline real Philadelphia data: curated source-cited places + street grid."""
    out = []
    alias = resolve_place(variant)
    if alias:
        loc = locate_street_destination(names, alias.get("intersection") or "") or locate_street_destination(
            names, alias["address"]
        )
        if loc:
            out.append({"name": alias["place"], "address": alias["address"] + ", Philadelphia, PA",
                        "lat": loc["point"][0], "lon": loc["point"][1], "category": "curated place",
                        "city": "Philadelphia", "state": "Pennsylvania", "source": "local verified place list"})
    if re.search(r"\d", variant) or re.search(r"\s(&|and)\s", variant, re.I):
        loc = locate_street_destination(names, variant)
        if loc:
            out.append({"name": variant, "address": f"{variant}, Philadelphia, PA",
                        "lat": loc["point"][0], "lon": loc["point"][1],
                        "category": "street address" if "address" in loc["method"] else "intersection",
                        "city": "Philadelphia", "state": "Pennsylvania", "source": loc["method"]})
    return out


def _search_remote(variants: list, nominatim_n: int, near=None):
    """Photon for every variant (in parallel), Nominatim for the first `nominatim_n`
    (the shared throttle keeps it ≤ 1 req/s). → (hits, errors, attempts)."""
    hits, errors = [], []
    jobs = [("photon", v) for v in variants] + [("nominatim", v) for v in variants[:nominatim_n]]

    def run(job):
        prov, v = job
        try:
            limit = PHOTON_LIMIT if prov == "photon" else NOMINATIM_LIMIT
            return job, place_search(v, prov, limit, near=near), None
        except Exception as e:  # network / HTTP / rate limit
            return job, [], f"{prov} {v!r}: {e}"

    if not jobs:
        return hits, errors, 0
    with ThreadPoolExecutor(max_workers=min(6, len(jobs))) as pool:
        for (prov, v), res, err in pool.map(run, jobs):
            if err:
                errors.append(err)
            for r in res:
                hits.append({**r, "category": r.get("kind"), "found_by": v})
    return hits, errors, len(jobs)


def _merge(raw_hits: list) -> list:
    """De-duplicate the same real place returned by several variants / providers."""
    places = []
    for h in raw_hits:
        key = _norm_name(h["name"])
        same = next(
            (p for p in places
             if _norm_name(p["name"]) == key and haversine_m(p["lat"], p["lon"], h["lat"], h["lon"]) <= DEDUPE_DISTANCE_M),
            None,
        )
        fb = h.get("found_by")
        if same:
            if fb and fb not in same["found_by"]:
                same["found_by"].append(fb)
            if h["source"] not in same["sources"]:
                same["sources"].append(h["source"])
            for k in ("address", "city", "county", "state"):
                if not same.get(k) and h.get(k):
                    same[k] = h[k]
            if (not same.get("category") or same["category"] == "/") and h.get("category"):
                same["category"] = h["category"]
            continue
        places.append({
            "name": h["name"], "address": h.get("address") or "", "lat": h["lat"], "lon": h["lon"],
            "category": h.get("category") or "", "city": h.get("city") or "", "county": h.get("county") or "",
            "state": h.get("state") or "", "sources": [h["source"]], "found_by": [fb] if fb else [],
        })
    return places


def resolve_outside_location(phrase: str | None):
    """Did the rider EXPLICITLY name a real town / state OUTSIDE Philadelphia?
    → ({label, lat, lon, state, level}, note) or (None, note)."""
    if not phrase:
        return None, None
    try:
        res = locality_search(phrase)
    except Exception as e:
        return None, f"could not look up {phrase!r}: {e}"
    for r in res:
        if similarity(phrase, r["name"]) < 0.8:
            continue
        if haversine_m(ORIGIN_POINT[0], ORIGIN_POINT[1], r["lat"], r["lon"]) > LOCALITY_MAX_DISTANCE_M:
            continue
        status, label = philly_status(r)
        if status.startswith("YES") or r["name"].lower() == "philadelphia":
            return None, f"{phrase!r} is inside Philadelphia"
        state = r.get("state") or ""
        level = "state" if (state and r["name"].lower() == state.lower()) else "town"
        label = r["name"] if level == "state" or not state else f"{r['name']}, {state}"
        return ({"label": label, "name": r["name"], "lat": r["lat"], "lon": r["lon"],
                 "state": state or r["name"], "level": level}, f"{phrase!r} is outside Philadelphia")
    return None, f"{phrase!r} is not a known nearby town"


def _eligibility(p: dict, outside: dict | None):
    """→ (in_philadelphia label, eligible?, rejected_reason)."""
    status, city_state = philly_status(p) if not any(s.startswith(("local verified", "street_grid")) for s in p["sources"]) \
        else ("YES", "Philadelphia, PA")
    p["city_state"] = city_state
    if status.startswith("YES"):
        return status, True, None
    if outside:
        if outside["level"] == "state":
            if (p.get("state") or "").lower() == outside["state"].lower():
                return status, True, None
        elif haversine_m(outside["lat"], outside["lon"], p["lat"], p["lon"]) <= OUTSIDE_MATCH_RADIUS_M \
                or similarity(outside["name"], p.get("city") or "") >= 0.8:
            return status, True, None
        return status, False, f"outside Philadelphia and not in {outside['name']}"
    if status == "UNKNOWN":
        return status, False, "location unknown (no city/state in map data)"
    return status, False, "outside Philadelphia"


def discover(raw: str, local_hint: str | None, names: StopNameIndex,
             ai_variants: Callable[[str], dict] | None = None):
    """Steps 1–3. → dict with variants, places (eligible first), streets, outside location, errors…"""
    streets = known_streets(names)
    _, rule_location = split_location(raw)
    errors = []

    # Philadelphia-first search of the rule variants, while the AI suggests spelling fixes
    variants = rule_variants(raw, local_hint, streets, rule_location)
    rule_texts = [v["text"] for v in variants]
    with ThreadPoolExecutor(max_workers=2) as pool:
        ai_future = pool.submit(ai_variants, raw) if ai_variants else None
        hits, errs, attempts = _search_remote(rule_texts, NOMINATIM_MAX_QUERIES - 1)
    errors += errs
    for v in rule_texts:
        for c in _local_candidates(v, names):
            hits.append({**c, "found_by": v})

    ai_location = None
    if ai_future is not None:
        try:
            ai_out = ai_future.result() or {}
        except Exception as e:
            ai_out = {}
            errors.append(f"AI variant step failed: {e}")
        ai_location = (ai_out.get("explicit_location") or "").strip() or None
        # an AI-reported location must actually appear in what the rider said
        if ai_location and similarity(raw, ai_location) < 0.8:
            ai_location = None
        new = []
        for t in [str(x).strip() for x in (ai_out.get("variants") or []) if str(x).strip()][:MAX_AI_VARIANTS]:
            if t.lower() in {v["text"].lower() for v in variants}:
                continue
            if not _close_to_speech(t, raw):
                variants.append({"text": t, "origin": "AI spelling variant — DROPPED (adds words not heard)",
                                 "dropped": True})
                continue
            variants.append({"text": t, "origin": "AI spelling variant"})
            new.append(t)
        h2, e2, a2 = _search_remote(new, 1)
        hits += h2
        errors += e2
        attempts += a2
        for v in new:
            for c in _local_candidates(v, names):
                hits.append({**c, "found_by": v})

    # explicit outside location? (only what the rider said; confirmed by real locality data)
    outside, location_note = resolve_outside_location(rule_location or ai_location)
    if outside:
        business, _ = split_location(raw)
        near_variants = [v["text"] for v in variants if not v.get("dropped")][:3]
        if business and business not in near_variants:
            near_variants.insert(0, business)
        h3, e3, a3 = _search_remote(near_variants, 1, near=(outside["lat"], outside["lon"]))
        hits += h3
        errors += e3
        attempts += a3

    places = _merge(hits)
    streets_said = mentioned_streets(split_location(raw)[0], streets)
    rule_heard = [raw] + [v["text"] for v in variants[:3] if v["origin"] != "local alias hint"]
    for p in places:
        p["in_philadelphia"], p["eligible"], p["rejected_reason"] = _eligibility(p, outside)
        p["distance_from_stop_m"] = round(haversine_m(ORIGIN_POINT[0], ORIGIN_POINT[1], p["lat"], p["lon"]))
        p["name_similarity"] = max(similarity(h, p["name"]) for h in rule_heard)
        p["phonetic_similarity"] = p["name_similarity"]  # (kept for older DEV views)
        if streets_said:
            p_street = norm_street(re.sub(r"^\s*\d+[a-z]?\s+", "", (p.get("address") or "").split(",")[0], flags=re.I))
            p["street_match"] = p_street in streets_said or any(s in _norm_name(p["name"]).split() for s in streets_said)
        else:
            p["street_match"] = None
    # order: eligible first; then exact/near-exact name, street context, how many searches
    # found it; then distance (University City / Center City first)
    places.sort(key=lambda p: (
        not p["eligible"],
        -(p["name_similarity"] + (0.15 if p["street_match"] else 0) + 0.03 * len(p["found_by"])),
        p["distance_from_stop_m"],
    ))
    return {"variants": variants, "places": places, "errors": errors, "attempts": attempts,
            "streets_said": streets_said, "outside": outside,
            "location_phrase": rule_location or ai_location, "location_note": location_note}


class PlaceSearchUnavailable(RuntimeError):
    pass


# ─── Step 5: decision ───────────────────────────────────────────────────────


def _evidence(p: dict) -> float:
    """Real-world evidence that this is a real, findable destination (0–1)."""
    if "local verified place list" in p["sources"]:
        return 1.0
    return min(1.0, 0.8 + 0.1 * (len(p["found_by"]) - 1) + 0.1 * (len(p["sources"]) > 1))


def _nearness(p: dict, outside: dict | None) -> float:
    if outside and not p["in_philadelphia"].startswith("YES"):
        d = haversine_m(outside["lat"], outside["lon"], p["lat"], p["lon"])
    else:
        d = p["distance_from_stop_m"]
    return max(0.0, min(1.0, (15_000 - d) / 12_000))  # ≤ 3 km → 1, ≥ 15 km → 0


def final_confidence(ai_c: float, p: dict, outside: dict | None) -> float:
    street = 0.5 if p["street_match"] is None else (1.0 if p["street_match"] else 0.0)
    return round(W_AI * ai_c + W_NAME * p["name_similarity"] + W_EVIDENCE * _evidence(p)
                 + W_STREET * street + W_NEAR * _nearness(p, outside), 3)


def _base(raw, local_hint, d, model):
    return {
        "raw_transcript": raw,
        "local_hint": local_hint,
        "search_variants": d["variants"],
        "mentioned_streets": d["streets_said"],
        "explicit_location": d["location_phrase"],
        "explicit_location_note": d["location_note"],
        "outside_location": d["outside"],
        "retrieved_count": len(d["places"]),
        "rejected_count": sum(1 for p in d["places"] if not p["eligible"]),
        "candidate_places": [],
        "retrieval_errors": d["errors"],
        "ai_status": None,
        "ai_selected": None,
        "interpreted_destination": None,
        "ai_confidence": 0.0,
        "verification": {"status": "NONE", "method": None, "resolved_place": None, "resolved_address": None,
                         "lat": None, "lon": None},
        "model": model,
        # backward-compatible destination fields (filled when status == ok)
        "status": "needs_clarification",
        "destination_type": "unknown",
        "destination_text": None,
        "intersection_or_address": None,
        "place_name": None,
        "confidence": 0.0,
        "clarification_question": None,
    }


def recover_destination(raw: str, local_hint: str | None, names: StopNameIndex,
                        rank: Callable[[str], dict], ai_variants: Callable[[str], dict] | None = None,
                        model: str = ""):
    """Full pipeline. `rank(ai_input) -> dict` and `ai_variants(raw) -> dict` call OpenAI.
    Raises PlaceSearchUnavailable when every real-place search failed (network down)."""
    d = discover(raw, local_hint, names, ai_variants)
    places, outside = d["places"], d["outside"]
    out = _base(raw, local_hint, d, model)
    eligible = [p for p in places if p["eligible"]]
    rejected = [p for p in places if not p["eligible"]]
    for p in rejected:
        p.update(ai_confidence=None, ai_reason="", selected=False, final_confidence=None)
    remote_failed = d["attempts"] > 0 and \
        sum(1 for e in d["errors"] if e.startswith(("photon", "nominatim"))) >= d["attempts"]

    if not eligible:
        out["candidate_places"] = rejected
        if not places and remote_failed:
            raise PlaceSearchUnavailable("all place searches failed: " + "; ".join(d["errors"][:3]))
        out["verification"]["status"] = "NO_PHILADELPHIA_PLACES" if rejected else "NO_REAL_PLACES"
        out["clarification_question"] = "Sorry, I couldn't find that place in Philadelphia. Where would you like to go?"
        return out

    shown = eligible[:MAX_CANDIDATES_TO_AI]
    ai = rank(build_rank_input(raw, shown, d["streets_said"], outside)) or {}
    ai_status = ai.get("status") if ai.get("status") in ("ok", "candidates", "needs_clarification",
                                                          "not_a_destination") else "needs_clarification"
    out["ai_status"] = ai_status

    conf_by_idx = {}
    for r in ai.get("ranking") or []:
        try:
            i = int(r.get("candidate"))
        except (TypeError, ValueError):
            continue
        if 1 <= i <= len(shown) and i not in conf_by_idx:
            conf_by_idx[i] = (_clamp(r.get("confidence")), (r.get("reason") or "").strip())
    try:
        sel = int(ai.get("selected") or 0)
    except (TypeError, ValueError):
        sel = 0
    if not 1 <= sel <= len(shown):
        sel = 0
    if sel and sel not in conf_by_idx:
        conf_by_idx[sel] = (_clamp(ai.get("confidence")), "")
    for i, p in enumerate(shown, 1):
        c, reason = conf_by_idx.get(i, (None, ""))
        p["ai_confidence"] = round(c, 2) if c is not None else None
        p["ai_reason"] = reason
        p["selected"] = i == sel
        p["final_confidence"] = final_confidence(c, p, outside) if c is not None else None
    out["candidate_places"] = shown + rejected
    q = (ai.get("clarification_question") or "").strip()

    if ai_status == "not_a_destination":
        out["status"] = "not_a_destination"
        out["clarification_question"] = q or "Where would you like to go?"
        return out
    if not sel:
        out["verification"]["status"] = "NO_PLAUSIBLE_MATCH"
        out["clarification_question"] = q or "Sorry, where would you like to go?"
        return out

    best = shown[sel - 1]
    ai_c = conf_by_idx[sel][0]
    final = best["final_confidence"]
    out.update(ai_selected=best["name"], interpreted_destination=best["name"], ai_confidence=round(ai_c, 2),
               confidence=final)

    if final < ACCEPT_FINAL or ai_c < ACCEPT_AI:
        out["verification"]["status"] = "LOW_CONFIDENCE"
        out["clarification_question"] = q or "Sorry, could you say the place name again?"
        return out

    # genuine ambiguity: a DIFFERENT real place, about as likely, somewhere else
    for i, (c, _) in sorted(conf_by_idx.items(), key=lambda kv: -kv[1][0]):
        if i == sel:
            continue
        other = shown[i - 1]
        far = haversine_m(best["lat"], best["lon"], other["lat"], other["lon"]) > AMBIGUITY_DISTANCE_M
        if far and ai_c - c < AMBIGUITY_MARGIN:
            a, b = best["name"], other["name"]
            if _norm_name(a) == _norm_name(b):
                a, b = f"{a} on {best['address'].split(',')[0]}", f"{b} on {other['address'].split(',')[0]}"
            out["status"] = "needs_clarification"
            out["verification"]["status"] = "AMBIGUOUS"
            out["clarification_question"] = f"Did you mean {a} or {b}?"
            return out

    street = best["category"] in ("street address", "intersection")
    method = "place search (" + ", ".join(best["sources"]) + ") → AI ranking"
    out.update(
        status="ok",
        destination_type=("address" if best["category"] == "street address" else "intersection") if street else "landmark",
        destination_text=f"{best['name']}, {best['city_state'] or 'Philadelphia'}",
        intersection_or_address=best["name"] if street else None,
        place_name=None if street else best["name"],
        clarification_question=None,
    )
    out["verification"] = {"status": "VERIFIED", "method": method, "resolved_place": best["name"],
                           "resolved_address": best["address"] or None, "lat": best["lat"], "lon": best["lon"],
                           "in_philadelphia": best["in_philadelphia"], "chosen": best["name"]}
    return out
