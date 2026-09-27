"""Render the interactive folium map: company, direct-to-company routes,
shuttle pickup points + their one-stop-away stops, and priority candidates.
"""

import sys

import folium

import config

# Distinct-ish palette to cycle through for direct route variants.
ROUTE_COLOR_PALETTE = [
    "blue", "green", "red", "cadetblue", "darkblue", "darkgreen", "darkred",
    "lightblue", "lightgreen", "pink", "gray", "black", "beige",
]


def _route_color(index):
    return ROUTE_COLOR_PALETTE[index % len(ROUTE_COLOR_PALETTE)]


def build_map(result):
    company_lat, company_lon = result["company_lat"], result["company_lon"]
    company_name = result["company_name"]
    company_address = result["company_address"]
    company_radius = result["company_radius"]
    stop_index = result["stop_index"]
    route_variants = result["route_variants"]
    labels = result["route_labels"]
    direct_routes = result["direct_routes"]
    shuttle_results = result["shuttle_results"]
    priority_stop_codes = result["priority_stop_codes"]

    # OneMap, not CARTO: CARTO's tiles now carry an "API KEY REQUIRED" watermark
    m = folium.Map(location=[company_lat, company_lon], zoom_start=12,
                   tiles="https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png",
                   attr="OneMap &copy; contributors | Singapore Land Authority", min_zoom=11, max_zoom=19)

    # --- Company marker ---
    folium.Marker(
        [company_lat, company_lon],
        tooltip=company_name,
        popup=f"{company_name}<br>{company_address}",
        icon=folium.Icon(color="cadetblue", icon="industry", prefix="fa"),
    ).add_to(m)
    folium.Circle(
        [company_lat, company_lon],
        radius=company_radius,
        color="cadetblue",
        fill=True,
        fill_opacity=0.05,
        tooltip=f"{company_radius}m radius",
    ).add_to(m)

    # --- Direct routes: one FeatureGroup per route variant so they can be toggled ---
    for i, (key, records) in enumerate(sorted(direct_routes.items())):
        service_no, direction = key
        color = _route_color(i)
        fg = folium.FeatureGroup(name=f"Route {labels.get(key, service_no)} -> direct", show=True)
        coords = []
        for r in route_variants[key]:
            stop = stop_index.get(r["BusStopCode"])
            if not stop:
                continue
            lat, lon = float(stop["Latitude"]), float(stop["Longitude"])
            coords.append((lat, lon))
            folium.CircleMarker(
                [lat, lon],
                radius=3,
                color=color,
                fill=True,
                fill_opacity=0.8,
                popup=f"{labels.get(key, service_no)}<br>{stop['Description']} ({stop['BusStopCode']})",
            ).add_to(fg)
        if len(coords) > 1:
            folium.PolyLine(coords, color=color, weight=2, opacity=0.6).add_to(fg)
        fg.add_to(m)

    # --- Shuttle points + one-stop-away stops ---
    for name, res in shuttle_results.items():
        color = config.SHUTTLE_COLORS.get(name, "gray")
        fg = folium.FeatureGroup(name=f"Shuttle: {name}", show=True)
        lat, lon = res["latlon"]
        folium.Marker(
            [lat, lon],
            tooltip=f"Shuttle pickup: {name}",
            popup=f"{name}<br>departs {res['cfg'].get('departure_time') or '—'}",
            icon=folium.Icon(color=color, icon="bus", prefix="fa"),
        ).add_to(fg)

        seen_codes = set()
        for hit in res["one_stop"]:
            from_stop = hit.get("from_stop")
            if not from_stop or from_stop["BusStopCode"] in seen_codes:
                continue
            seen_codes.add(from_stop["BusStopCode"])
            flat, flon = float(from_stop["Latitude"]), float(from_stop["Longitude"])
            folium.CircleMarker(
                [flat, flon],
                radius=5,
                color=color,
                fill=True,
                fill_opacity=0.6,
                popup=(
                    f"One stop to '{name}'<br>{from_stop['Description']} ({from_stop['BusStopCode']})"
                    f"<br>via {labels.get((hit['service_no'], hit['direction']), hit['service_no'])}"
                ),
            ).add_to(fg)
        fg.add_to(m)

    # --- Priority candidates (both conditions satisfied) ---
    fg_priority = folium.FeatureGroup(name="⭐ Priority candidates (direct + one-stop)", show=True)
    for code, info in priority_stop_codes.items():
        stop = stop_index.get(code)
        if not stop:
            continue
        lat, lon = float(stop["Latitude"]), float(stop["Longitude"])
        direct_str = ", ".join(
            labels.get((sn, d), f"{sn} (dir {d})") for sn, d in sorted(info["direct_variants"])
        )
        shuttle_str = "; ".join(
            f"{h['shuttle_name']} via {labels.get((h['service_no'], h['direction']), h['service_no'])}"
            for h in info["shuttle_hits"]
        )
        folium.Marker(
            [lat, lon],
            tooltip=f"⭐ Priority: {stop['Description']}",
            popup=(
                f"<b>{stop['Description']}</b> ({code})<br>"
                f"Direct routes: {direct_str}<br>"
                f"One-stop to: {shuttle_str}"
            ),
            icon=folium.Icon(color="red", icon="star", prefix="fa"),
        ).add_to(fg_priority)
    fg_priority.add_to(m)

    folium.LayerControl(collapsed=False).add_to(m)

    out_path = config.OUTPUT_DIR / "map.html"
    m.save(str(out_path))
    print(f"Wrote interactive map to {out_path}", file=sys.stderr)
    return out_path
