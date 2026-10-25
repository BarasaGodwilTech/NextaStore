#!/usr/bin/env python3
"""Render assets/landing/nextastore-tour.mp4 (+ .webm and tour-poster.jpg) from reel.html, frame by frame.

  python3 assets/landing/reel-src/render.py            # run from the project root
Needs: playwright (python) with chromium, and ffmpeg on PATH. Font Awesome is loaded from the CDN link in
reel.html, so run it with internet access (or route that URL to a local copy).
Every animation in reel.html is a CSS animation, so the script pauses them all and sets the same
currentTime on each one for every frame. That makes the render deterministic (no dropped frames).
"""
import os, subprocess, sys, shutil, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(HERE)
FPS, DURATION, POSTER_AT = 30, 26.0, 8.4
frames = tempfile.mkdtemp(prefix='reel-')
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    hook = os.environ.get('REEL_ROUTE_HOOK')   # optional: a .py file with attach(page), e.g. to serve Font Awesome offline
    if hook:
        import importlib.util
        spec = importlib.util.spec_from_file_location('hook', hook); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.attach(pg)
    pg.goto('file://' + os.path.join(HERE, 'reel.html'), wait_until='load')
    pg.evaluate('document.fonts.ready')
    pg.wait_for_timeout(600)
    def seek(t):
        pg.evaluate('t => document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000; })', t)
    n = int(DURATION * FPS)
    for i in range(n):
        seek(i / FPS)
        pg.screenshot(path=os.path.join(frames, f'f_{i:04d}.jpg'), type='jpeg', quality=94)
    seek(POSTER_AT)
    pg.screenshot(path=os.path.join(OUT, 'tour-poster.jpg'), type='jpeg', quality=86)
    b.close()
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(frames, 'f_%04d.jpg'),
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
                os.path.join(OUT, 'nextastore-tour.mp4')], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(frames, 'f_%04d.jpg'),
                '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-an',
                os.path.join(OUT, 'nextastore-tour.webm')], check=True)
shutil.rmtree(frames, ignore_errors=True)
print('wrote', os.path.join(OUT, 'nextastore-tour.mp4'))
