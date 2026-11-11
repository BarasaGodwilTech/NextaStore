"""
Proves the offline QR generator (js/growth-qr.js) produces codes a scanner can read.
    python3 growth-program/backend/scripts/growth-qr-test.py
Needs: node, python3, numpy, opencv-python (pip install opencv-python numpy).
It asks Node for the QR matrices, draws them as images and decodes them with OpenCV (both of its
detectors, several scales, because OpenCV's classic detector is scale-sensitive on dense codes).
"""
import json, os, subprocess, sys
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
QR_JS = os.path.join(HERE, '..', '..', 'js', 'growth-qr.js')
SAMPLES = [
    'https://nextastores.com/signup?ref=CREW-4HTR9',
    'https://nextastores.com/signup?ref=CIRCLE-K7M3Q',
    'A',
    'https://nextastores.com/invite?ref=CREW-4HTR9&utm_source=qr&utm_campaign=kampala-market-week',
    'https://nextastores.com/invite?ref=CREW-4HTR9&utm_source=qr&utm_campaign=kampala-market-week&note=' + 'x' * 70,
    'https://nextastores.com/invite?ref=CREW-4HTR9&utm_source=qr&utm_campaign=kampala-market-week&note=' + 'abcdefghij' * 10,
    'Nexta Duuka \u2014 Kampala \u2713 ' + '\u00e9' * 8,
    'https://nextastores.com/invite?ref=CREW-4HTR9&' + 'q=1234567890&' * 11,
]
js = "const Q=require(%s);const s=JSON.parse(process.argv[1]);console.log(JSON.stringify(s.map(t=>{const q=Q.encode(t);return{text:t,version:q.version,modules:q.modules.map(r=>r.map(m=>m?1:0))}})))" % json.dumps(os.path.abspath(QR_JS))
out = subprocess.run(['node', '-e', js, json.dumps(SAMPLES)], capture_output=True, text=True)
if out.returncode: print(out.stderr); sys.exit(1)
data = json.loads(out.stdout)
detectors = [cv2.QRCodeDetectorAruco(), cv2.QRCodeDetector()]
failed = 0
for d in data:
    m = np.array(d['modules'], dtype=np.uint8)
    decoded = False
    for det in detectors:
        for scale in (8, 4, 6, 10, 12):
            img = np.kron(1 - np.pad(m, 4, constant_values=0), np.ones((scale, scale), dtype=np.uint8)) * 255
            val, _, _ = det.detectAndDecode(img)
            if val == d['text']: decoded = True; break
        if decoded: break
    print(('ok   ' if decoded else 'FAIL '), 'version', d['version'], '%d bytes' % len(d['text'].encode('utf-8')))
    failed += 0 if decoded else 1
# the generator must refuse, not corrupt, text that is too long (limit 213 bytes at version 10)
def encodes(n):
    r = subprocess.run(['node', '-e', "const Q=require(%s);try{Q.encode('x'.repeat(%d));console.log('yes')}catch(e){console.log('no')}" % (json.dumps(os.path.abspath(QR_JS)), n)], capture_output=True, text=True)
    return r.stdout.strip() == 'yes'
limit_ok = encodes(213) and not encodes(214)
print(('ok   ' if limit_ok else 'FAIL ') + 'accepts 213 bytes, refuses 214')
failed += 0 if limit_ok else 1
print('%d/%d QR codes decoded exactly' % (len(data) - (failed - (0 if limit_ok else 1)), len(data)))
sys.exit(1 if failed else 0)
