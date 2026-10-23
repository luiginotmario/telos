import json, os, sys
W, OUT = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(W, 'texmeta_all.json')))
m['earth'] = json.load(open(os.path.join(W, 'texmeta_earth.json')))['earth']
sky = m.pop('_sky')
SRC = {
 ('sun','color'): 'Solar System Scope 8k_sun (artwork based on SDO imagery), CC BY 4.0',
 ('mercury','color'): 'Solar System Scope 8k_mercury (based on NASA MESSENGER mosaics), CC BY 4.0',
 ('venus','color'): 'Solar System Scope 8k_venus_surface (based on NASA Magellan radar; colours are artistic, not true colour), CC BY 4.0',
 ('venus','atmosphere'): 'Solar System Scope 4k_venus_atmosphere (artistic cloud-top map), CC BY 4.0',
 ('earth','color'): 'NASA Blue Marble: Next Generation, June 2004 (world.200406.3x5400x2700)',
 ('earth','night'): 'NASA Black Marble 2016 (BlackMarble_2016_3km), moonlit-land base removed (lights only)',
 ('earth','clouds'): 'NASA Blue Marble cloud_combined_8192 (greyscale)',
 ('earth','specular'): 'Solar System Scope 8k_earth_specular_map (white = water), CC BY 4.0',
 ('earth','normal'): 'Solar System Scope 8k_earth_normal_map (tangent space), CC BY 4.0',
 ('earth','elevation'): 'NASA Blue Marble GEBCO_08 topography (0..6400 m) + bathymetry (-8000..0 m), merged',
 ('moon','color'): 'NASA SVS CGI Moon Kit (4720), LROC WAC colour, 2025 version (lroc_color_16bit_srgb_4k)',
 ('moon','elevation'): 'NASA SVS CGI Moon Kit (4720), LOLA ldem_16_uint (16 px/deg); metres relative to 1737.4 km sphere',
 ('moon','normal'): 'derived from the LOLA elevation map in this repo',
 ('mars','color'): 'Solar System Scope 8k_mars (based on NASA Viking/MGS imagery; colour enhanced), CC BY 4.0',
 ('mars','elevation'): 'NASA PDS MGS MOLA MEGDR megt90n000eb (16 px/deg); metres relative to the MOLA areoid',
 ('mars','normal'): 'derived from the MOLA elevation map in this repo',
 ('jupiter','color'): 'Solar System Scope 8k_jupiter (based on NASA Cassini imagery), CC BY 4.0',
 ('saturn','color'): 'Solar System Scope 8k_saturn (based on NASA Cassini imagery), CC BY 4.0',
 ('saturn','ring'): 'Solar System Scope 8k_saturn_ring_alpha (RGBA strip), CC BY 4.0',
 ('uranus','color'): 'Solar System Scope 2k_uranus (based on Voyager 2 imagery), CC BY 4.0',
 ('neptune','color'): 'Solar System Scope 2k_neptune (based on Voyager 2 imagery), CC BY 4.0',
}
for b, maps in m.items():
    for k, v in maps.items():
        v['source'] = SRC[(b, k)]
m['saturn']['ring']['layout'] = ('u (x) runs radially: u=0 inner edge, u=1 outer edge; v (y) is uniform. Not 2:1. '
    'Fitted against ring features (B-ring outer edge, Encke gap, A-ring outer edge): u=0 ~ 72,200 km (1.20 Rs), '
    'u=1 ~ 140,500 km (2.33 Rs), Rs = 60,268 km. Approximate (+/-1%).')
m['uranus']['color']['note'] = m['neptune']['color']['note'] = 'Only a 2k source exists; no 4k tier (fall back to 2k).'
manifest = {
 'version': 1,
 'convention': ('Equirectangular 2:1. Left edge = 180 deg W (-180), centre = 0 deg longitude (prime meridian), '
                'top = +90 deg (north). East longitude increases to the right. With three.js SphereGeometry default UVs '
                '(+Y = north pole), u=0.5 (lon 0) lies on +X and u=0.75 (90E) on -Z, so east = positive rotation about +Y '
                '(prograde). Apply the body\'s own prime-meridian angle W(t) as a rotation about +Y.'),
 'tiers': {'2k': [2048, 1024], '4k': [4096, 2048]},
 'bodies': m,
 'sky': {'milkyway': dict(sky['milkyway'], source='NASA SVS Deep Star Maps 2020 (4851), milkyway_2020_4k.exr (celestial, Milky Way without Hipparcos/Tycho bright stars), linear -> sRGB, no tone curve',
          frame=('Celestial (equatorial, ICRF/J2000), plate carree. Image centre = RA 0h, dec 0; RA increases to the LEFT '
                 '(sky seen from inside); top = +90 dec. Pixel x -> RA = (0.5 - x/W) * 360 deg mod 360; y -> dec = 90 - y/H*180. '
                 'Verified: LMC lands at RA~80 deg, dec~-69.'))},
 'other': {'earth/paleo-atlas.png, earth/paleo-atlas.json': 'present in the folder but not produced by this sourcing pass'},
}
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print('ok')
