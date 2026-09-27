#!/usr/bin/env python3
"""Entry point: fetch LTA bus data (cached), run the commute analysis, and
produce the interactive map + candidate-area table.

Usage:
    python main.py               # use cached data if present
    python main.py --refresh     # force re-fetch from LTA DataMall
"""

import argparse
import sys

from dotenv import load_dotenv

load_dotenv()

import config  # noqa: E402  (must come after load_dotenv so LTA_ACCOUNT_KEY is picked up)
from src import lta_client
from src.analyze import run_analysis
from src.build_map import build_map
from src.export_table import export
from src.export_webapp import export as export_webapp


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="force re-fetch data from LTA DataMall")
    args = parser.parse_args()

    try:
        bus_stops = lta_client.get_bus_stops(force_refresh=args.refresh)
        bus_routes = lta_client.get_bus_routes(force_refresh=args.refresh)
        bus_services = lta_client.get_bus_services(force_refresh=args.refresh)
    except lta_client.LtaAuthError as e:
        print(f"\nERROR: {e}\n", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(bus_stops)} bus stops, {len(bus_routes)} route-stop records, "
          f"{len(bus_services)} bus services.", file=sys.stderr)

    result = run_analysis(bus_stops, bus_routes, bus_services)
    export(result)
    map_path = build_map(result)
    explorer_path = export_webapp(result)

    print("\nDone.")
    print(f"  Interactive explorer: {explorer_path}   <-- 建議從這個開始")
    print(f"  Static map:           {map_path}")
    print(f"  Table:                {config.OUTPUT_DIR / 'candidates.csv'} / candidates.md")


if __name__ == "__main__":
    main()
