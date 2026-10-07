#!/usr/bin/env node
'use strict';
/**
 * Used by start.bat (you do not run this yourself).
 *
 * Reads the SAME .env the assistant reads and prints a few `set "NAME=value"` lines
 * for the batch file, so start.bat always agrees with the running service.
 * On any problem it writes a message to stderr, prints nothing to stdout, exits 1.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const config = require('../src/config');

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const raw = (k) => String(process.env[k] === undefined ? '' : process.env[k]).trim();
const problems = [];
const warnings = [];

function model(key, label, required) {
    const v = raw(key);
    if (!v) {
        if (required) problems.push(`${key} is empty in .env. Write the ${label} model name there (the options are listed in the file).`);
        return '';
    }
    if (!SAFE_MODEL.test(v)) {
        problems.push(`${key}="${v}" does not look like an Ollama model name (letters, numbers and . _ : / - only).`);
        return '';
    }
    return v;
}

const chat = model('CHAT_MODEL', 'chat', true);
// The embedding model is only needed for the optional hybrid retrieval mode.
const useEmbed = config.retrieval === 'hybrid';
const embed = model('EMBED_MODEL', 'embedding', useEmbed);
const ganda = model('GANDA_MODEL', 'Luganda', false);

// Ganda Gemma is only used when Luganda is handled locally.
const provider = config.lugandaProvider;
const useGanda = Boolean(ganda) && (provider === 'auto' || provider === 'local');
if (config.legacySettingsIgnored.length) warnings.push(`${config.legacySettingsIgnored.join(', ')} is ignored: hosted Luganda services were removed. You can delete it from .env.`);
if (provider === 'local' && !ganda) warnings.push('LUGANDA_PROVIDER=local but GANDA_MODEL is empty: Luganda answers will fall back to English.');
if (ganda && !useGanda) warnings.push(`GANDA_MODEL is set but LUGANDA_PROVIDER=${provider}, so Ganda Gemma will not be downloaded or used.`);

let host = null;
try { host = new URL(config.ollamaHost); } catch (e) { problems.push(`OLLAMA_HOST="${raw('OLLAMA_HOST')}" is not a valid address.`); }
const isLocal = host ? ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(host.hostname) : true;
if (host && !isLocal && !/^https?:\/\/[A-Za-z0-9._:\-\[\]]+$/.test(config.ollamaHost)) problems.push('OLLAMA_HOST contains unexpected characters.');

for (const w of warnings) console.error('Note: ' + w);
if (problems.length) {
    console.error('');
    for (const p of problems) console.error('Problem in .env: ' + p);
    process.exit(1);
}

const lines = [
    `set "NX_CHAT=${chat}"`,
    `set "NX_EMBED=${useEmbed ? embed : ''}"`,
    `set "NX_GANDA=${useGanda ? ganda : ''}"`,
    `set "NX_PORT=${config.port}"`,
    `set "NX_OLLAMA_LOCAL=${isLocal ? 1 : 0}"`,
];
// The ollama command-line tool must talk to the same server the assistant uses.
if (!isLocal) lines.push(`set "OLLAMA_HOST=${config.ollamaHost}"`);
process.stdout.write(lines.join('\r\n') + '\r\n');
