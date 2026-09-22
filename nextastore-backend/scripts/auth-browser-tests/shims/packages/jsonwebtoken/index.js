// Minimal HS256-only stand-in for `jsonwebtoken`, used ONLY when the real
// package is not installed (offline sandbox). NODE_PATH is searched after
// node_modules, so a real install always wins. Behaviour that matters to
// src/middleware.js is matched: the payload's own iat/exp are kept as given,
// verify() checks the signature, the pinned algorithm and `exp` (against
// Date.now(), so a test can move the clock), and errors carry the same names.
const crypto = require('crypto');

class JsonWebTokenError extends Error { constructor(m) { super(m); this.name = 'JsonWebTokenError'; } }
class TokenExpiredError extends JsonWebTokenError { constructor(m) { super(m); this.name = 'TokenExpiredError'; } }

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function sign(payload, secret, options = {}) {
    const alg = options.algorithm || 'HS256';
    if (alg !== 'HS256') throw new Error('shim only signs HS256');
    const body = { ...payload };
    if (body.iat === undefined) body.iat = Math.floor(Date.now() / 1000);
    if (typeof options.expiresIn === 'string' && /^-?\d+s$/.test(options.expiresIn)) body.exp = body.iat + parseInt(options.expiresIn, 10);
    else if (typeof options.expiresIn === 'number') body.exp = body.iat + options.expiresIn;
    const head = enc({ alg: 'HS256', typ: 'JWT' });
    const data = `${head}.${enc(body)}`;
    return `${data}.${mac(data, secret)}`;
}

function decode(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (e) { return null; }
}

function verify(token, secret, options = {}) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new JsonWebTokenError('jwt malformed');
    let header;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { throw new JsonWebTokenError('invalid token'); }
    const allowed = options.algorithms || ['HS256'];
    if (!allowed.includes(header.alg)) throw new JsonWebTokenError('invalid algorithm');
    const expected = mac(`${parts[0]}.${parts[1]}`, secret);
    const a = Buffer.from(expected), b = Buffer.from(parts[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new JsonWebTokenError('invalid signature');
    const payload = decode(token);
    if (!payload) throw new JsonWebTokenError('invalid token');
    if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) throw new TokenExpiredError('jwt expired');
    return payload;
}

module.exports = { sign, verify, decode, JsonWebTokenError, TokenExpiredError };
