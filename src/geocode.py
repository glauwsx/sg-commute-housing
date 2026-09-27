"""Geocoding via OneMap Singapore's free public search API (no key needed).

Used to place the workplace from a typed address. Ambiguous queries are the
normal case here -- "Tampines" alone matches dozens of buildings -- so the
search returns a *list* and the app makes the user pick, rather than silently
taking the first hit.
"""

import sys

import requests

ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search"


def search_address(query, limit=8, timeout=10):
    """Return up to `limit` [{lat, lon, name, address}] hits for `query`, [] on failure."""
    try:
        resp = requests.get(
            ONEMAP_SEARCH_URL,
            params={"searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1},
            timeout=timeout,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except Exception as e:  # network issues shouldn't crash the whole pipeline
        print(f"  [geocode] OneMap lookup failed for '{query}': {e}", file=sys.stderr)
        return []

    out, seen = [], set()
    for r in results[: limit * 2]:
        try:
            lat, lon = float(r["LATITUDE"]), float(r["LONGITUDE"])
        except (KeyError, TypeError, ValueError):
            continue
        address = r.get("ADDRESS") or query
        # OneMap lists one row per building entrance, so the same place can come
        # back several times with metres between the coordinates
        key = (r.get("SEARCHVAL"), round(lat, 4), round(lon, 4))
        if key in seen:
            continue
        seen.add(key)
        out.append({"lat": lat, "lon": lon, "name": r.get("SEARCHVAL") or address, "address": address})
        if len(out) >= limit:
            break
    return out


def geocode_address(query, timeout=10):
    """Return (lat, lon, matched_address) for the first hit, or None. Used by the CLI."""
    hits = search_address(query, limit=1, timeout=timeout)
    if not hits:
        return None
    return hits[0]["lat"], hits[0]["lon"], hits[0]["address"]
