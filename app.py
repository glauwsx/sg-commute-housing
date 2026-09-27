#!/usr/bin/env python3
"""Interactive local web app for the SG commute/housing analysis.

Everything happens in the browser UI -- entering the LTA API key, downloading
the bus network, moving the company, adding/editing shuttle pickup points,
tuning radii, probing candidate neighbourhoods and exporting the results.
There is no "run the script first, then look at a file" step.

    python app.py            # then open http://127.0.0.1:5000

The heavy matching logic runs client-side on the full bus network (see
webapp/static/app.js) so every drag and slider is instant; the server only
handles the LTA download, geocoding proxy and saving your setup.
"""

import datetime
import json
import os
import shutil
import sys
import threading
import webbrowser

from dotenv import load_dotenv, set_key

load_dotenv()

import config  # noqa: E402  (after load_dotenv so LTA_ACCOUNT_KEY is picked up)
from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

from src import ai_query, geocode, lta_client, rail, route_labels, route_rows  # noqa: E402
from src.match_stops import match_shuttle_stop  # noqa: E402

app = Flask(__name__, static_folder="webapp/static", template_folder="webapp/templates")

SHUTTLE_HEX = {
    "orange": "#f59e0b",
    "purple": "#8b5cf6",
    "darkgreen": "#15803d",
    "darkred": "#b91c1c",
    "blue": "#2563eb",
    "gray": "#6b7280",
}

ENV_PATH = config.PROJECT_ROOT / ".env"
SETUP_PATH = config.SETUP_PATH   # shared with the CLI export, which reads the same file

# --- live download progress (shared with the polling endpoint) --------------
_progress_lock = threading.Lock()
_progress = {"running": False, "done": False, "error": None, "counts": {}, "stage": "", "stageArg": ""}


def _set_progress(**kw):
    with _progress_lock:
        _progress.update(kw)


def _read_progress():
    with _progress_lock:
        return dict(_progress)


def _t(zh, en):
    """Pick the message for the language the page is showing. app.js sends it
    on every request, so a message the user sees matches the rest of the screen."""
    return en if request.headers.get("X-Lang") == "en" else zh


# --- static shell -----------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory("webapp/templates", "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("webapp/static", filename)


# --- status / key -----------------------------------------------------------
@app.route("/api/status")
def api_status():
    return jsonify(
        {
            "hasKey": bool(config.LTA_ACCOUNT_KEY),
            "hasAiKey": bool(config.GEMINI_API_KEY),
            "aiLocal": ai_query.ollama_up(config.OLLAMA_HOST),
            "hasData": lta_client.has_cached_data(),
            "hasRail": rail.has_cached_data(),
            "counts": lta_client.cached_counts(),
            "progress": _read_progress(),
        }
    )


@app.route("/api/key", methods=["POST"])
def api_key():
    """Validate an LTA key and, if it works, persist it to .env."""
    key = (request.json or {}).get("key", "").strip()
    if not key:
        return jsonify({"ok": False, "message": _t("請輸入 API key。", "Please enter an API key.")}), 400

    ok, message = lta_client.validate_key(key, lang=request.headers.get("X-Lang"))
    if not ok:
        return jsonify({"ok": False, "message": message}), 400

    _save_env(config.LTA_ACCOUNT_KEY_ENV, key)
    config.LTA_ACCOUNT_KEY = key  # apply immediately, no restart needed
    return jsonify({"ok": True, "message": message + _t(" 已儲存到 .env。", " Saved to .env.")})


