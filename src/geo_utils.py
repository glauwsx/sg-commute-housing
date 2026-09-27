"""Small geo helpers: haversine distance and text normalization for stop matching."""

import math
import re

EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two (lat, lon) points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def normalize_text(s):
    """Lowercase, strip punctuation/extra whitespace for fuzzy text matching."""
    if not s:
        return ""
    s = s.lower()
    s = s.replace("'", "").replace("’", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def token_overlap_score(a, b):
    """Simple similarity: fraction of tokens in `a` that also appear in `b`."""
    ta, tb = set(normalize_text(a).split()), set(normalize_text(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta)


def numbers_in(s):
    return set(re.findall(r"\d+", s or ""))


def numbers_compatible(query, candidate):
    """Guard against matching bus stops that differ only by their number.

    Bus stop names are dominated by shared words ("Aft Pasir Ris St 53" vs
    "Aft Pasir Ris St 72" share 4 of 5 tokens -> 0.80 overlap), so plain token
    overlap happily returns a stop on a completely different street. Require
    every number in the query to also appear in the candidate.
    """
    nq = numbers_in(query)
    if not nq:
        return True
    return nq <= numbers_in(candidate)
