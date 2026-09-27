"""One row per bus route variant, as the browser computes on it.

Both the live app (app.py) and the single-file export ship the same rows, so the
shape lives here once:

    [ServiceNo, Direction, [stop codes], label, [km from origin per stop], headway]

The last two turn "N stops" into minutes. LTA's BusRoutes already carries each
stop's distance along the route, and a stop is 0.2-0.7 km apart depending on the
route (p10-p90 of 26,073 gaps, 2026-09-22), so a stop count alone says little
about how long the ride is. The headway is BusServices' AM peak frequency; half
of it is the expected wait at the stop.
"""

import re

from src import route_labels


def _freq_minutes(text):
    """"09-10" -> 9.5, "12" -> 12.0, "-" or "" -> None."""
    nums = [int(n) for n in re.findall(r"\d+", text or "")]
    return sum(nums) / len(nums) if nums else None


def headway_table(services):
    """(ServiceNo, Direction) -> minutes between buses in the morning peak.

    141 of the 806 variants have no AM peak figure ("-"), mostly services that
    do not run then; the off-peak and PM figures are the next best guess, and a
    variant with none of them gets None so the browser applies its own default.
    """
    out = {}
    for s in services:
        try:
            key = (s["ServiceNo"], int(s["Direction"]))
        except (KeyError, TypeError, ValueError):
            continue
        for field in ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq"):
            m = _freq_minutes(s.get(field))
            if m:
                out[key] = round(m, 1)
                break
    return out


def build_rows(variants, labels, stop_desc, headways):
    """`variants`: {(ServiceNo, Direction): [LTA BusRoutes records]}."""
    rows = []
    for key in sorted(variants, key=lambda k: (str(k[0]), k[1])):
        recs = sorted(variants[key], key=lambda r: r["StopSequence"])
        seq = [r["BusStopCode"] for r in recs]
        km, last = [], 0.0
        for r in recs:
            try:
                d = float(r["Distance"])
            except (KeyError, TypeError, ValueError):
                d = last
            # one variant (857 direction 1) steps backwards once; never let a
            # ride come out as negative time
            last = max(last, d)
            km.append(round(last, 2))
        try:
            headway = headways.get((key[0], int(key[1])))
        except (TypeError, ValueError):
            headway = None
        rows.append([key[0], key[1], seq,
                     route_labels.label_for(labels, key[0], key[1], seq, stop_desc), km, headway])
    return rows
