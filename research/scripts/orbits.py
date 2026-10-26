"""
CelesTrak GP (OMM JSON) -> public/orbits/catalog.bin + catalog.json for the Earth orbit layer.

Groups (fetch with research/scripts/fetch_orbits.sh, at most once per 2 h per CelesTrak's rules):
  active, stations, fengyun-1c-debris, iridium-33-debris, cosmos-2251-debris, cosmos-1408-debris

Per object, 12 float32 (propagated on the GPU: Kepler + J2 secular drift of node and perigee):
  a [Earth radii], e, i, raan0, argp0, M0 [rad], n [rad/min], raanDot, argpDot [rad/min],
  t0 [min from catalog epoch], kind, year (launch year, or the breakup year for debris)

  python3 -I research/scripts/orbits.py research/raw/celestrak public/orbits
"""
import datetime as dt
import json
import math
import os
import struct
import sys

MU = 398600.4418          # km^3/s^2
RE = 6371.0               # km: the globe's unit radius (mean Earth radius)
RE_J2 = 6378.137          # km: equatorial radius the J2 constant is defined against
J2 = 1.08262668e-3

KIND = {"starlink": 0, "oneweb": 1, "leo": 2, "meo": 3, "geo": 4, "debris": 5, "station": 6, "heo": 7}
DEBRIS = {  # cloud -> breakup year (NASA Orbital Debris Quarterly News)
    "fengyun-1c-debris": 2007, "iridium-33-debris": 2009, "cosmos-2251-debris": 2009, "cosmos-1408-debris": 2021,
}
STATIONS = {25544: "ISS", 48274: "Tiangong"}


def epoch(s):
    return dt.datetime.fromisoformat(s.replace("Z", "")).replace(tzinfo=dt.timezone.utc)


def classify(o, period_min):
    name = o["OBJECT_NAME"]
    if o["NORAD_CAT_ID"] in STATIONS: return "station"
    if name.startswith("STARLINK"): return "starlink"
    if name.startswith("ONEWEB"): return "oneweb"
    if 1400 < period_min < 1480 and o["ECCENTRICITY"] < 0.05: return "geo"
    if 600 < period_min < 900 and o["ECCENTRICITY"] < 0.05: return "meo"     # GPS, Galileo, GLONASS, BeiDou MEO
    if o["ECCENTRICITY"] >= 0.25: return "heo"                              # Molniya, GTO
    return "leo"


def main(src, out):
    objs = {}
    for g in ["active", "stations", *DEBRIS]:
        p = os.path.join(src, g + ".json")
        if not os.path.exists(p):
            print("missing", p); continue
        for o in json.load(open(p)):
            if g == "stations" and o["NORAD_CAT_ID"] not in STATIONS:
                continue                      # visiting vehicles are drawn with the station model
            o["_group"] = g
            objs.setdefault(o["NORAD_CAT_ID"], o)
    # median epoch: a handful of objects carry predicted (future-dated) element sets
    eps = sorted(epoch(o["EPOCH"]) for o in objs.values())
    ref = eps[len(eps) // 2]
    ref = ref.replace(minute=0, second=0, microsecond=0)
    rows, counts, named = [], {}, {}
    for nid, o in objs.items():
        n_rev_day = o["MEAN_MOTION"]
        if n_rev_day <= 0:
            continue
        n = n_rev_day * 2 * math.pi / 1440.0                      # rad/min
        a_km = (MU / (n / 60.0) ** 2) ** (1 / 3)
        if a_km < RE + 120:                                       # already re-entering
            continue
        e = o["ECCENTRICITY"]; i = math.radians(o["INCLINATION"])
        p = a_km * (1 - e * e)
        k = 1.5 * J2 * (RE_J2 / p) ** 2 * n
        raan_dot = -k * math.cos(i)
        argp_dot = k * (2 - 2.5 * math.sin(i) ** 2)
        g = o["_group"]
        kind = "debris" if g in DEBRIS else classify(o, 2 * math.pi / n)
        try:
            launch = int(o["OBJECT_ID"][:4])
        except (ValueError, TypeError):
            launch = 1957
        year = DEBRIS.get(g, launch)
        t0 = (epoch(o["EPOCH"]) - ref).total_seconds() / 60.0
        rows.append((a_km / RE, e, i, math.radians(o["RA_OF_ASC_NODE"]), math.radians(o["ARG_OF_PERICENTER"]),
                     math.radians(o["MEAN_ANOMALY"]), n, raan_dot, argp_dot, t0, KIND[kind], year))
        counts[kind] = counts.get(kind, 0) + 1
        if nid in STATIONS:
            named[STATIONS[nid]] = len(rows) - 1
    # stations last so they draw over the swarm
    order = sorted(range(len(rows)), key=lambda r: rows[r][10] == KIND["station"])
    rows = [rows[r] for r in order]
    named = {k: order.index(v) for k, v in named.items()}
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "catalog.bin"), "wb") as f:
        for r in rows:
            f.write(struct.pack("<12f", *r))
    meta = {
        "epoch": ref.isoformat().replace("+00:00", "Z"), "count": len(rows), "stride": 12,
        "kinds": KIND, "counts": counts, "named": named,
        "source": "CelesTrak GP data (celestrak.org), active satellites, space stations and the Fengyun-1C, "
                  "Iridium 33, Cosmos 2251 and Cosmos 1408 debris clouds",
    }
    json.dump(meta, open(os.path.join(out, "catalog.json"), "w"), indent=1)
    print(json.dumps({k: meta[k] for k in ("epoch", "count", "counts", "named")}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
