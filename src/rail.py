"""MRT/LRT network: station coordinates + per-line station order.

There is no free LTA DataMall endpoint that gives MRT station coordinates, so
the network is harvested from OneMap's public search API. Every station shows
up there as e.g. "JURONG EAST MRT STATION (EW24 / NS1)" -- the parenthesised
station codes carry both the line (letter prefix) and the position along that
line (number), which is all we need: sorting the codes of one prefix
numerically reproduces the real running order of that line, so "same line = no
transfer" and "N stops away" fall out without any timetable data.

Cached to data/raw/rail_stations.json; the harvest takes ~60s and only has to
run once (the app's download step does it alongside the bus datasets).
"""

import json
import re
import sys
import time

import requests

import config

ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search"

# "<NAME> MRT STATION (EW24 / NS1)" -> name, kind, codes
_STATION_RE = re.compile(
    r"^(.*?)\s+(MRT|LRT) STATION\s*"
    r"\(([A-Z]{2,3}\d*[A-Za-z]?(?:\s*/\s*[A-Z]{2,3}\d*[A-Za-z]?)*)\)\s*$"
)
_CODE_RE = re.compile(r"^([A-Z]+)(\d*)$")

CACHE_NAME = "rail_stations"


def cache_path():
    return config.DATA_RAW_DIR / f"{CACHE_NAME}.json"


def has_cached_data():
    return cache_path().exists()


def _search_page(session, query, page, timeout=15):
    resp = session.get(
        ONEMAP_SEARCH_URL,
        params={"searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": page},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def _harvest(query, progress_cb=None, max_pages=200):
    """Page through one OneMap search term, tolerating the odd flaky page."""
    session = requests.Session()
    rows, page = [], 1
    while page <= max_pages:
        for attempt in range(3):
            try:
                data = _search_page(session, query, page)
                break
            except (requests.RequestException, ValueError) as e:
                if attempt == 2:
                    raise RuntimeError(f"OneMap 查詢 '{query}' 第 {page} 頁失敗：{e}")
                time.sleep(1.0)
        batch = data.get("results", [])
        rows.extend(batch)
        if progress_cb:
            progress_cb(query, len(rows))
        if not batch or page >= int(data.get("totalNumPages", 1)):
            break
        page += 1
    return rows


def _parse(rows):
    """Collapse raw OneMap hits into {station name -> {codes, lat, lon}}.

    Rows without a station code in the name are dropped -- those are the
    per-exit entries ("... MRT STATION EXIT A") and the odd duplicate, and
    every one of them names a station we already picked up with its codes.
    """
    stations = {}
    for r in rows:
        m = _STATION_RE.match((r.get("SEARCHVAL") or "").strip())
        if not m:
            continue
        name, kind, code_blob = m.group(1), m.group(2), m.group(3)
        entry = stations.setdefault(
            name,
            {"name": name, "kind": kind, "codes": set(), "lat": float(r["LATITUDE"]), "lon": float(r["LONGITUDE"])},
        )
        entry["codes"].update(c.strip() for c in code_blob.split("/"))
    return stations


def fetch_rail_network(progress_cb=None, force_refresh=False):
    """Harvest (or load cached) MRT/LRT stations. Returns the raw station dict."""
    path = cache_path()
    if path.exists() and not force_refresh:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return {n: {**s, "codes": set(s["codes"])} for n, s in raw.items()}

    rows = []
    for q in ("MRT STATION", "LRT STATION"):
        rows.extend(_harvest(q, progress_cb=progress_cb))
    stations = _parse(rows)

    # A partial harvest would silently produce a network with missing stations
    # (and therefore wrong "direct line" answers), so refuse to cache one.
    if len(stations) < 150:
        raise RuntimeError(
            f"OneMap 只回傳 {len(stations)} 個捷運站，資料明顯不完整，不寫入快取。請稍後再試。"
        )

    with open(path, "w", encoding="utf-8") as f:
        json.dump({n: {**s, "codes": sorted(s["codes"])} for n, s in stations.items()},
                  f, ensure_ascii=False, indent=2)
    return stations


def build_network(stations=None):
    """Turn the station dict into the {stations, lines} bundle the browser uses.

    lines[] entries are [lineCode, displayName, hexColor, [stationName, ...]]
    with the stations in running order.
    """
    stations = stations or fetch_rail_network()

    by_line = {}
    for name, s in stations.items():
        for code in s["codes"]:
            m = _CODE_RE.match(code)
            if not m:
                continue
            prefix, num = m.group(1), m.group(2)
            if prefix not in config.RAIL_LINES:
                continue  # not-yet-open lines (CR/JS/JE) -- see config for why
            by_line.setdefault(prefix, []).append((int(num or 0), code, name))

    lines = []
    for prefix in config.RAIL_LINES:
        if prefix not in by_line:
            continue
        ordered = [name for _, _, name in sorted(by_line[prefix])]
        # Stub lines are stored without the interchange they hang off, which
        # would leave them stranded from the trunk line they actually run on.
        for junction in config.RAIL_LINE_JUNCTIONS.get(prefix, []):
            if junction in stations and junction not in ordered:
                ordered.insert(0, junction)
        if len(ordered) < 2:
            continue
        display, color = config.RAIL_LINES[prefix]
        lines.append([prefix, display, color, ordered])

    out_stations = {}
    for name, s in stations.items():
        codes = sorted(c for c in s["codes"] if _CODE_RE.match(c)
                       and _CODE_RE.match(c).group(1) in config.RAIL_LINES)
        on_lines = sorted({_CODE_RE.match(c).group(1) for c in codes})
        for prefix, junctions in config.RAIL_LINE_JUNCTIONS.items():
            if name in junctions and prefix in {l[0] for l in lines} and prefix not in on_lines:
                on_lines.append(prefix)
        if not on_lines:
            continue
        out_stations[name] = [round(s["lat"], 6), round(s["lon"], 6), s["kind"], codes, sorted(on_lines)]

    # keep only stations that survived the line filter
    lines = [[p, d, c, [n for n in seq if n in out_stations]] for p, d, c, seq in lines]
    lines = [l for l in lines if len(l[3]) >= 2]

    return {"stations": out_stations, "lines": lines}


if __name__ == "__main__":
    net = build_network()
    print(f"{len(net['stations'])} stations / {len(net['lines'])} lines", file=sys.stderr)
    for code, display, _color, seq in net["lines"]:
        print(f"  {code:4s} {display:34s} {len(seq):3d}  {seq[0]} -> {seq[-1]}", file=sys.stderr)
