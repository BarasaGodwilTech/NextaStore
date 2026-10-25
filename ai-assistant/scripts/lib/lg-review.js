'use strict';
/**
 * WIP 93: shared pieces of the Luganda review pack (export-lg-review.js / import-lg-review.js).
 * No Luganda is invented here: this only moves text between the code, a CSV a Luganda speaker edits, and translation-memory.json.
 */
const COLUMNS = ['id', 'where_used', 'english_source', 'current_luganda', 'status', 'notes', 'reviewer', 'reviewed_on'];
const STATUSES = ['approved', 'draft', 'missing'];

function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCsv(rows) { return '\uFEFF' + [COLUMNS.join(',')].concat(rows.map((r) => COLUMNS.map((c) => csvEscape(r[c])).join(','))).join('\r\n') + '\r\n'; }

/** RFC 4180 parser (quoted fields, doubled quotes, embedded newlines). Returns an array of objects keyed by the header row. */
function parseCsv(text) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQ) {
            if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; }
        else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some((c) => c !== '')) rows.push(row); }
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

// ---- what must survive a translation -------------------------------------------------------------
const LINK_RE = /\[([^\]\n]{1,80})\]\((\/[A-Za-z0-9\-_/]*)\)/g;
const PLACEHOLDER_RE = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/g;
const digitsOf = (t) => (String(t).replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) || []);
const linkTargets = (t) => [...String(t).matchAll(LINK_RE)].map((m) => m[2]);
const placeholders = (t) => (String(t).match(PLACEHOLDER_RE) || []).map((p) => p.replace(/\s+/g, ''));
const ugxCount = (t) => (String(t).match(/\bUGX\b/gi) || []).length;
const sameBag = (a, b) => a.slice().sort().join('|') === b.slice().sort().join('|');

/** Notes for a row: what a translator must keep exactly. */
function keepNotes(english) {
    const out = [];
    const nums = digitsOf(english); if (nums.length) out.push(`keep numbers exactly: ${nums.join(', ')}`);
    if (ugxCount(english)) out.push(`keep UGX amounts (${ugxCount(english)}x "UGX")`);
    const links = linkTargets(english); if (links.length) out.push(`keep link targets exactly: ${links.join(', ')} (the visible label is replaced on Luganda turns by the site-wide link-label rows, so wording a label here has no effect)`);
    const ph = placeholders(english); if (ph.length) out.push(`keep placeholders exactly: ${ph.join(' ')}`);
    if (/⟦\d+⟧/.test(english)) out.push('keep ⟦n⟧ link tokens');
    return out.join('; ');
}

/** Why an approved pair is not safe to load. Empty array = safe. */
function validatePair(english, luganda) {
    const problems = [];
    const en = String(english || ''), lg = String(luganda || '');
    if (!en.trim()) problems.push('English source is empty');
    if (!lg.trim()) problems.push('Luganda is empty');
    if (problems.length) return problems;
    if (/\bDRAFT\b|needs_review/i.test(lg)) problems.push('Luganda contains DRAFT or needs_review');
    if (!sameBag(digitsOf(en), digitsOf(lg))) problems.push(`numbers differ: English [${digitsOf(en)}] vs Luganda [${digitsOf(lg)}]`);
    if (ugxCount(en) !== ugxCount(lg)) problems.push(`UGX amounts differ: ${ugxCount(en)} in English vs ${ugxCount(lg)} in Luganda`);
    if (!sameBag(linkTargets(en), linkTargets(lg))) problems.push(`link targets differ: English [${linkTargets(en)}] vs Luganda [${linkTargets(lg)}]`);
    if (!sameBag(placeholders(en), placeholders(lg))) problems.push(`{{placeholders}} differ: English [${placeholders(en)}] vs Luganda [${placeholders(lg)}]`);
    if (en.trim().toLowerCase() === lg.trim().toLowerCase()) problems.push('Luganda is identical to the English (not a translation)');
    return problems;
}

module.exports = { COLUMNS, STATUSES, toCsv, parseCsv, keepNotes, validatePair, digitsOf, linkTargets, placeholders, LINK_RE };
