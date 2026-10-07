'use strict';
/*
 * Password hashing that does not block the event loop.
 *
 * bcryptjs is pure JavaScript. Its callback/async mode only yields every
 * ~100ms of work, and one hash at cost 10 takes about 80ms, so `await
 * bcrypt.hash()` still froze the whole server for the length of each login.
 * Here the work runs in a small pool of worker threads instead.
 *
 *   const { hash, compare } = require('./password');
 *   const h  = await hash('secret');          // bcrypt, cost 10
 *   const ok = await compare('secret', h);    // true / false
 *
 * Hashes are ordinary bcrypt ($2a$/$2b$) strings, byte-compatible with the
 * ones already in the database. PASSWORD_WORKERS (default 2, max 8) sets the
 * pool size. If a worker cannot be started the call falls back to running in
 * this thread, so a login never fails just because of the pool.
 */
const path = require('path');
const bcrypt = require('bcryptjs');

const ROUNDS = 10;
const WORKER_FILE = path.join(__dirname, 'passwordWorker.js');
const SIZE = Math.min(8, Math.max(1, parseInt(process.env.PASSWORD_WORKERS, 10) || 2));

let Worker = null;
try { ({ Worker } = require('worker_threads')); } catch (_) { /* very old Node: run in-thread */ }

const slots = [];      // { worker, pending: Map<id, {resolve, reject}> }
let nextId = 1;
let cursor = 0;
let poolBroken = false;

// Lets the process exit again once a worker has nothing left to do.
function release(slot) { if (slot.pending.size === 0) slot.worker.unref(); }

function spawn(index) {
    const worker = new Worker(WORKER_FILE);
    const slot = { worker, pending: new Map() };
    const failAll = (err) => {
        for (const { reject } of slot.pending.values()) reject(err);
        slot.pending.clear();
        release(slot);
        if (slots[index] === slot) slots[index] = null; // respawned on next use
    };
    worker.on('message', ({ id, result, error }) => {
        const p = slot.pending.get(id);
        if (!p) return;
        slot.pending.delete(id);
        release(slot);
        if (error !== undefined) p.reject(new Error(error)); else p.resolve(result);
    });
    worker.on('error', failAll);
    worker.on('exit', () => failAll(new Error('password worker exited')));
    // Idle workers must never keep the process alive, but a call in flight must
    // (or a script could exit mid-hash). So: unref now, ref while work is pending
    // (see run/release). unref() has to come AFTER the listeners above - adding a
    // 'message' listener re-refs the port and would silently undo it.
    worker.unref();
    slots[index] = slot;
    return slot;
}

function run(op, payload) {
    if (!Worker || poolBroken) return Promise.reject(new Error('no-pool'));
    const index = cursor++ % SIZE;
    let slot = slots[index];
    try { if (!slot) slot = spawn(index); } catch (err) { poolBroken = true; return Promise.reject(err); }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        slot.worker.ref();
        try { slot.worker.postMessage({ id, op, ...payload }); } catch (err) { slot.pending.delete(id); release(slot); reject(err); }
    });
}

// A worker that died mid-call is a pool problem, not a wrong password: retry
// the work in this thread rather than turning it into a failed login.
async function withFallback(op, payload, local) {
    try { return await run(op, payload); } catch (_) { return local(); }
}

const hash = (password, rounds = ROUNDS) =>
    withFallback('hash', { password, rounds }, () => bcrypt.hash(password, rounds));

const compare = (password, hashed) =>
    withFallback('compare', { password, hash: hashed }, () => bcrypt.compare(password, hashed));

// Ends the pool (used by tests so a script can exit cleanly).
async function close() {
    await Promise.all(slots.filter(Boolean).map((s) => s.worker.terminate()));
    slots.length = 0;
}

module.exports = { hash, compare, close };
