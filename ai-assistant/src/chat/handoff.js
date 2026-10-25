'use strict';
const EN_HANDOFF = 'I need to connect you with a human team member so they can help with this. You can contact our team on WhatsApp.';
// DRAFT for Luganda speaker review; metadata.needs_review must never be rendered as text.
const LG_HANDOFF = 'Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe. Osobola okwogera n’ekibinja kyaffe ku WhatsApp.';
function normaliseIntent(s) { return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim(); }
// WIP 97: "real person" counts only with an EXPLICIT ask (talk / speak / connect me to ... a real person or agent).
// A question ABOUT Nexi ("are you a real person or a bot?") is answered by the about-Nexi intent and is never a handoff.
const PERSON = '(?:real\\s+|actual\\s+|live\\s+)?(?:human|person|agent|someone|somebody|representative|rep|staff|operator|team\\s+member|customer\\s+(?:care|service))';
const ASK_RES = [
 new RegExp(`\\b(?:talk|speak|chat|connect|transfer|put|switch|get|reach|pass|forward|refer|escalate)\\s+(?:me\\s+)?(?:to|with|through\\s+to|over\\s+to)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?${PERSON}\\b`),
 new RegExp(`\\b(?:i\\s+)?(?:want|need|prefer|would\\s+like|wanna|require)\\s+(?:to\\s+(?:talk|speak|chat)\\s+(?:to|with)\\s+)?(?:a\\s+|an\\s+)?${PERSON}\\b`),
 new RegExp(`\\b(?:give|get|bring)\\s+me\\s+(?:a\\s+|an\\s+)?${PERSON}\\b`),
 new RegExp(`\\blet\\s+me\\s+(?:talk|speak|chat)\\s+(?:to|with)\\s+(?:a\\s+|an\\s+)?${PERSON}\\b`),
 new RegExp(`\\b(?:can|could|may)\\s+i\\s+(?:please\\s+)?(?:talk|speak|chat)\\s+(?:to|with)\\s+(?:a\\s+|an\\s+)?${PERSON}\\b`),
 /\bcustomer\s+care\s+(?:agent|person|representative)\b/, /\bsupport\s+agent\b/, /\bconnect\s+me\s+to\s+support\b/, /\b(?:human|live)\s+agent\b/,
 /\b(?:njagala okwogera n'omuntu|njagala omuntu ampe obuyambi|njunga n'omukozi)\b/,
];
function detectHumanRequest(message) {
 const s = normaliseIntent(message).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
 // "are you a human agent?" / "is this a live agent?" ask ABOUT Nexi, they do not ask for a person
 if (/^(?:are|is|am)\b/.test(s) && /\b(?:you|this|it|nexi)\b/.test(s) && !/\b(?:can|could|may)\s+i\b/.test(s) && !/\b(?:want|need|connect|talk|speak)\b/.test(s)) return false;
 if (/\b(?:what|who)\s+(?:is|are)\b|\btell\s+me\s+if\b|\bif\s+the\b|\bis\s+the\b/.test(s) && !/\b(?:talk|speak|connect|want|need|transfer)\b/.test(s)) return false;
 return ASK_RES.some((re) => re.test(s));
}
const CLAIMS = [
 { name:'refund', re:/\b(?:refund(?:s|ed|able)?|money back|return policy)\b/i, terms:/\b(?:refund|refunded|refundable|refunds|money back|return policy)\b/i },
 { name:'fee', re:/\b(?:fee|fees|cost|costs|charge|charges|price|priced)\b/i, terms:/\b(?:fee|fees|cost|costs|charge|charges|price|priced|ugx)\b/i },
 { name:'delivery', re:/\b(?:deliver(?:y|ed|s)?|shipping|arrive|arrival|dispatch)\b/i, terms:/\b(?:deliver|delivery|delivered|delivers|shipping|arrive|arrival|dispatch)\b/i },
 { name:'warranty', re:/\b(?:warrant(?:y|ies)|guarantee)\b/i, terms:/\b(?:warranty|warranties|guarantee)\b/i },
 { name:'time', re:/\b(?:within|in)\s+\d+\s+(?:days?|hours?|weeks?)\b/i, terms:/\b(?:within|days?|hours?|weeks?)\b/i }
];
const { claimProblems } = require('./claims');
// WIP 92d: claim-level check (specific figure / promise absent from the context) on top of the earlier topic-level rules.
function policyClaimUnsupported(reply, contextText) {
 return topicClaimUnsupported(reply, contextText) || claimProblems(reply, contextText).length > 0;
}
function topicClaimUnsupported(reply, contextText) {
 const text=String(reply||''), context=String(contextText||'');
 for (const c of CLAIMS) {
  const m=text.match(c.re); if (!m) continue;
  if (!c.terms.test(context)) return true;
  const contextLacksDetails = /\b(?:no|not|without)\s+(?:information|details|policy|terms|fee|fees|delivery|shipping|warranty|guarantee|refunds?)\b|\b(?:information|details)\s+(?:is|are)\s+not\s+(?:provided|available|specified)\b/i.test(context);
  if (contextLacksDetails && c.terms.test(context)) return true;
  if (c.name==='refund') {
   const contextNegative=/\b(?:no refunds?|not refundable|refunds? (?:are )?not (?:available|accepted|allowed)|not eligible for (?:a )?refund)\b/i.test(context);
   // WIP 98: "can't get your money back", "no money back" and "cannot be refunded" say the same as "not refundable"
   const replyNegative=/\b(?:no refunds?|not refundable|refunds? (?:are )?not (?:available|accepted|allowed)|not eligible for (?:a )?refund)\b/i.test(text)||/\b(?:no|not|never|cannot|can't|cant|isn't|aren't|won't|don't|doesn't)\b[^.!?]{0,40}\b(?:refund(?:s|ed|able)?|money back)\b/i.test(text);
   const replyPositive=/\b(?:refundable|refunds? (?:are )?(?:available|accepted|allowed|possible)|money back)\b/i.test(text);
   if ((contextNegative && replyPositive && !replyNegative) || (!contextNegative && replyNegative && /\brefund/i.test(context))) return true;
  }
  if (c.name==='time') {
   // WIP 98: the span is supported when the context states the same number of the same unit ("30 days" supports "in 30 days" and "within 30 days"), not only the identical phrase
   const span=/(\d+)\s+(days?|hours?|weeks?)/i.exec(m[0]);
   if (span && !new RegExp('\\b'+span[1]+'\\s+'+span[2].replace(/s$/i,'')+'s?\\b','i').test(context)) return true;
  }
 }
 return false;
}
const { createMarkerGate, stripMarkers } = require('./markers');
// WIP 92c: one shared gate (markers.js). Same names kept for callers; flags are separate: off_topic / handoff.
function markerGate(onText) { return createMarkerGate(onText); }
function stripMarker(text) { const r = stripMarkers(text); return { text: r.text, marked: r.marked, off_topic: r.off_topic, handoff: r.handoff }; }
// WIP 93 Tier 3.2: the English handoff gets the admin-set support hours APPENDED when there is one. The base sentence is never changed, and
// the Luganda handoff is never changed (no Luganda is invented for the hours: it stays the one draft sentence).
function withHours(text, note) {
 const n=String(note||'').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\[|\]|\(|\)|https?:\/\/\S+/gi,'').replace(/\s+/g,' ').trim().slice(0,240);
 return n ? `${text} Support hours: ${n}` : text;
}
module.exports={detectHumanRequest,policyClaimUnsupported,EN_HANDOFF,LG_HANDOFF,markerGate,stripMarker,withHours};
