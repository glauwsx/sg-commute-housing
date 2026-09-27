# Vendored Leaflet 1.9.4

Copied from https://unpkg.com/leaflet@1.9.4/dist/ on 2026-08-24.

Vendored rather than loaded from a CDN so that both ways of running the app
work without reaching unpkg:

- `python app.py` serves these from `/static/vendor/`
- `src/export_webapp.py` inlines the JS/CSS and embeds `images/` as data URIs,
  so `output/explorer.html` is genuinely one self-contained file

Map *tiles* still come from the network (OneMap) -- only the library is local.

To upgrade, replace all five files from the same version directory and bump the
version in this note; nothing else references the version number.
