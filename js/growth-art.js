/**
 * GrowthArt: original illustrations for NextaStore Circle and Crew, drawn as inline SVG so they cost no extra requests,
 * scale cleanly, and never need an image to be uploaded. Pure functions returning strings; no scripts, no external references.
 *
 *   hero('circle' | 'crew')        the big picture beside the headline on the About pages
 *   medal(index, { size, label })   a rank medal: 0 Trailhead, 1 Pathfinder, 2 Trailblazer, 3 Summit (any other number is clamped)
 *   ring(percent, { size, label })  a progress ring for the dashboards (percent 0..100)
 *
 * Every gradient id is unique per call, so two medals on one page never fight over the same <defs>.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.GrowthArt = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    let uid = 0;
    const nextId = (p) => `${p}${++uid}`;
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0));

    const MEDALS = [
        { name: 'Trailhead', a: '#E9B27A', b: '#9C5B26', rim: '#7A4519', ribbon: '#C4452F' },
        { name: 'Pathfinder', a: '#F1F4F7', b: '#8E99A3', rim: '#6B7680', ribbon: '#2F6FB5' },
        { name: 'Trailblazer', a: '#FFE08A', b: '#D49100', rim: '#9A6700', ribbon: '#0F7B53' },
        { name: 'Summit', a: '#9BF0CB', b: '#0B8F63', rim: '#075E42', ribbon: '#0B3B2B' }
    ];

    /** A medal. The shape grows with the rank: 0 plain disc, 1 one chevron, 2 two chevrons, 3 a star on a disc with a crown of rays. */
    function medal(index, { size = 96, label } = {}) {
        const i = clamp(Math.round(index), 0, MEDALS.length - 1), m = MEDALS[i], g = nextId('gm');
        const text = label || `${m.name} medal`;
        const chev = (y) => `<path d="M38 ${y + 12} L50 ${y} L62 ${y + 12}" fill="none" stroke="${m.rim}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
        const star = '<path d="M50 30 L55.2 42 L68 43.2 L58.4 51.6 L61.3 64 L50 57.4 L38.7 64 L41.6 51.6 L32 43.2 L44.8 42 Z" fill="#fff" stroke="' + m.rim + '" stroke-width="2" stroke-linejoin="round"/>';
        const rays = i === 3 ? Array.from({ length: 12 }, (_, k) => { const a = (k * 30) * Math.PI / 180; return `<line x1="${(50 + 40 * Math.sin(a)).toFixed(1)}" y1="${(46 - 40 * Math.cos(a)).toFixed(1)}" x2="${(50 + 45 * Math.sin(a)).toFixed(1)}" y2="${(46 - 45 * Math.cos(a)).toFixed(1)}" stroke="${m.b}" stroke-width="3" stroke-linecap="round"/>`; }).join('') : '';
        const face = i === 0 ? `<circle cx="50" cy="46" r="9" fill="${m.rim}" opacity=".85"/>` : i === 1 ? chev(42) : i === 2 ? chev(50) + chev(36) : star;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 112" width="${size}" height="${Math.round(size * 1.12)}" role="img" aria-label="${esc(text)}"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.a}"/><stop offset="1" stop-color="${m.b}"/></linearGradient></defs>
            <path d="M30 70 L22 108 L36 100 L44 110 L50 74 Z" fill="${m.ribbon}"/><path d="M70 70 L78 108 L64 100 L56 110 L50 74 Z" fill="${m.ribbon}" opacity=".85"/>${rays}
            <circle cx="50" cy="46" r="34" fill="${m.rim}"/><circle cx="50" cy="46" r="30" fill="url(#${g})"/><circle cx="50" cy="46" r="24" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>${face}</svg>`;
    }

    /** A progress ring. 0 to 100. */
    function ring(percent, { size = 84, label } = {}) {
        const p = clamp(percent, 0, 100), r = 34, c = 2 * Math.PI * r;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 84" width="${size}" height="${size}" role="img" aria-label="${esc(label || `${Math.round(p)} percent`)}"><circle cx="42" cy="42" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".15" stroke-width="9"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 42 42)"/><text x="42" y="47" text-anchor="middle" font-size="15" font-weight="800" fill="currentColor" font-family="system-ui, sans-serif">${Math.round(p)}%</text></svg>`;
    }

    /** The picture beside a headline. Decorative: the page already says everything in words. */
    function hero(program) {
        return program === 'crew' ? crewHero() : circleHero();
    }

    function circleHero() {
        const g = nextId('gc');
        const people = [[88, 120, '#12A06F'], [446, 96, '#0F7B53'], [64, 290, '#0B3B2B'], [462, 288, '#12A06F'], [256, 388, '#0F7B53']];
        const links = people.map(([x, y]) => `<path d="M260 230 Q${(260 + x) / 2 + (y > 230 ? 30 : -30)} ${(230 + y) / 2} ${x} ${y}" fill="none" stroke="#12A06F" stroke-opacity=".45" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>`).join('');
        const nodes = people.map(([x, y, c], k) => `<g><circle cx="${x}" cy="${y}" r="34" fill="#fff" stroke="${c}" stroke-width="4"/><circle cx="${x}" cy="${y - 7}" r="9" fill="${c}"/><path d="M${x - 15} ${y + 18} Q${x} ${y} ${x + 15} ${y + 18}" fill="${c}"/>${k % 2 ? `<circle cx="${x + 26}" cy="${y - 26}" r="13" fill="#FFD27A" stroke="#B87400" stroke-width="2"/><text x="${x + 26}" y="${y - 21}" text-anchor="middle" font-size="13" font-weight="800" fill="#7A4A00" font-family="system-ui, sans-serif">+</text>` : ''}</g>`).join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 460" role="presentation" focusable="false"><defs><radialGradient id="${g}" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#E7F8EF"/><stop offset="1" stop-color="#C5EBD7"/></radialGradient></defs>
            <circle cx="260" cy="230" r="215" fill="url(#${g})"/><circle cx="260" cy="230" r="160" fill="none" stroke="#12A06F" stroke-opacity=".25" stroke-width="2"/><circle cx="260" cy="230" r="105" fill="none" stroke="#12A06F" stroke-opacity=".35" stroke-width="2"/>${links}${nodes}
            <g transform="translate(260 230)"><rect x="-58" y="-86" width="116" height="172" rx="22" fill="#0B3B2B"/><rect x="-50" y="-72" width="100" height="140" rx="12" fill="#F2FBF6"/><rect x="-20" y="-80" width="40" height="5" rx="2.5" fill="#12A06F" opacity=".6"/>
                <path d="M-34 -30 h68 v46 h-68 z" fill="#CFEFE0"/><path d="M-34 -30 l8 -14 h52 l8 14 z" fill="#12A06F"/><rect x="-10" y="-8" width="20" height="24" rx="3" fill="#0B3B2B"/>
                <rect x="-34" y="30" width="68" height="10" rx="5" fill="#12A06F"/><rect x="-34" y="46" width="44" height="8" rx="4" fill="#CFEFE0"/></g>
            <g transform="translate(372 156)"><circle r="26" fill="#FFD27A" stroke="#B87400" stroke-width="3"/><text y="6" text-anchor="middle" font-size="15" font-weight="800" fill="#7A4A00" font-family="system-ui, sans-serif">UGX</text></g></svg>`;
    }

    function crewHero() {
        const g = nextId('gk');
        const pins = [[96, 318], [188, 214], [318, 250], [418, 130]];
        const route = 'M96 318 C130 300 150 250 188 214 S280 270 318 250 S380 170 418 130';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 460" role="presentation" focusable="false"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF4DC"/><stop offset="1" stop-color="#FFE3A8"/></linearGradient></defs>
            <rect x="20" y="40" width="480" height="380" rx="36" fill="url(#${g})"/>
            <g stroke="#E8B450" stroke-opacity=".5" stroke-width="2"><path d="M20 140 H500 M20 240 H500 M20 340 H500 M140 40 V420 M260 40 V420 M380 40 V420" fill="none"/></g>
            <path d="M20 372 C140 330 210 400 330 360 S460 330 500 350" fill="none" stroke="#F59E0B" stroke-opacity=".35" stroke-width="16" stroke-linecap="round"/>
            <rect x="214" y="86" width="86" height="60" rx="8" fill="#FFFFFF" stroke="#E8B450" stroke-width="2"/><rect x="226" y="104" width="22" height="42" fill="#FFD27A"/><path d="M208 90 l12 -22 h66 l12 22 z" fill="#F59E0B"/>
            <path d="${route}" fill="none" stroke="#7A4A00" stroke-width="5" stroke-dasharray="3 12" stroke-linecap="round"/>
            ${pins.map(([x, y], k) => `<g transform="translate(${x} ${y})"><path d="M0 0 C-22 -26 -24 -48 0 -52 C24 -48 22 -26 0 0 Z" fill="${k === pins.length - 1 ? '#0F7B53' : '#F59E0B'}" stroke="#7A4A00" stroke-width="3" stroke-linejoin="round"/><circle cy="-34" r="8" fill="#fff"/></g>`).join('')}
            <g transform="translate(402 332)"><circle r="46" fill="#fff" stroke="#7A4A00" stroke-width="4"/><circle r="36" fill="none" stroke="#E8B450" stroke-width="2"/><path d="M0 -30 L9 0 L0 30 L-9 0 Z" fill="#F59E0B"/><path d="M0 -30 L9 0 H-9 Z" fill="#7A4A00"/><circle r="4" fill="#fff" stroke="#7A4A00" stroke-width="2"/></g>
            <g transform="translate(86 96)"><circle r="30" fill="#0B3B2B"/><circle cy="-8" r="9" fill="#FFD27A"/><path d="M-16 18 Q0 -2 16 18" fill="#FFD27A"/></g></svg>`;
    }

    return { hero, medal, ring, MEDALS };
});
