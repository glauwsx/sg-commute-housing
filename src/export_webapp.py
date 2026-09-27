"""Export a single-file offline copy of the explorer.

The embedded setup comes from data/processed/setup.json when the app has saved
one -- workplace, radii, mode toggles and pickup points included. Seeding it
from config.py regardless meant you could spend an afternoon placing your
workplace in the app and still hand someone a file that opens on the factory
default.

It inlines the SAME html/css/js the Flask app serves (webapp/), plus Leaflet and
a pre-computed data bundle, so there is only one implementation of the matching
logic to maintain and the result is a genuinely self-contained file: no CDN, no
Python, no API key. The offline copy detects `window.EMBEDDED_BUNDLE` and skips
the steps that need a server (key setup, data download); it keeps the user's
setup in localStorage and calls OneMap directly for address search, which works
because OneMap sends `Access-Control-Allow-Origin: *`.

Only map *tiles* still need the network.
"""

import base64
import hashlib
import json
import sys

import config
from src import lta_client, rail, route_labels, route_rows

WEBAPP_DIR = config.PROJECT_ROOT / "webapp"
HTML_PATH = WEBAPP_DIR / "templates" / "index.html"
CSS_PATH = WEBAPP_DIR / "static" / "style.css"
JS_PATH = WEBAPP_DIR / "static" / "app.js"
VENDOR_DIR = WEBAPP_DIR / "static" / "vendor"

COLOR_HEX = {
    "orange": "#f59e0b",
    "purple": "#8b5cf6",
    "darkgreen": "#15803d",
    "darkred": "#b91c1c",
    "blue": "#2563eb",
    "gray": "#6b7280",
}


def _saved_int(saved, key, fallback):
    try:
        return int(saved[key])
    except (KeyError, TypeError, ValueError):
        return fallback