def _save_env(name, value):
    """Write one key to .env, keeping a timestamped copy of the old file first --
    .env holds every credential this app has, and set_key rewrites it in place."""
    if ENV_PATH.exists():
        backups = config.PROJECT_ROOT / ".env-backups"
        backups.mkdir(exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(ENV_PATH, backups / f".env.{stamp}")
    ENV_PATH.touch(exist_ok=True)
    set_key(str(ENV_PATH), name, value)


# --- AI mode ----------------------------------------------------------------
@app.route("/api/ai-key", methods=["POST"])
def api_ai_key():
    key = (request.json or {}).get("key", "").strip()
    if not key:
        return jsonify({"ok": False, "message": _t("請貼上 Gemini API key。", "Please paste a Gemini API key.")}), 400
    ok, message = ai_query.validate_key(key, lang=request.headers.get("X-Lang"))
    if not ok:
        return jsonify({"ok": False, "message": message}), 400
    _save_env(config.GEMINI_API_KEY_ENV, key)
    config.GEMINI_API_KEY = key
    return jsonify({"ok": True, "message": message + _t(" 已儲存到 .env。", " Saved to .env.")})


@app.route("/api/ai", methods=["POST"])
def api_ai():
    """Answer one prompt built by app.js (system, user, optional JSON schema).
    The prompt lives in the browser so the single-file build, which calls Gemini
    itself, uses the same one."""
    req = request.json or {}
    if not isinstance(req.get("system"), str) or not isinstance(req.get("user"), str):
        return jsonify({"ok": False, "message": _t("請求格式不對。", "Malformed request.")}), 400
    try:
        text, via = ai_query.complete(
            req["system"], req["user"], req.get("schema"), float(req.get("temperature", 0)),
            ollama_host=config.OLLAMA_HOST, ollama_model=config.OLLAMA_MODEL,
            gemini_key=config.GEMINI_API_KEY, gemini_models=config.AI_MODELS,
            lang=request.headers.get("X-Lang"))
    except ai_query.AIError as e:
        return jsonify({"ok": False, "message": str(e)}), 503
    return jsonify({"ok": True, "text": text, "via": via})


# --- data download ----------------------------------------------------------
def _download_worker(force):
    try:
        # `stage` is a code plus what is being fetched; the page words it in its
        # own language (this thread has no request to read the language from)
        _set_progress(running=True, done=False, error=None, counts={}, stage="start", stageArg="")

        def cb(endpoint, n):
            with _progress_lock:
                _progress["counts"][endpoint] = n
                _progress["stageArg"] = endpoint

        for name in ("bus_stops", "bus_routes", "bus_services"):
            _set_progress(stage="dataset", stageArg=lta_client.DATASETS[name])
            lta_client.get_dataset(name, force_refresh=force, progress_cb=cb)

        # MRT/LRT comes from OneMap, not LTA -- different source, same step, so
        # the user only ever presses "download" once.
        _set_progress(stage="rail", stageArg="OneMap")
        rail.fetch_rail_network(force_refresh=force, progress_cb=cb)

        _set_progress(running=False, done=True, stage="done")
    except Exception as e:  # surfaced in the UI
        _set_progress(running=False, done=False, error=str(e), stage="failed")


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    if _read_progress()["running"]:
        return jsonify({"ok": False, "message": _t("下載已在進行中。", "A download is already running.")}), 409
    force = bool((request.json or {}).get("force"))
    threading.Thread(target=_download_worker, args=(force,), daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/progress")
def api_progress():
    return jsonify(_read_progress())


# --- the bus network bundle the browser computes on -------------------------
@app.route("/api/bundle")
def api_bundle():
    if not lta_client.has_cached_data():
        return jsonify({"ok": False, "message": _t("尚未下載公車資料。", "Bus data has not been downloaded yet.")}), 400

    stops_raw = lta_client.get_bus_stops()
    routes_raw = lta_client.get_bus_routes()

    stops = {}
    for s in stops_raw:
        stops[s["BusStopCode"]] = [
            round(float(s["Latitude"]), 6),
            round(float(s["Longitude"]), 6),
            s.get("Description", ""),
            s.get("RoadName", ""),
        ]

    # group route records into (ServiceNo, Direction) variants
    grouped = {}
    for r in routes_raw:
        grouped.setdefault((r["ServiceNo"], r["Direction"]), []).append(r)

    # Direction is an internal 1/2 key, so each variant also ships a label naming
    # where it actually goes -- see src/route_labels.py -- plus the distances and
    # headway that turn stop counts into minutes (src/route_rows.py)
    stop_desc = {code: v[2] for code, v in stops.items()}
    services = lta_client.get_bus_services()
    labels = route_labels.build_route_labels(services, stop_desc)
    routes = route_rows.build_rows(grouped, labels, stop_desc, route_rows.headway_table(services))

    # The rail network is small (190 stations) and the explorer is useless
    # without it once "捷運直達" is switched on, so it always rides along.
    try:
        net = rail.build_network()
    except Exception as e:  # a missing/partial OneMap harvest must not kill the bus view
        net = {"stations": {}, "lines": [], "error": str(e)}

    return jsonify(
        {
            "ok": True,
            "stops": stops,
            "routes": routes,
            "towns": config.TOWN_KEYWORDS,
            "rail": net,
            "transferWalk": config.TRANSFER_WALK_M,
            "railWalk": config.RAIL_WALK_M,
            "timeModel": config.TIME_MODEL,
            "aiModels": config.AI_MODELS,
        }
    )


# --- geocoding proxy (avoids browser CORS issues with OneMap) ---------------
@app.route("/api/geocode")
def api_geocode():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"ok": False, "results": []})
    hits = geocode.search_address(q)
    if not hits:
        return jsonify({"ok": False, "results": [], "message": _t(
            "查無此地址。換個關鍵字，或直接拖曳地圖上的圖示。",
            "No match. Try other words, or drag the pin on the map.")})
    return jsonify({"ok": True, "results": hits})


