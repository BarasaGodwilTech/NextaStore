/**
 * NextaQR: a small, dependency-free QR code generator (byte mode, error correction M, versions 1 to 10,
 * so up to 213 bytes: plenty for an invite link). It exists so a Crew member's QR code works with NO
 * internet and no CDN, which matters in a market with weak data.
 *
 *   NextaQR.encode('https://...')               -> { size, modules: boolean[][] }
 *   NextaQR.svg('https://...', { scale: 6 })    -> '<svg ...>' string
 *   NextaQR.draw(canvas, 'https://...', { scale: 6, margin: 4 })
 *   NextaQR.render(containerEl, 'https://...')  -> appends a canvas
 *
 * The algorithm follows the public QR Code Model 2 spec (the structure is the well-known one used by
 * Project Nayuki's MIT-licensed reference generator). scripts/growth-qr-test.py decodes its output
 * with OpenCV to prove it scans.
 */
(function (root) {
    'use strict';

    const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    const NUM_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
    const MAX_VERSION = 10;
    const FORMAT_BITS_M = 0; // error correction level M

    const getBit = (x, i) => ((x >>> i) & 1) !== 0;

    function rawDataModules(ver) {
        let result = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            const numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7) result -= 36;
        }
        return result;
    }
    const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver];

    // ---- Reed-Solomon over GF(2^8), polynomial 0x11D
    function gfMul(x, y) {
        let z = 0;
        for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
        return z;
    }
    function rsDivisor(degree) {
        const result = new Array(degree).fill(0);
        result[degree - 1] = 1;
        let r = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < result.length; j++) { result[j] = gfMul(result[j], r); if (j + 1 < result.length) result[j] ^= result[j + 1]; }
            r = gfMul(r, 0x02);
        }
        return result;
    }
    function rsRemainder(data, divisor) {
        const result = divisor.map(() => 0);
        for (const b of data) {
            const factor = b ^ result.shift();
            result.push(0);
            divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
        }
        return result;
    }

    function utf8Bytes(text) {
        if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
        const s = unescape(encodeURIComponent(text)); const out = [];
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        return out;
    }

    function buildCodewords(bytes, ver) {
        const bits = [];
        const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        put(0x4, 4);                              // byte mode
        put(bytes.length, ver >= 10 ? 16 : 8);    // character count
        bytes.forEach((b) => put(b, 8));
        const capacityBits = dataCodewords(ver) * 8;
        put(0, Math.min(4, capacityBits - bits.length)); // terminator
        put(0, (8 - (bits.length % 8)) % 8);             // byte align
        for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
        const data = new Array(bits.length / 8).fill(0);
        bits.forEach((b, i) => { data[i >>> 3] |= b << (7 - (i & 7)); });
        return data;
    }

    function addEccAndInterleave(data, ver) {
        const numBlocks = NUM_BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver];
        const rawCodewords = Math.floor(rawDataModules(ver) / 8);
        const numShort = numBlocks - (rawCodewords % numBlocks);
        const shortLen = Math.floor(rawCodewords / numBlocks);
        const blocks = []; const div = rsDivisor(eccLen);
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1)); k += dat.length;
            const ecc = rsRemainder(dat, div);
            if (i < numShort) dat.push(0);
            blocks.push(dat.concat(ecc));
        }
        const result = [];
        for (let i = 0; i < blocks[0].length; i++) blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]); });
        return result;
    }

    function alignmentPositions(ver) {
        if (ver === 1) return [];
        const n = Math.floor(ver / 7) + 2;
        const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
        const result = [6];
        for (let pos = ver * 4 + 10; result.length < n; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    function encode(text) {
        const bytes = utf8Bytes(String(text));
        let ver = 1;
        for (; ver <= MAX_VERSION; ver++) {
            const used = 4 + (ver >= 10 ? 16 : 8) + bytes.length * 8;
            if (used <= dataCodewords(ver) * 8) break;
        }
        if (ver > MAX_VERSION) throw new Error('NextaQR: text is too long for a QR code here.');
        const size = ver * 4 + 17;
        const modules = Array.from({ length: size }, () => new Array(size).fill(false));
        const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
        const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

        // function patterns
        for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
        const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4); } };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        const al = alignmentPositions(ver);
        for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
        const drawFormat = (mask) => {
            const data = (FORMAT_BITS_M << 3) | mask; let rem = data;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = ((data << 10) | rem) ^ 0x5412;
            for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
            setFn(8, 7, getBit(bits, 6)); setFn(8, 8, getBit(bits, 7)); setFn(7, 8, getBit(bits, 8));
            for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
            for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
            for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
            setFn(8, size - 8, true);
        };
        drawFormat(0);
        if (ver >= 7) {
            let rem = ver;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const bits = (ver << 12) | rem;
            for (let i = 0; i < 18; i++) { const bit = getBit(bits, i); const a = size - 11 + (i % 3); const b = Math.floor(i / 3); setFn(a, b, bit); setFn(b, a, bit); }
        }

        // data placement
        const codewords = addEccAndInterleave(buildCodewords(bytes, ver), ver);
        let bitIndex = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
                const x = right - j; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert;
                if (!isFn[y][x] && bitIndex < codewords.length * 8) { modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7)); bitIndex++; }
            }
        }

        // masking: try all 8 and keep the best
        const applyMask = (mask) => {
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                let invert;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
                }
                if (!isFn[y][x] && invert) modules[y][x] = !modules[y][x];
            }
        };
        const penalty = () => {
            let result = 0;
            const addHistory = (run, hist) => { if (hist[0] === 0) run += size; hist.pop(); hist.unshift(run); };
            const countPatterns = (h) => { const n = h[1]; const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n; return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0); };
            const terminate = (color, run, hist) => { if (color) { addHistory(run, hist); run = 0; } run += size; addHistory(run, hist); return countPatterns(hist); };
            for (let pass = 0; pass < 2; pass++) {
                for (let a = 0; a < size; a++) {
                    let color = false, run = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
                    for (let b = 0; b < size; b++) {
                        const m = pass === 0 ? modules[a][b] : modules[b][a];
                        if (m === color) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
                        else { addHistory(run, hist); if (!color) result += countPatterns(hist) * 40; color = m; run = 1; }
                    }
                    result += terminate(color, run, hist) * 40;
                }
            }
            for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = modules[y][x]; if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3; }
            let dark = 0; modules.forEach((row) => row.forEach((m) => { if (m) dark++; }));
            const total = size * size; result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
            return result;
        };
        let best = 0, bestScore = Infinity;
        for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const s = penalty(); if (s < bestScore) { bestScore = s; best = m; } applyMask(m); }
        applyMask(best); drawFormat(best);
        return { size, modules, version: ver, mask: best };
    }

    function svg(text, opts = {}) {
        const { scale = 6, margin = 4, dark = '#0b3b2b', light = '#ffffff' } = opts;
        const q = encode(text); const dim = (q.size + margin * 2) * scale;
        let path = '';
        for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) path += `M${(x + margin) * scale},${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="QR code"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
    }

    function draw(canvas, text, opts = {}) {
        const { scale = 6, margin = 4, dark = '#0b3b2b', light = '#ffffff' } = opts;
        const q = encode(text); const dim = (q.size + margin * 2) * scale;
        canvas.width = dim; canvas.height = dim;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = light; ctx.fillRect(0, 0, dim, dim); ctx.fillStyle = dark;
        for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
        return canvas;
    }

    function render(container, text, opts = {}) {
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'QR code with your invite link');
        canvas.style.maxWidth = '100%'; canvas.style.height = 'auto';
        draw(canvas, text, opts); container.innerHTML = ''; container.appendChild(canvas); return canvas;
    }

    const api = { encode, svg, draw, render };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.NextaQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