def build_bundle(result):
    """The full bus network plus the current setup, for client-side recompute."""
    stop_index = result["stop_index"]
    route_variants = result["route_variants"]

    stops = {
        code: [
            round(float(s["Latitude"]), 6),
            round(float(s["Longitude"]), 6),
            s.get("Description", ""),
            s.get("RoadName", ""),
        ]
        for code, s in stop_index.items()
    }

    stop_desc = {code: v[2] for code, v in stops.items()}
    services = lta_client.get_bus_services()
    labels = route_labels.build_route_labels(services, stop_desc)
    routes = route_rows.build_rows(route_variants, labels, stop_desc, route_rows.headway_table(services))

    try:
        rail_net = rail.build_network()
    except Exception as e:  # offline export must still work without the OneMap cache
        print(f"  [export] no rail network ({e}); the offline copy will be bus-only", file=sys.stderr)
        rail_net = {"stations": {}, "lines": []}

    saved = config.load_saved_setup()

    shuttles = []
    for cfg_stop in result["shuttle_cfgs"]:
        name = cfg_stop["name"]
        res = result["shuttle_results"].get(name, {})
        matched = res.get("matched_stop")
        lat, lon = res.get("latlon", cfg_stop["fallback_latlon"])
        shuttles.append(
            {
                "name": name,
                "time": cfg_stop.get("departure_time", ""),
                "enabled": True,
                "code": matched["BusStopCode"] if matched else None,
                "lat": round(float(lat), 6),
                "lon": round(float(lon), 6),
                # a point added in the app already carries its colour; only the
                # seeds in config.py go through the name -> colour table
                "color": cfg_stop.get("color_hex")
                or COLOR_HEX.get(config.SHUTTLE_COLORS.get(name, "gray"), "#6b7280"),
            }
        )

    company_name, company_address, _lat, _lon = config.effective_company(saved)
    company_radius, walk_radius, max_stops = config.effective_radii(saved)
    # The saved setup is what the user tuned in the app; the offline copy exists
    # to hand that to someone else, so it opens on their settings, not the seeds.
    modes = dict(config.DEFAULT_MODES)
    if saved and isinstance(saved.get("modes"), dict):
        modes.update(saved["modes"])

    setup = {
        "company": {
            "name": company_name,
            "address": company_address,
            "lat": round(float(result["company_lat"]), 6),
            "lon": round(float(result["company_lon"]), 6),
            # no saved setup = the seed placeholder, which the page labels as one;
            # a name the user typed must survive their next drag of the pin
            "isDefault": not saved,
            "nameEdited": bool(saved and (saved.get("company") or {}).get("nameEdited")),
        },
        "companyRadius": company_radius,
        "walkRadius": walk_radius,
        "maxStops": max_stops,
        "feederMin": _saved_int(saved, "feederMin", config.DEFAULT_FEEDER_MIN),
        "maxTotalMin": _saved_int(saved, "maxTotalMin", config.DEFAULT_MAX_TOTAL_MIN),
        "modes": modes,
        "shuttles": shuttles,
    }

    return {
        "stops": stops,
        "routes": routes,
        "towns": config.TOWN_KEYWORDS,
        "rail": rail_net,
        "transferWalk": config.TRANSFER_WALK_M,
        "railWalk": config.RAIL_WALK_M,
        "timeModel": config.TIME_MODEL,
        # model names only -- the reader brings their own key (stored in their
        # browser); the author's key must never ride along in a file meant to be passed on
        "aiModels": config.AI_MODELS,
        "setup": setup,
        # Identifies which built-in setup this file was generated with. The copy
        # keeps the reader's own edits in localStorage and those deliberately
        # win, so without this stamp re-exporting with a new workplace looks
        # like it silently did nothing.
        "buildId": hashlib.sha1(
            json.dumps(setup, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:12],
    }


def export(result):
    bundle = build_bundle(result)
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))

    html = HTML_PATH.read_text(encoding="utf-8")
    css = CSS_PATH.read_text(encoding="utf-8")
    js = JS_PATH.read_text(encoding="utf-8")

    # Leaflet locates its default marker images from the URL it was served from,
    # which cannot work once it is inlined -- hand them over as data: URIs.
    icons = {
        key: "data:image/png;base64," + base64.b64encode((VENDOR_DIR / "images" / name).read_bytes()).decode()
        for key, name in (
            ("icon", "marker-icon.png"),
            ("icon2x", "marker-icon-2x.png"),
            ("shadow", "marker-shadow.png"),
        )
    }

    html = html.replace(
        '<link rel="stylesheet" href="/static/vendor/leaflet.css">',
        "<style>\n" + (VENDOR_DIR / "leaflet.css").read_text(encoding="utf-8") + "\n</style>",
    )
    html = html.replace(
        '<script src="/static/vendor/leaflet.js"></script>',
        "<script>\n" + (VENDOR_DIR / "leaflet.js").read_text(encoding="utf-8") + "\n</script>"
        + "\n<script>window.LEAFLET_ICONS = " + json.dumps(icons) + ";</script>",
    )
    html = html.replace('<link rel="stylesheet" href="/static/style.css">', f"<style>\n{css}\n</style>")
    html = html.replace(
        '<script src="/static/app.js"></script>',
        "<script>window.EMBEDDED_BUNDLE = " + payload + ";</script>\n<script>\n" + js + "\n</script>",
    )
    # Guard the *tags*, not the text: app.js legitimately contains the string
    # "/static/vendor/images/" inside the server-mode branch of the icon setup.
    for leftover in ('src="/static', 'href="/static', 'src="https://unpkg', 'href="https://unpkg'):
        if leftover in html:
            raise RuntimeError(f"offline export still links {leftover!r} -- it would not work standalone")

    out_path = config.OUTPUT_DIR / "explorer.html"
    out_path.write_text(html, encoding="utf-8")
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(
        f"Wrote offline explorer to {out_path} ({size_mb:.1f} MB, "
        f"{len(bundle['stops'])} stops, {len(bundle['routes'])} route variants, "
        f"{len(bundle['rail']['stations'])} rail stations)",
        file=sys.stderr,
    )
    return out_path
