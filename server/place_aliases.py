"""
Local place-name aliases — a SMALL, hand-checked list of high-confidence local
places, mapped to their real street address / corner ONLY.

This layer never mentions routes, stops or ETAs. It just turns a place name
("Penn Bookstore") into a location; the normal matcher then finds nearby SEPTA
stops and GTFS decides reachability, exactly as for a spoken address.

Each entry cites where the address came from. Add entries sparingly.
"""

import re

PLACES = {
    "Penn Bookstore": {
        "address": "3601 Walnut St",
        # corner used to find stops by GTFS stop name (no network needed)
        "intersection": "36th St & Walnut St",
        "source": "https://facilities.upenn.edu/maps/locations/bookstore-university-pennsylvania "
        "(3601 Walnut Street, at 36th and Walnut Streets)",
        "aliases": [
            "penn bookstore",
            "penn book store",
            "upenn bookstore",
            "upenn book store",
            "u penn bookstore",
            "university of pennsylvania bookstore",
            "university of pennsylvania book store",
            "penn barnes and noble",
            "barnes and noble at penn",
            "barnes noble penn",
        ],
    },
    "Tangen Hall": {
        "address": "115 S 40th St",
        "intersection": "40th St & Sansom St",
        "source": "https://facilities.upenn.edu/maps/locations/tangen-hall "
        "(115 S 40th Street, northeast corner of 40th and Sansom)",
        "aliases": ["tangen hall", "penn tangen hall"],
    },
}


def _norm(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\bu\s+penn\b", "upenn", s)
    words = [w for w in s.split() if w not in {"the", "philadelphia", "pa", "philly"}]
    return " ".join(words)


def resolve_place(*texts: str):
    """
    First alias found (as a whole phrase) in any of the given texts →
    {"place", "address", "intersection", "source", "matched_alias"}; else None.
    """
    for text in texts:
        t = f" {_norm(text)} "
        if not t.strip():
            continue
        for place, info in PLACES.items():
            for alias in info["aliases"]:
                if f" {_norm(alias)} " in t:
                    return {
                        "place": place,
                        "address": info["address"],
                        "intersection": info.get("intersection"),
                        "source": info["source"],
                        "matched_alias": alias,
                    }
    return None