# --- persist / restore the interactive setup --------------------------------
@app.route("/api/setup", methods=["GET", "POST"])
def api_setup():
    if request.method == "POST":
        with open(SETUP_PATH, "w", encoding="utf-8") as f:
            json.dump(request.json or {}, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "message": _t(f"設定已儲存到 {SETUP_PATH.name}", f"Settings saved to {SETUP_PATH.name}")})

    if SETUP_PATH.exists():
        with open(SETUP_PATH, "r", encoding="utf-8") as f:
            return jsonify({"ok": True, "setup": json.load(f)})

    # First run: seed from config.py, resolving each shuttle point with the same
    # matcher the CLI uses (exact name match first, coordinate fallback second).
    # Letting the browser snap purely by distance would disagree with it -- e.g.
    # "Bef Ang Mo Kio Stn Exit B" is 214m from its exact-name stop 54399 but only
    # 113m from Ang Mo Kio Int, so nearest-wins would pick the wrong one.
    bus_stops = lta_client.get_bus_stops() if lta_client.has_cached_data() else None

    shuttles = []
    for s in config.SHUTTLE_STOPS:
        entry = {
            "name": s["name"],
            "time": s["departure_time"],
            "enabled": True,
            "matchText": s["match_text"],
            "lat": s["fallback_latlon"][0],
            "lon": s["fallback_latlon"][1],
            "code": None,
            "color": SHUTTLE_HEX.get(config.SHUTTLE_COLORS.get(s["name"], "gray"), "#6b7280"),
        }
        if bus_stops:
            m = match_shuttle_stop(s, bus_stops)
            if m["stop"]:
                entry["code"] = m["stop"]["BusStopCode"]
                entry["lat"] = float(m["stop"]["Latitude"])
                entry["lon"] = float(m["stop"]["Longitude"])
                entry["matchMethod"] = m["method"]
                entry["matchConfident"] = m["confident"]
                entry["matchedDesc"] = m["stop"]["Description"]
            else:
                entry["matchMethod"] = "none"
                entry["matchConfident"] = False
        shuttles.append(entry)

    return jsonify(
        {
            "ok": True,
            "setup": {
                "company": {
                    "name": config.COMPANY_NAME,
                    "address": config.COMPANY_ADDRESS,
                    "lat": config.COMPANY_FALLBACK_LATLON[0],
                    "lon": config.COMPANY_FALLBACK_LATLON[1],
                    # the seed is a placeholder, not anyone's workplace; the
                    # sidebar says so until the user moves it
                    "isDefault": True,
                },
                "companyRadius": config.COMPANY_RADIUS_M,
                "walkRadius": config.DEFAULT_WALK_RADIUS_M,
                "maxStops": config.DEFAULT_MAX_STOPS,
                "feederMin": config.DEFAULT_FEEDER_MIN,
                "maxTotalMin": config.DEFAULT_MAX_TOTAL_MIN,
                "modes": dict(config.DEFAULT_MODES),
                "shuttles": shuttles,
            },
        }
    )


def main():
    # PORT is what tooling that assigns a free port sets; SG_PORT is the manual override
    port = int(os.environ.get("SG_PORT") or os.environ.get("PORT") or 5000)
    url = f"http://127.0.0.1:{port}"
    print(f"\n  SG 通勤租屋互動探索器 -> {url}\n", file=sys.stderr)
    # SG_NO_BROWSER=1 keeps the server headless (used when driving it from tests)
    if not os.environ.get("SG_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
