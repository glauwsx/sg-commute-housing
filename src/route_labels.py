"""Human-readable names for bus route variants.

LTA identifies a variant by (ServiceNo, Direction) where Direction is literally
1 or 2. Putting that on screen -- "15 (往1)" -- tells a reader nothing: it is an
internal key, not a direction anyone can act on.

BusServices carries OriginCode/DestinationCode per variant, so a variant can be
named after where it actually ends up. Loop services need separate handling:
227 of the 806 services come back to the stop they started from, so their
destination is uninformative and `LoopDesc` (the far end of the circuit) is what
distinguishes them.
"""


def build_route_labels(services, stop_desc):
    """Map (ServiceNo, Direction) -> label, e.g. "3 往 Punggol Int"."""
    labels = {}
    for s in services:
        try:
            key = (s["ServiceNo"], int(s["Direction"]))
        except (KeyError, TypeError, ValueError):
            continue
        origin, dest = s.get("OriginCode"), s.get("DestinationCode")
        loop = (s.get("LoopDesc") or "").strip()
        if origin and origin == dest:
            labels[key] = f"{s['ServiceNo']} 循環" + (f"（經 {loop}）" if loop else "")
        else:
            where = stop_desc.get(dest)
            labels[key] = f"{s['ServiceNo']} 往 {where}" if where else str(s["ServiceNo"])
    return labels


def label_for(labels, service_no, direction, stop_sequence, stop_desc):
    """Label one variant, falling back to its own last stop when BusServices has
    no row for it -- short-working variants (39B, 15A, ...) are not all listed."""
    try:
        hit = labels.get((service_no, int(direction)))
    except (TypeError, ValueError):
        hit = None
    if hit:
        return hit
    last = stop_desc.get(stop_sequence[-1]) if stop_sequence else None
    return f"{service_no} 往 {last}" if last else str(service_no)
