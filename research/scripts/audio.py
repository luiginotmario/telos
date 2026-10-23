import json, os, subprocess, sys
import numpy as np
RAW, OUT, WORK = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
SR = 48000; X = 2.0
JOBS = {  # body: (source, start_s, loop_len_s)
 'sun':     ('one_mode_1_1_2_30s.au', 0.0, 28.0),
 'mercury': ('orig-2110_013_AR_EN.mp4', 0.0, 26.0),
 'venus':   ('13847_Parker_Venus.mp4', 6.0, 27.0),
 'earth':   ('693857main_emfisis_chorus_1.mp3', 0.0, 27.5),
 'moon':    ('afj/a10o-1021815.mp3', 137.0, 26.0),
 'mars':    ('45827_SCAM_MIC_SOL004_RUN001.wav', 0.0, 37.5),
 'jupiter': ('PIA25030.mov', 2.0, 40.0),
 'saturn':  ('cas-enceladus-tulip-black-17-245-1214-1230.mp4', 0.0, 26.0),
 'uranus':  ('voyager/C2684754_AUDIO.MP3', 1.0, 38.0),
 'neptune': ('voyager/C1139041_AUDIO.MP3', 1.0, 37.0),
}
only = set(sys.argv[4:]); meta = {}
for body, (src, start, L) in JOBS.items():
    if only and body not in only: continue
    p = os.path.join(RAW, src)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(L + X), '-i', p, '-vn', '-ac', '1',
                          '-ar', str(SR), '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    s = np.frombuffer(raw, np.float32).astype(np.float64)
    n, x = int(L * SR), int(X * SR)
    assert len(s) >= n + x - 10, (body, len(s) / SR)
    s = np.pad(s, (0, max(0, n + x - len(s))))
    s -= s.mean()
    t = np.linspace(0, np.pi / 2, x)
    out = s[:n].copy()
    out[:x] = s[:x] * np.sin(t) + s[n:n + x] * np.cos(t)   # equal-power crossfade: loop end -> start is continuous
    rms = np.sqrt(np.mean(out ** 2)); g = 10 ** (-20 / 20) / max(rms, 1e-9)
    g = min(g, 10 ** (-1 / 20) / max(np.abs(out).max(), 1e-9))
    out *= g
    wav = os.path.join(WORK, f'{body}.f32')
    out.astype(np.float32).tofile(wav)
    base = ['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', wav, '-map_metadata', '-1']
    subprocess.run(base + ['-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', os.path.join(OUT, f'{body}.m4a')], check=True)
    subprocess.run(base + ['-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', os.path.join(OUT, f'{body}.ogg')], check=True)
    meta[body] = {'source': src, 'start_s': start, 'loop_s': L, 'crossfade_s': X, 'gain_db': round(20 * np.log10(g), 1),
                  'm4a_bytes': os.path.getsize(os.path.join(OUT, f'{body}.m4a')), 'ogg_bytes': os.path.getsize(os.path.join(OUT, f'{body}.ogg'))}
json.dump(meta, open(os.path.join(WORK, 'audiometa.json'), 'w'), indent=1)
print(json.dumps(meta, indent=1))
