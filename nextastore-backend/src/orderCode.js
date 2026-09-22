const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids ambiguity when read aloud/typed

function generateOrderCode(length = 8) {
    const bytes = crypto.randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i++) {
        code += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return code;
}

module.exports = { generateOrderCode };
