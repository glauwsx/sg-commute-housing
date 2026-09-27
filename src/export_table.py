"""Build the candidate-area table (grouped by HDB town/street) as CSV + Markdown."""

import csv
import sys
from collections import defaultdict

import config
from src.analyze import town_for_road_name


def _variant_label(key, labels):
    service_no, direction = key
    return labels.get(key, f"{service_no} (dir {direction})")


def build_area_rows(result):
    """Aggregate per-stop findings into per-(town, road) rows."""
    stop_index = result["stop_index"]
    labels = result["route_labels"]
    direct_stop_to_variants = result["direct_stop_to_variants"]
    shuttle_results = result["shuttle_results"]

    # stop_code -> {"direct": set of variant labels, "shuttle": set of (shuttle_name, variant_label) }
    per_stop = defaultdict(lambda: {"direct": set(), "shuttle": set()})

    for code, variants in direct_stop_to_variants.items():
        for v in variants:
            per_stop[code]["direct"].add(_variant_label(v, labels))

    for shuttle_name, res in shuttle_results.items():
        for hit in res["one_stop"]:
            code = hit["from_stop_code"]
            label = labels.get((hit["service_no"], hit["direction"]),
                               f"{hit['service_no']} (dir {hit['direction']})")
            per_stop[code]["shuttle"].add((shuttle_name, label))

    # Group into town/road rows
    rows = defaultdict(
        lambda: {
            "direct_routes": set(),
            "shuttle_hits": set(),
            "sample_stops": set(),
            "priority": False,
        }
    )

    for code, info in per_stop.items():
        stop = stop_index.get(code)
        if not stop:
            continue
        town = town_for_road_name(stop.get("RoadName", ""))
        key = (town, stop.get("RoadName", ""))
        row = rows[key]
        row["direct_routes"] |= info["direct"]
        row["shuttle_hits"] |= info["shuttle"]
        row["sample_stops"].add(f"{stop['Description']} ({code})")
        if info["direct"] and info["shuttle"]:
            row["priority"] = True

    return rows


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "Priority",
                "Town",
                "Road",
                "Direct Routes to Company",
                "One-Stop-To-Shuttle (point / route)",
                "Sample Bus Stops",
            ]
        )
        for (town, road), row in sorted(
            rows.items(), key=lambda kv: (not kv[1]["priority"], kv[0][0], kv[0][1])
        ):
            shuttle_str = "; ".join(sorted(f"{name} via {route}" for name, route in row["shuttle_hits"]))
            writer.writerow(
                [
                    "YES" if row["priority"] else "",
                    town,
                    road,
                    ", ".join(sorted(row["direct_routes"])) or "-",
                    shuttle_str or "-",
                    "; ".join(sorted(row["sample_stops"]))[:300],
                ]
            )
    print(f"Wrote table CSV to {path}", file=sys.stderr)


def write_markdown(rows, path):
    lines = [
        "| Priority | Town | Road | Direct Routes to Company | One-Stop-To-Shuttle | Sample Bus Stops |",
        "|---|---|---|---|---|---|",
    ]
    for (town, road), row in sorted(rows.items(), key=lambda kv: (not kv[1]["priority"], kv[0][0], kv[0][1])):
        shuttle_str = "; ".join(sorted(f"{name} via {route}" for name, route in row["shuttle_hits"])) or "-"
        direct_str = ", ".join(sorted(row["direct_routes"])) or "-"
        stops_str = "; ".join(sorted(row["sample_stops"]))
        priority_mark = "⭐" if row["priority"] else ""
        lines.append(f"| {priority_mark} | {town} | {road} | {direct_str} | {shuttle_str} | {stops_str} |")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote table Markdown to {path}", file=sys.stderr)


def export(result):
    rows = build_area_rows(result)
    write_csv(rows, config.OUTPUT_DIR / "candidates.csv")
    write_markdown(rows, config.OUTPUT_DIR / "candidates.md")
    return rows
