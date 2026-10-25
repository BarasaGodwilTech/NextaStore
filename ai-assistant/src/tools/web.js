// Optional private SearXNG-compatible JSON adapter. Results are untrusted data, never instructions.
'use strict';
const config = require('../config');
const cache = new Map();
function outsideIntent(q) { return /\b(register a business|business registration|tax|market price|fair price|used phone|mobile money (?:withdrawal )?charges|how to (?:sell|price|start a business))\b/i.test(q); }
function generalizedQuery(input) {
  const q = String(input || '').toLowerCase();
  if (/\b(register a business|business registration)\b/.test(q)) return 'Uganda business registration requirements';
  if (/\btax\b/.test(q)) return 'Uganda tax guidance for small businesses';
  if (/\b(used phone|market price|fair price)\b/.test(q)) return 'Uganda used phone market price guidance';
  if (/\bmobile money (withdrawal )?charges\b/.test(q)) return 'Uganda mobile money withdrawal charges';
  if (/\b(how to sell|start a business|seller advice|pricing)\b/.test(q)) return 'general small business selling advice in Uganda';
  return '';
}
function sanitizeQuery(input) {
  let q = String(input || '').replace(/https?:\/\/\S+/gi, ' ').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, ' ').replace(/\+?\d[\d ()-]{6,}\d/g, ' ').replace(/\b(?:order|account|transaction|reference)\s*(?:number|no\.?|#)?\s*[:#-]?\s*[A-Z0-9-]{5,}\b/gi, ' ').replace(/\b(?:at|for|from|my|me|please|named|called)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d ()-]{6,}\d/i.test(q)) return '';
  return q.slice(0, 180);
}
async function search(question, fetchImpl = fetch) {
  const rawQuestion = String(question || '');
  if (!config.webSearchUrl || !outsideIntent(rawQuestion)) return null;
  if (/\b(nextastore|seller pass|my order|my account|my payment|password|inside nextastore|on nextastore)\b/i.test(rawQuestion)) return null;
  try { if (require('../lang/detect').detectLanguage(rawQuestion).code === 'lg') return null; } catch { /* keep web optional if language detection is unavailable */ }
  const query = sanitizeQuery(generalizedQuery(question)); if (!query || /\b(nextastore|seller pass|my order|my account|my payment|password|luganda)\b/i.test(query)) return null;
  const key = query.toLowerCase(); const cached = cache.get(key); if (cached && cached.expires > Date.now()) return cached.value;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.webTimeoutMs);
  try {
    const url = new URL(config.webSearchUrl); url.searchParams.set('q', query); url.searchParams.set('format', 'json');
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } }); if (!res.ok) return null;
    const body = await res.json(); const allowed = config.webAllowedDomains;
    const rows = (Array.isArray(body.results) ? body.results : []).filter((r) => { try { const host = new URL(r.url).hostname.toLowerCase(); return allowed.some((d) => host === d || host.endsWith(`.${d}`)); } catch { return false; } }).slice(0,3).map((r) => ({ title: String(r.title || '').slice(0,120), snippet: String(r.content || r.snippet || '').slice(0,config.webMaxChars), url: String(r.url || '') }));
    const value = rows.length ? rows : null; cache.set(key, { value, expires: Date.now() + config.webCacheMinutes * 60000 }); return value;
  } catch { return null; } finally { clearTimeout(timer); }
}
module.exports = { search, sanitizeQuery, outsideIntent, generalizedQuery };
