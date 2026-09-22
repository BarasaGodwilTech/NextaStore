#!/usr/bin/env node
/**
 * Generates one VAPID keypair for Web Push and prints it in .env format.
 *
 * Run this ONCE per environment (dev, staging, production each get their
 * own pair -- never reuse a keypair across deployments, and never commit the
 * output to source control). Paste the three lines it prints into that
 * environment's .env / secret manager, then restart the API.
 *
 * Rotating the keypair later invalidates every subscription that was made
 * under the old one -- every browser that had granted permission will need
 * to (silently) re-subscribe the next time it opens the app, which the
 * frontend already handles (see js/push.js), so rotation is safe, just not
 * free.
 *
 *   node scripts/generate-vapid-keys.js
 */
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Add these to your .env (see .env.example), then restart the API:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:support@yourdomain.com  # change to a real inbox you monitor\n');
console.log('Keep VAPID_PRIVATE_KEY secret -- treat it like any other API credential.');
