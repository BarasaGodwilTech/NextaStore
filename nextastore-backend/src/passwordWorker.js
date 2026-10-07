'use strict';
/*
 * Runs inside a worker thread (see password.js). It does the bcrypt work so
 * the main thread - the one serving every request - never stalls on it.
 * Same library, same cost, same hash format as before: existing password
 * hashes keep working.
 */
const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, op, password, hash, rounds }) => {
    try {
        const result = op === 'hash'
            ? bcrypt.hashSync(password, rounds)
            : bcrypt.compareSync(password, hash);
        parentPort.postMessage({ id, result });
    } catch (err) {
        parentPort.postMessage({ id, error: String((err && err.message) || err) });
    }
});
