'use strict';
function normalizeUgandanWhatsapp(value) {
 const raw=String(value==null?'':value).trim(); if(!raw) return '';
 let digits=raw.replace(/[\s()+.-]/g,''); if(!/^\d+$/.test(digits)) return raw;
 if(digits.startsWith('0')) digits='256'+digits.slice(1);
 if(digits.startsWith('7')&&digits.length===9) digits='256'+digits;
 return digits;
}
function validUgandanWhatsapp(value) { const n=normalizeUgandanWhatsapp(value); return n===''||/^2567\d{8}$/.test(n); }
module.exports={normalizeUgandanWhatsapp,validUgandanWhatsapp};
