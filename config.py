"""
Central configuration for the SG commute/housing analysis.

Coordinates marked "fallback" were resolved once via the free OneMap
(www.onemap.gov.sg) search API and hardcoded here so the pipeline can draw
map pins even before bus-stop text matching succeeds. The *authoritative*
positions come from matching COMPANY_ADDRESS / each shuttle stop's
`match_text` against the real LTA BusStops dataset (see src/match_stops.py) —
the fallback lat/lon is only used when that text match fails.
"""

import json
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_RAW_DIR = PROJECT_ROOT / "data" / "raw"
DATA_PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
OUTPUT_DIR = PROJECT_ROOT / "output"

for _d in (DATA_RAW_DIR, DATA_PROCESSED_DIR, OUTPUT_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- LTA DataMall -----------------------------------------------------------
# Apply for a free key at https://datamall.lta.gov.sg/ and put it in `.env`
# (copy .env.example -> .env) as LTA_ACCOUNT_KEY=xxxxx
LTA_ACCOUNT_KEY_ENV = "LTA_ACCOUNT_KEY"
# NOTE: must be https -- the plain http:// host returns 404 "The requested API
# was not found" for every endpoint (verified 2026-08-24).
LTA_BASE_URL = "https://datamall2.mytransport.sg/ltaodataservice"

# --- Workplace / destination ------------------------------------------------
# These are only the *seed* values for a fresh setup. The workplace is fully
# editable in the app (name field + OneMap address search + drag the pin), and
# whatever you end up with is saved to data/processed/setup.json, which wins
# over everything here on later runs. Change these only if you want a different
# out-of-the-box default.
#
# The seed is deliberately nobody's workplace: City Hall is the middle of the
# rail map (the EW and NS lines cross there), so a first-time user sees a
# sensible picture and is nudged to replace it (the sidebar says it is a
# default until they do). The author's own setup -- workplace plus four shuttle
# pickups -- lives in data/processed/preset-author.json; copy it over
# setup.json to get it back.
COMPANY_NAME = "City Hall"
COMPANY_ADDRESS = "City Hall MRT Station, 150 North Bridge Road"
# OneMap's search API chokes on a trailing ", Singapore <postal>" suffix and
# returns zero results, so geocoding uses this shorter query instead.
COMPANY_GEOCODE_QUERY = "City Hall MRT"
# OneMap search, 2026-09-23: "City Hall MRT" -> CITY HALL MRT STATION (EW13 / NS25)
COMPANY_FALLBACK_LATLON = (1.292936722277808, 103.8525855803662)

# Radius (metres) used to find bus stops / MRT stations "near" the workplace.
COMPANY_RADIUS_M = 500

# --- Shuttle bus pickup points -------------------------------------------
# Empty by default: most people have no company shuttle, and the 🚐 mode
# switches itself off when there is nothing to ride to (see DEFAULT_MODES).
# Pickup points are added in the app (＋ on the map). To seed some here, each
# entry looks like:
#
#   {"name": "Bef Ang Mo Kio Stn Exit B", "departure_time": "07:50",
#    "match_text": "Bef Ang Mo Kio Stn Exit B",        # vs LTA BusStops Description
#    "fallback_latlon": (1.3697, 103.8496),            # used if the text match fails
#    "bus_stop_code": "54399"}                         # optional: pin it, skip guessing
#
# `match_text` is matched against the LTA BusStops `Description` field; if that
# fails, the nearest real stop to `fallback_latlon` is used instead and flagged
# as needing verification.
SHUTTLE_STOPS = []

# Colour names (folium / app.py SHUTTLE_HEX) per seeded pickup point name.
# Points added in the app carry their own colour instead.
SHUTTLE_COLORS = {}

# --- Town/street grouping heuristic --------------------------------------
# Static keyword -> HDB town mapping used to group bus-stop road names into
# a rough town label for the output table. No API key required. Extend as
# needed; unmatched road names fall back to the raw road name itself.
TOWN_KEYWORDS = {
    "pasir ris": "Pasir Ris",
    "tampines": "Tampines",
    "bedok": "Bedok",
    "simei": "Tampines",
    "changi": "Changi",
    "loyang": "Pasir Ris",
    "ang mo kio": "Ang Mo Kio",
    "yio chu kang": "Ang Mo Kio",
    "bishan": "Bishan",
    "serangoon": "Serangoon",
    "hougang": "Hougang",
    "punggol": "Punggol",
    "sengkang": "Sengkang",
    "woodlands": "Woodlands",
    "admiralty": "Woodlands",
    "marsiling": "Woodlands",
    "sembawang": "Sembawang",
    "yishun": "Yishun",
    "jurong east": "Jurong East",
    "jurong west": "Jurong West",
    "clementi": "Clementi",
    "bukit batok": "Bukit Batok",
    "bukit panjang": "Bukit Panjang",
    "choa chu kang": "Choa Chu Kang",
    "tengah": "Tengah",
    "queenstown": "Queenstown",
    "bukit merah": "Bukit Merah",
    "toa payoh": "Toa Payoh",
    "novena": "Novena",
    "kallang": "Kallang",
    "geylang": "Geylang",
    "marine parade": "Marine Parade",
}

# --- MRT / LRT network ------------------------------------------------------
# Station coordinates come from OneMap search (see src/rail.py); the line and
# running order are decoded from the station code itself -- "EW24" = East West
# Line, 24th station -- so sorting one prefix numerically reproduces the line.
#
# ONLY LINES THAT ACTUALLY CARRY PASSENGERS BELONG HERE. OneMap already lists
# stations for lines under construction, and including them invents journeys
# that are impossible today: the Cross Island Line (CR) currently returns four
# scattered stations, which would make CR11 Ang Mo Kio look like a no-transfer
# ride to CR4 Pasir Ris East. Same for the Jurong Region Line (JS/JE). Add a
# prefix here on the day the line opens, not before.
#   prefix -> (display name, hex colour used on the map)
# Names are the official English ones -- the app shows them unchanged in both
# of its languages, as every station name is English too.
RAIL_LINES = {
    "NS": ("North South Line", "#d42e12"),
    "EW": ("East West Line", "#009645"),
    "CG": ("East West Line (Changi branch)", "#009645"),
    "NE": ("North East Line", "#9900aa"),
    "CC": ("Circle Line", "#fa9e0d"),
    "DT": ("Downtown Line", "#005ec4"),
    "TE": ("Thomson-East Coast Line", "#9d5b25"),
    "BP": ("Bukit Panjang LRT", "#748477"),
    "SW": ("Sengkang LRT West Loop", "#748477"),
    "SE": ("Sengkang LRT East Loop", "#748477"),
    "PW": ("Punggol LRT West Loop", "#748477"),
    "PE": ("Punggol LRT East Loop", "#748477"),
}

# Branch lines whose junction station carries no code for that branch, so the
# branch would otherwise float free of the line it feeds into. The Changi branch
# runs Tanah Merah -> Expo -> Changi Airport but Tanah Merah is only ever
# labelled EW4; likewise every Sengkang/Punggol LRT loop starts at the MRT
# station itself, which is labelled STC/PTC rather than SW1/SE1/PW0/PE0.
RAIL_LINE_JUNCTIONS = {
    "CG": ["TANAH MERAH"],
    "SW": ["SENGKANG"],
    "SE": ["SENGKANG"],
    "PW": ["PUNGGOL"],
    "PE": ["PUNGGOL"],
}

# --- Commute modes ----------------------------------------------------------
# A commute is modelled as (feeder leg from home) + (final destination), which
# is why there is no combinatorial explosion of options to configure:
#
#     feeder:      walk  |  <= maxStops by bus  |  <= maxStops by rail
#     destination: the workplace                |  a shuttle pickup point
#
# The four modes below are the ways that pairing can actually complete a trip.
# Seed values for a fresh setup; every one of them is a toggle in the app.
# `starRule` decides what earns a place the ⭐: "any" = one mode is enough,
# "two" = at least two independent ways to get to work, "all" = every enabled
# mode must work.
DEFAULT_MODES = {
    "bus": True,          # a bus route serving a stop near home also serves the workplace
    "rail": True,         # an MRT/LRT line serving a station near home also serves the workplace
    # Off when no pickup points are configured -- seeding an empty shuttle list
    # and still switching the mode on would just show everyone an empty section.
    "shuttle": bool(SHUTTLE_STOPS),
    "transfer": False,    # ride a few stops, change to a bus/line that does serve the workplace
    "railTransfers": 0,   # for `rail`: 0 = same line only, 1 = one interchange allowed, 2 = two
    # Which feeder legs count as "I can get to the shuttle". Walking there and
    # riding a bus at 07:00 to catch it are very different propositions, so they
    # are separate switches rather than one shuttle on/off.
    "shuttleAccess": {"walk": True, "bus": True, "rail": True},
    "starRule": "two",
}

# How far someone will walk *between* two vehicles when changing -- both when
# transferring to a bus/train that serves the workplace, and when getting off
# near a shuttle pickup point. Deliberately much shorter than the walk-from-home
# radius: a 400m hike mid-trip with a bag is not the same as a 400m walk to your
# first stop of the day.
TRANSFER_WALK_M = 300

# The same allowance for rail, and it has to be more generous. A station is one
# coordinate here but a few hundred metres of structure in reality, with exits at
# both ends -- Pasir Ris station's centroid is 391m from the Pasir Ris shuttle
# pickup point, yet they are an ordinary short walk apart. Measuring from the
# centroid with the bus-stop allowance would call that unreachable.
RAIL_WALK_M = 500

# Seed values for the sliders that are not otherwise represented above.
DEFAULT_WALK_RADIUS_M = 400
# Only the CLI (main.py -> analyze.py, bus-only) still thinks in stops.
DEFAULT_MAX_STOPS = 1
# The explorer limits the first leg (to a shuttle pickup, or before changing to a
# vehicle that serves the workplace) by minutes on board instead: "3 stops" is
# 0.9 km on one route and 1.8 km on another, and one MRT stop is several bus
# stops. 5 min on board is about three bus stops or one to two MRT stations.
DEFAULT_FEEDER_MIN = 5
# Door-to-door ceiling for 🚌 / 🚆 / 🔁. A direct bus is still no good if it
# takes 80 minutes.
DEFAULT_MAX_TOTAL_MIN = 60

# How estimated minutes are built: walk + wait + ride (+ changes). Seed values,
# not facts -- adjust them if your own trips come out consistently off.
TIME_MODEL = {
    # Straight-line metres are shorter than the path a person actually walks.
    "walkMPerMin": 80,
    "walkDetour": 1.3,
    # Along LTA's route distance. Calibrated 2026-09-22 against Google Maps,
    # weekday 08:00 departures, interchange to interchange (wait + ride):
    #   3  Punggol Int -> Pasir Ris Int  11.7 km  Google 41  model 46
    #   69 Bedok Int -> Tampines Int      7.3 km  Google 31  model 30
    #   10 Tampines Int -> Changi Gen Hosp 2.3 km  Google 18  model 13 (Google adds the walk in)
    # A published "about 15 km/h" average (From the Red Line, Medium) came out
    # 10 min slow on the long route.
    "busKmh": 17,
    # Wait = half the AM peak headway from BusServices; this is the fallback for
    # the 22 variants with no figure at all.
    "busWaitDefaultMin": 6,
    # Applied to straight-line distance between consecutive stations, which is
    # shorter than the track -- hence the low figure. Same calibration, station
    # to station at 08:00 (ride only):
    #   EW Pasir Ris -> Tuas Link   46.8 km  Google 102  model 100
    #   NE Punggol -> HarbourFront  18.8 km  Google 41   model 40
    #   EW Tampines -> Raffles Pl   16.3 km  Google 36   model 35
    #   NS Woodlands -> Ang Mo Kio  13.9 km  Google 24   model 30
    # 40 km/h (from Simple Wikipedia's "about 1 hour" end to end) was 35% fast.
    "railKmh": 28,
    "railWaitMin": 3,
    # Changing MRT lines inside the network: platform walk plus the next wait.
    "railInterchangeMin": 5,
}

LTA_ACCOUNT_KEY = os.environ.get(LTA_ACCOUNT_KEY_ENV, "")

# --- AI mode ----------------------------------------------------------------
# The AI only answers a handful of multiple-choice questions about the user's
# sentence; numbers, times and place names are read by app.js itself. A local
# model is enough for that and is tried first: free, private, and immune to the
# free cloud tier's "high demand" 503s (3 of 4 Gemini lite models were
# returning them on 2026-09-22). Gemini is the fallback, and the only option in
# the single-file copy, where each reader brings their own key.
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b")
# Optional. Free key: https://aistudio.google.com/apikey
GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
GEMINI_API_KEY = os.environ.get(GEMINI_API_KEY_ENV, "")
# The lite group: no thinking overhead, and turning a sentence into a handful of
# filter values does not need it. 15 requests/min, >=37/day measured 2026-09-07
# (see ~/ClaudeCode/lib/llm_quota.py); same list the telegram bot uses for its
# structured calls. The single-file build tries them in this order too.
AI_MODELS = [m.strip() for m in os.environ.get(
    "GEMINI_LIGHT_MODELS",
    "gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite,gemini-3.1-flash-lite-preview",
).split(",") if m.strip()]

# --- the saved setup, which outranks every seed value above -----------------
SETUP_PATH = DATA_PROCESSED_DIR / "setup.json"


def load_saved_setup():
    """The setup the app saved, or None if there isn't a usable one.

    Everything above is a *seed*: the workplace and the pickup points are edited
    in the app and saved here. Every consumer has to read this file, or `python
    main.py` re-exports the seed workplace over whatever the user configured --
    which is exactly what the shareable single-file copy is not supposed to do.

    The public website build (`main.py --public`) is the one exception: it must
    never carry the workplace and pickups of whoever ran it, so it always opens
    on the neutral seeds above no matter what is saved on this machine.
    """
    if os.environ.get("SG_COMMUTE_PUBLIC") == "1":
        return None
    if not SETUP_PATH.exists():
        return None
    try:
        with open(SETUP_PATH, "r", encoding="utf-8") as f:
            setup = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(setup, dict):
        return None
    company = setup.get("company") or {}
    try:
        float(company["lat"]), float(company["lon"])
    except (KeyError, TypeError, ValueError):
        return None  # a setup without a placed workplace tells us nothing
    return setup


def effective_company(setup=None):
    """(name, address, lat, lon) for the workplace: saved setup wins."""
    setup = setup if setup is not None else load_saved_setup()
    if setup:
        c = setup["company"]
        return (c.get("name") or COMPANY_NAME, c.get("address") or COMPANY_ADDRESS,
                float(c["lat"]), float(c["lon"]))
    return COMPANY_NAME, COMPANY_ADDRESS, COMPANY_FALLBACK_LATLON[0], COMPANY_FALLBACK_LATLON[1]


def effective_shuttles(setup=None):
    """Pickup points in SHUTTLE_STOPS shape, saved setup wins.

    The app resolves each point to a real bus stop already, so a saved point
    arrives with its `code` -- passed through as `bus_stop_code` it pins the
    match instead of being guessed at again. Disabled points are dropped: the
    user switched them off, and the export is not the place to switch them back
    on. An empty list is a legitimate answer (no company shuttle at all).
    """
    setup = setup if setup is not None else load_saved_setup()
    if not setup or "shuttles" not in setup:
        return list(SHUTTLE_STOPS)
    out = []
    for sh in setup.get("shuttles") or []:
        if sh.get("enabled") is False:
            continue
        try:
            latlon = (float(sh["lat"]), float(sh["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        out.append({
            "name": sh.get("name") or "未命名廠車點",
            "departure_time": sh.get("time") or "",
            "match_text": sh.get("matchText") or sh.get("name") or "",
            "bus_stop_code": sh.get("code"),
            "fallback_latlon": latlon,
            "color_hex": sh.get("color"),
        })
    return out


def effective_radii(setup=None):
    """(companyRadius, walkRadius, maxStops), saved setup wins."""
    setup = setup if setup is not None else load_saved_setup()
    defaults = (COMPANY_RADIUS_M, DEFAULT_WALK_RADIUS_M, DEFAULT_MAX_STOPS)
    if not setup:
        return defaults
    keys = ("companyRadius", "walkRadius", "maxStops")
    out = []
    for key, fallback in zip(keys, defaults):
        try:
            out.append(int(setup[key]))
        except (KeyError, TypeError, ValueError):
            out.append(fallback)
    return tuple(out)
