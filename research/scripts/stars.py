import csv, json, math, struct, sys
src, out_bin, out_meta = sys.argv[1:4]
# typical B-V by spectral class letter, used only when HYG ci is blank
SPEC_BV = {'O': -0.32, 'B': -0.16, 'A': 0.15, 'F': 0.44, 'G': 0.68, 'K': 1.15, 'M': 1.6,
           'W': -0.3, 'C': 2.0, 'R': 1.7, 'N': 2.5, 'S': 1.8, 'D': 0.0}
rows = []; filled = 0
with open(src, newline='') as f:
    for r in csv.DictReader(f):
        if r['id'] == '0':
            continue  # Sol
        mag = float(r['mag'])
        if mag > 7.0:
            continue
        ra = float(r['rarad']); dec = float(r['decrad'])
        x = math.cos(dec) * math.cos(ra); y = math.cos(dec) * math.sin(ra); z = math.sin(dec)
        if r['ci'].strip():
            ci = float(r['ci'])
        else:
            s = r['spect'].strip().lstrip('sdgk').upper()[:1]
            ci = SPEC_BV.get(s, 0.65); filled += 1
        rows.append((mag, x, y, z, ci, r))
rows.sort(key=lambda t: t[0])
with open(out_bin, 'wb') as f:
    for mag, x, y, z, ci, _ in rows:
        f.write(struct.pack('<5f', x, y, z, mag, ci))
mags = [t[0] for t in rows]; cis = [t[4] for t in rows]
meta = {
  "count": len(rows),
  "source": "HYG Database v4.1 (astronexus/HYG-Database, hyg/CURRENT/hygdata_v41.csv), CC BY-SA 4.0",
  "selection": "all stars with apparent V magnitude <= 7.0, excluding Sol (HYG id 0)",
  "sort": "ascending magnitude (brightest first)",
  "encoding": "little-endian Float32, 5 values per star, 20 bytes per star, no header",
  "stride": 5, "bytesPerStar": 20,
  "fields": [
    {"name": "x", "offset": 0, "desc": "unit vector toward star, J2000 equatorial (ICRS-aligned): cos(dec)*cos(ra)"},
    {"name": "y", "offset": 1, "desc": "cos(dec)*sin(ra) (+y toward RA 6h, dec 0)"},
    {"name": "z", "offset": 2, "desc": "sin(dec) (+z toward north celestial pole)"},
    {"name": "mag", "offset": 3, "desc": "apparent visual magnitude (HYG 'mag')"},
    {"name": "ci", "offset": 4, "desc": "B-V color index (HYG 'ci'); %d stars with blank ci were filled from spectral class (O -0.32, B -0.16, A 0.15, F 0.44, G 0.68, K 1.15, M 1.6, else 0.65)" % filled}
  ],
  "frame_note": "Positions are HYG rarad/decrad at epoch and equinox J2000 (no proper motion applied). Three.js is y-up: to place +z(north pole) up, map (x,y,z) -> (x, z, -y) or rotate the star group by -90deg about X.",
  "ciFilled": filled,
  "magRange": [min(mags), max(mags)],
  "ciRange": [min(cis), max(cis)]
}
json.dump(meta, open(out_meta, 'w'), indent=2)
print(json.dumps({k: meta[k] for k in ('count','ciFilled','magRange','ciRange')}))
for t in rows[:5]: print(t[5]['proper'], t[0], round(t[4],3))
