"""Thin client for the LTA DataMall static datasets we need, with pagination,
on-disk JSON caching and optional progress callbacks (used by the web app to
show a live download bar).
"""

import json
import sys
import time

import requests

import config

PAGE_SIZE = 500  # LTA DataMall returns at most 500 records per call

DATASETS = {
    "bus_stops": "BusStops",
    "bus_routes": "BusRoutes",
    "bus_services": "BusServices",
}


class LtaAuthError(RuntimeError):
    pass


def _headers(account_key=None):
    key = account_key or config.LTA_ACCOUNT_KEY
    if not key:
        raise LtaAuthError(
            "LTA_ACCOUNT_KEY is not set. Enter your key in the app, or copy "
            ".env.example to .env and fill it in. Free key: https://datamall.lta.gov.sg/"
        )
    return {"AccountKey": key, "accept": "application/json"}


def validate_key(account_key, lang=None):
    """Return (ok: bool, message: str) by making one cheap authenticated call.
    `lang` "en" words the message in English (the page's language)."""
    t = (lambda zh, en: en) if lang == "en" else (lambda zh, en: zh)
    try:
        resp = requests.get(
            f"{config.LTA_BASE_URL}/BusStops",
            headers={"AccountKey": account_key, "accept": "application/json"},
            params={"$skip": 0},
            timeout=20,
        )
    except requests.RequestException as e:
        return False, t(f"連線失敗：{e}", f"Could not connect: {e}")
    if resp.status_code == 401:
        return False, t("API key 無效（LTA 回應 401 Unauthorized）。請確認你貼上的是 DataMall 的 API Access Key。",
                        "Invalid API key (LTA replied 401 Unauthorized). Check that you pasted the DataMall API Access Key.")
    if resp.status_code == 404:
        return False, t("端點不存在（404）。請確認 config.LTA_BASE_URL 使用 https://",
                        "Endpoint not found (404). Check that config.LTA_BASE_URL uses https://")
    if resp.status_code != 200:
        return False, f"LTA HTTP {resp.status_code}: {resp.text[:200]}"
    n = len(resp.json().get("value", []))
    return True, t(f"API key 有效，測試取得 {n} 筆站牌資料。", f"API key works: test call returned {n} bus stops.")


def _fetch_all(endpoint, account_key=None, progress_cb=None, max_pages=200, sleep_s=0.15):
    """Page through an LTA DataMall endpoint via $skip until an empty page."""
    records = []
    skip = 0
    for _page in range(max_pages):
        resp = requests.get(
            f"{config.LTA_BASE_URL}/{endpoint}",
            headers=_headers(account_key),
            params={"$skip": skip},
            timeout=30,
        )
        if resp.status_code == 401:
            raise LtaAuthError(f"LTA DataMall rejected the API key (401) while calling {endpoint}.")
        resp.raise_for_status()
        batch = resp.json().get("value", [])
        if not batch:
            break
        records.extend(batch)
        if progress_cb:
            progress_cb(endpoint, len(records))
        else:
            print(f"  {endpoint}: fetched {len(records)} records so far...", file=sys.stderr)
        if len(batch) < PAGE_SIZE:
            break
        skip += PAGE_SIZE
        time.sleep(sleep_s)
    return records


def cache_path(name):
    return config.DATA_RAW_DIR / f"{name}.json"


def has_cached_data():
    return all(cache_path(n).exists() for n in DATASETS)


def cached_counts():
    counts = {}
    for name in DATASETS:
        p = cache_path(name)
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    counts[name] = len(json.load(f))
            except (json.JSONDecodeError, OSError):
                counts[name] = 0
        else:
            counts[name] = 0
    return counts


def get_dataset(name, endpoint=None, force_refresh=False, account_key=None, progress_cb=None):
    """Fetch (or load cached) LTA dataset, returning a list of dict records."""
    endpoint = endpoint or DATASETS[name]
    path = cache_path(name)
    if path.exists() and not force_refresh:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    records = _fetch_all(endpoint, account_key=account_key, progress_cb=progress_cb)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    return records


def get_bus_stops(force_refresh=False, **kw):
    return get_dataset("bus_stops", force_refresh=force_refresh, **kw)


def get_bus_routes(force_refresh=False, **kw):
    return get_dataset("bus_routes", force_refresh=force_refresh, **kw)


def get_bus_services(force_refresh=False, **kw):
    return get_dataset("bus_services", force_refresh=force_refresh, **kw)
