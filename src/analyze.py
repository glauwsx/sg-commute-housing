"""Core analysis: which bus routes reach the company directly, which stops
are one bus-stop away from each shuttle pickup point, and which areas
satisfy both (priority candidates).

Route "variant" = (ServiceNo, Direction). LTA already splits services into
Direction 1 / Direction 2 (and gives express/loop variants their own
ServiceNo, e.g. "39" vs "39e"), so keying on (ServiceNo, Direction) keeps
outbound/inbound and any such variants separate, per the task's requirement
to not merge them.
"""

import sys
from collections import defaultdict

import config
from src.geo_utils import haversine_m
from src.match_stops import match_shuttle_stop, resolve_company_latlon, stops_within_radius
from src.route_labels import build_route_labels


def build_stop_index(bus_stops):
    return {s["BusStopCode"]: s for s in bus_stops}


def build_route_variants(bus_routes):
    """Group BusRoutes records into {(ServiceNo, Direction): [records sorted by StopSequence]}."""
    variants = defaultdict(list)
    for r in bus_routes:
        key = (r["ServiceNo"], r["Direction"])
        variants[key].append(r)
    for key in variants:
        variants[key].sort(key=lambda r: r["StopSequence"])
    return variants


def find_direct_routes(route_variants, company_stop_codes):
    """Return {(ServiceNo, Direction): [BusStopCode near company hit by this route]}."""
    company_stop_codes = set(company_stop_codes)
    direct = {}
    for key, records in route_variants.items():
        hits = [r["BusStopCode"] for r in records if r["BusStopCode"] in company_stop_codes]
        if hits:
            direct[key] = hits
    return direct


def all_stops_on_routes(route_variants, keys):
    """Return {BusStopCode: set of (ServiceNo, Direction) variants serving it} for given route keys."""
    stop_to_variants = defaultdict(set)
    for key in keys:
        for r in route_variants[key]:
            stop_to_variants[r["BusStopCode"]].add(key)
    return stop_to_variants


def find_one_stop_to_shuttle(route_variants, shuttle_bus_stop_code):
    """For a shuttle pickup point's BusStopCode, find every route variant that
    passes through it, and the immediately preceding stop in that variant's
    sequence (i.e. "board here, ride one stop, alight at the shuttle point").

    Returns list of dicts: {service_no, direction, from_stop_code}
    """
    results = []
    for (service_no, direction), records in route_variants.items():
        for i, r in enumerate(records):
            if r["BusStopCode"] == shuttle_bus_stop_code and i > 0:
                prev_stop = records[i - 1]
                results.append(
                    {
                        "service_no": service_no,
                        "direction": direction,
                        "from_stop_code": prev_stop["BusStopCode"],
                    }
                )
    return results


def town_for_road_name(road_name):
    if not road_name:
        return "Unknown"
    lower = road_name.lower()
    for keyword, town in config.TOWN_KEYWORDS.items():
        if keyword in lower:
            return town
    return road_name.title()


def run_analysis(bus_stops, bus_routes, bus_services):
    stop_index = build_stop_index(bus_stops)
    route_variants = build_route_variants(bus_routes)

    # 1) Company-area stops
    company_lat, company_lon = resolve_company_latlon()
    company_radius, _walk, _max_stops = config.effective_radii()
    company_stops = stops_within_radius(bus_stops, company_lat, company_lon, company_radius)
    company_stop_codes = [s["BusStopCode"] for s in company_stops]
    print(f"[company] {len(company_stops)} bus stops within {company_radius}m", file=sys.stderr)
    for s in company_stops:
        print(f"    {s['BusStopCode']} {s['Description']} ({s['DistanceM']}m)", file=sys.stderr)

    direct_routes = find_direct_routes(route_variants, company_stop_codes)
    print(f"[direct] {len(direct_routes)} route variants serve the company directly", file=sys.stderr)

    direct_stop_to_variants = all_stops_on_routes(route_variants, direct_routes.keys())

    # 2) Shuttle points: match to real bus stops, then find one-stop-away stops
    shuttle_results = {}
    shuttle_cfgs = config.effective_shuttles()
    for shuttle_cfg in shuttle_cfgs:
        name = shuttle_cfg["name"]
        m = match_shuttle_stop(shuttle_cfg, bus_stops)
        matched_stop = m["stop"]

        if matched_stop is None:
            print(
                f"[shuttle] '{name}': NO match (best score {m['score']:.2f}). "
                f"Using fallback coordinate for the map only; N-stop analysis skipped. "
                f"Drag this point in the app, or pin `bus_stop_code` in config.py.",
                file=sys.stderr,
            )
            shuttle_results[name] = {
                "matched_stop": None,
                "latlon": shuttle_cfg["fallback_latlon"],
                "one_stop": [],
                "match": m,
                "cfg": shuttle_cfg,
            }
            continue

        detail = f"score {m['score']:.2f}" if m["method"] != "nearest_coord" else f"{m['distance_m']}m away"
        flag = "" if m["confident"] else "  <-- PLEASE VERIFY"
        print(
            f"[shuttle] '{name}' -> {matched_stop['BusStopCode']} "
            f"'{matched_stop['Description']}' ({matched_stop['RoadName']}) "
            f"via {m['method']}, {detail}{flag}",
            file=sys.stderr,
        )
        one_stop = find_one_stop_to_shuttle(route_variants, matched_stop["BusStopCode"])
        for hit in one_stop:
            hit["from_stop"] = stop_index.get(hit["from_stop_code"])
        shuttle_results[name] = {
            "matched_stop": matched_stop,
            "latlon": (float(matched_stop["Latitude"]), float(matched_stop["Longitude"])),
            "one_stop": one_stop,
            "match": m,
            "cfg": shuttle_cfg,
        }
        print(f"    {len(one_stop)} (route, one-stop-before) combinations found", file=sys.stderr)

    # 3) Priority candidates: stops that are BOTH on a direct route AND
    #    one-stop-away from at least one shuttle point.
    priority = {}
    for name, res in shuttle_results.items():
        for hit in res["one_stop"]:
            code = hit["from_stop_code"]
            if code in direct_stop_to_variants:
                priority.setdefault(code, {"direct_variants": direct_stop_to_variants[code], "shuttle_hits": []})
                priority[code]["shuttle_hits"].append({"shuttle_name": name, **hit})

    print(f"[priority] {len(priority)} bus stops satisfy BOTH conditions", file=sys.stderr)

    company_name, company_address, _lat, _lon = config.effective_company()
    return {
        "company_lat": company_lat,
        "company_lon": company_lon,
        # carried on the result so the map/table consumers describe the workplace
        # and pickup points the user configured, not the seeds in config.py
        "company_name": company_name,
        "company_address": company_address,
        "company_radius": company_radius,
        "shuttle_cfgs": shuttle_cfgs,
        # (ServiceNo, Direction) -> "3 往 Punggol Int"; Direction on its own is an
        # internal 1/2 key and means nothing to a reader
        "route_labels": build_route_labels(
            bus_services, {code: s.get("Description", "") for code, s in stop_index.items()}
        ),
        "company_stops": company_stops,
        "route_variants": route_variants,
        "stop_index": stop_index,
        "direct_routes": direct_routes,
        "direct_stop_to_variants": direct_stop_to_variants,
        "shuttle_results": shuttle_results,
        "priority_stop_codes": priority,
    }
