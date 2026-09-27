"""Resolve real-world locations (company address, shuttle pickup points) to
LTA BusStopCodes, and find bus stops within a radius of a lat/lon point.
"""

import sys

import config
from src import geocode
from src.geo_utils import haversine_m, normalize_text, numbers_compatible, token_overlap_score


def resolve_company_latlon():
    """Where the workplace actually is, most trustworthy source first.

    A saved setup beats geocoding: the user placed that pin themselves, possibly
    by dragging it onto the exact gate they walk through. Re-geocoding the seed
    address on top of it would quietly move the workplace back to the factory
    default every time the export runs.
    """
    saved = config.load_saved_setup()
    if saved:
        _name, _addr, lat, lon = config.effective_company(saved)
        print(f"[company] using saved setup: {_name} ({lat}, {lon})", file=sys.stderr)
        return lat, lon

    hit = geocode.geocode_address(config.COMPANY_GEOCODE_QUERY)
    if hit:
        lat, lon, matched = hit
        print(f"[company] geocoded '{config.COMPANY_GEOCODE_QUERY}' -> {matched} ({lat}, {lon})", file=sys.stderr)
        return lat, lon
    lat, lon = config.COMPANY_FALLBACK_LATLON
    print(f"[company] geocoding failed, using fallback coord ({lat}, {lon})", file=sys.stderr)
    return lat, lon


def stops_within_radius(bus_stops, center_lat, center_lon, radius_m):
    """Return list of bus_stop records (dict, plus 'DistanceM') within radius_m of center."""
    hits = []
    for stop in bus_stops:
        d = haversine_m(center_lat, center_lon, float(stop["Latitude"]), float(stop["Longitude"]))
        if d <= radius_m:
            hit = dict(stop)
            hit["DistanceM"] = round(d, 1)
            hits.append(hit)
    hits.sort(key=lambda s: s["DistanceM"])
    return hits


def match_shuttle_stop(shuttle_cfg, bus_stops, min_score=0.6, max_coord_dist_m=300):
    """Resolve a shuttle pickup point to an LTA bus stop.

    Strategy, most trustworthy first:
      1. `bus_stop_code` pinned in config      -> method "pinned"
      2. exact normalized Description match     -> method "exact_text"
      3. fuzzy token overlap, but only among candidates whose *numbers* agree
         (see geo_utils.numbers_compatible)     -> method "fuzzy_text"
      4. nearest real bus stop to the point's known coordinate, within
         `max_coord_dist_m`                     -> method "nearest_coord"

    Step 3's number guard matters: without it "Aft Pasir Ris St 53" scores 0.80
    against "Aft Pasir Ris St 72" -- a stop on Pasir Ris Dr 12, right next to
    the office -- which silently wrecks the whole analysis for that point.

    Returns a dict with keys: stop, score, method, distance_m, confident.
    """
    def result(stop, score, method, distance_m=None, confident=True):
        return {
            "stop": stop, "score": score, "method": method,
            "distance_m": distance_m, "confident": confident,
        }

    by_code = {s["BusStopCode"]: s for s in bus_stops}

    # 1. explicit override
    pinned = shuttle_cfg.get("bus_stop_code")
    if pinned:
        if pinned in by_code:
            return result(by_code[pinned], 1.0, "pinned")
        print(f"  [match] pinned bus_stop_code {pinned} not found in LTA data", file=sys.stderr)

    candidates = [shuttle_cfg["match_text"]] + shuttle_cfg.get("match_text_alt", [])

    # 2. exact normalized text match
    for stop in bus_stops:
        desc = stop.get("Description", "")
        for cand in candidates:
            if normalize_text(cand) == normalize_text(desc):
                return result(stop, 1.0, "exact_text")

    # 3. fuzzy text, with the numeric guard
    best_stop, best_score = None, 0.0
    for stop in bus_stops:
        desc = stop.get("Description", "")
        for cand in candidates:
            if not numbers_compatible(cand, desc):
                continue
            score = token_overlap_score(cand, desc)
            if score > best_score:
                best_stop, best_score = stop, score
    if best_stop is not None and best_score >= min_score:
        return result(best_stop, best_score, "fuzzy_text")

    # 4. fall back to the nearest stop to the known coordinate
    latlon = shuttle_cfg.get("fallback_latlon")
    if latlon:
        lat, lon = latlon
        nearest, nearest_d = None, float("inf")
        for stop in bus_stops:
            d = haversine_m(lat, lon, float(stop["Latitude"]), float(stop["Longitude"]))
            if d < nearest_d:
                nearest, nearest_d = stop, d
        if nearest is not None and nearest_d <= max_coord_dist_m:
            # a coordinate match is a guess about which stop the shuttle uses,
            # so flag it for the user to confirm rather than trusting it
            return result(nearest, best_score, "nearest_coord", round(nearest_d, 1), confident=False)

    return result(None, best_score, "none", confident=False)
