'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'); const path=require('node:path'); const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const h=require(path.join(root,'src/chat/handoff'));
const norm=require(path.resolve(root,'../nextastore-backend/src/whatsapp-normalizer'));
assert.equal(norm.normalizeUgandanWhatsapp('0761789006'),'256761789006');
assert.equal(norm.normalizeUgandanWhatsapp('+256 761-789006'),'256761789006');
assert.equal(norm.validUgandanWhatsapp('0123456789'),false);
assert.equal(norm.validUgandanWhatsapp('0761789006'),true);
const lg=require(path.join(root,'src/lang/lgGuard'));
assert.equal(h.detectHumanRequest('I want to talk to a human'),true);
assert.equal(h.detectHumanRequest('Could I speak to a real person?'),true);
assert.equal(h.detectHumanRequest('share on WhatsApp'),false);
assert.equal(h.detectHumanRequest('WhatsApp'),false);
assert.equal(h.detectHumanRequest('how do I contact support'),false);
assert.equal(h.detectHumanRequest('I’d like to speak to a person'),true);
assert.equal(h.detectHumanRequest('how do I contact support'),false);
assert.equal(h.detectHumanRequest('connect me to support'),true);
assert.equal(h.policyClaimUnsupported('Refunds are available within 7 days','No refunds are available.'),true);
assert.equal(h.policyClaimUnsupported('Delivery is within 3 days','No delivery information is provided.'),true);
assert.equal(h.policyClaimUnsupported('This product costs UGX 20,000','Prices are shown as UGX 20,000 in the catalog.'),false);
assert.equal(h.policyClaimUnsupported('This product is covered by a warranty','No warranty information is provided.'),true);
assert.equal(h.policyClaimUnsupported('The refund policy is explained here','Refund policy: eligible refunds are reviewed by the team.'),false);
let sent=''; const gate=h.markerGate(x=>sent+=x); gate.push('Hello [HAND'); gate.push('OFF]secret'); const mark=gate.end(); assert.equal(mark.marked,true); assert.equal(sent,'Hello secret');
assert.equal(lg.effectiveLang(undefined,'yee',[{role:'user',content:'Nsobola okugula?'}]),'lg');
assert.equal(lg.gateReply({lang:'lg',source:'faq',text:'Your order will arrive tomorrow'}).handoff.reason,'language_guard');
assert.equal(lg.gateReply({lang:'lg',source:'phrasebook',text:'Webale nnyo'}).allowed,true);
assert.equal(lg.gateReply({lang:'lg',source:'model+local',text:'Webale nnyo',translatedPieces:[{translated:true}]}).allowed,true);
assert.equal(lg.gateReply({lang:'lg',source:'model+local',text:'Thank you very much',translatedPieces:[{translated:true}]}).allowed,false);
// Exhaustive structural-gate matrix over source, translator state, transport and failure paths.
const sources=['phrasebook','smalltalk','canned','handoff','clarify','model+local','faq','link','cards','fallback','cache'];
const modes=['on','off','partial','throwing']; let matrixCases=0;
for(const source of sources) for(const mode of modes) for(const stream of [false,true]) for(const ollamaDown of [false,true]) for(const queueFull of [false,true]) {
 const pieces=mode==='on'?[{translated:true}]:mode==='partial'?[{translated:true},{translated:false}]:[];
 const text=(source==='phrasebook'||source==='smalltalk'||source==='canned'||source==='handoff'||source==='clarify')?'Webale nnyo':(source==='model+local'&&mode==='on'?'Webale nnyo':'Your refund is available in 7 days');
 const result=lg.gateReply({lang:'lg',source,text,translatorMode:mode,translatedPieces:pieces,stream,ollamaDown,queueFull});
 assert.equal(/(the|and|is|are|you|your|can|please|support|refund|delivery|warranty)|DRAFT|needs_review/i.test(result.text),false,`${source}/${mode}/stream=${stream}/ollamaDown=${ollamaDown}/queueFull=${queueFull}`);
 matrixCases++;
}
assert.equal(matrixCases,352);
// Mutation proof: weaken the real module's provenance condition and demonstrate that the leak assertion catches it.
const guardPath=path.join(root,'src/lang/lgGuard.js'); const guardSource=fs.readFileSync(guardPath,'utf8');
const mutated=guardSource.replace('if (trusted || allApproved || (viaTranslator && !englishLeak(t)))', 'if (true)'); assert.notEqual(mutated,guardSource,'mutation target exists');
const mutatedModule={exports:{}}; vm.runInNewContext(mutated,{module:mutatedModule,exports:mutatedModule.exports,require:(id)=>require(path.join(root,'src/lang',id.replace('./','')+'.js'))});
const mutationReply=mutatedModule.exports.gateReply({lang:'lg',source:'faq',text:'Your order will arrive tomorrow'});
assert.equal(lg.strictTextCheck(mutationReply.text),false,'mutation must produce a detectable English leak');

// VM harness executes the real widget source; expose its private summary helpers only in this test copy.
const widgetPath=path.resolve(root,'../js/assistant.js'); let src=fs.readFileSync(widgetPath,'utf8');
src=src.replace(/\}\)\(\);\s*$/, 'window.__wip92test={scrubHandoffText:scrubHandoffText,handoffSummary:handoffSummary,buildHandoffHref:buildHandoffHref,state:state};\n})();');
const document={readyState:'loading',addEventListener(){},body:{getAttribute(){return null}},documentElement:{},createElement(){return {style:{},classList:{add(){},remove(){}},setAttribute(){},appendChild(){},addEventListener(){}}},querySelector(){return null},querySelectorAll(){return []}};
const window={NexiAssistant:null,location:{pathname:'/marketplace',search:''},addEventListener(){},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},localStorage:{getItem(){return null},setItem(){},removeItem(){}}};
const location={pathname:'/marketplace',search:'',hostname:'localhost',origin:'http://localhost'}; const sandbox={window,document,location,matchMedia:()=>({matches:false}),sessionStorage:window.sessionStorage,localStorage:window.localStorage,console,URL,URLSearchParams,fetch:()=>Promise.reject(new Error('stub')),setTimeout,clearTimeout,encodeURIComponent,decodeURIComponent};
vm.runInNewContext(src,sandbox,{filename:'js/assistant.js'});
const w=window.__wip92test; w.state.lang='lg';
assert.ok(w,'real widget helpers were exposed by VM harness');
assert.match(w.scrubHandoffText('Price UGX 45000 order 123456'),/UGX 45000 order 123456/);
assert.match(w.scrubHandoffText('email me a@b.com and call +256 761 234 567'),/email redacted/);
assert.match(w.scrubHandoffText('OTP: 123456'),/redacted/);
assert.match(w.scrubHandoffText('Price UGX 45,000 order 123456 reference 7654321'),/UGX 45,000 order 123456 reference 7654321/);
assert.match(w.scrubHandoffText('Card 4111 1111 1111 1111'),/card redacted/i);
assert.ok(w.handoffSummary('x'.repeat(2000)).length<=600);
assert.ok(w.handoffSummary('').length<=600);
assert.match(w.buildHandoffHref({enabled:true,whatsappDigits:'256761789006'},'hello'),/^https:\/\/wa\.me\/256761789006\?text=/);
assert.equal(w.buildHandoffHref({enabled:false},'hello'),'');
assert.match(w.handoffSummary('Nnyinza ntya okugula?'),/Luganda/);
assert.match(w.buildHandoffHref({enabled:true,whatsappDigits:'256761789006'},"Nnyinza ntya okugula?"),/%/);
assert.equal(/DRAFT|needs_review/i.test(fs.readFileSync(widgetPath,'utf8')),false);
assert.ok(Number(/CACHE_VERSION = 'v(\d+)'/.exec(fs.readFileSync(path.resolve(root,'../service-worker.js'),'utf8'))[1])>=59); // WIP 93: was exactly v59; the widget changed (aria-label/tabindex) so the cache was bumped
const proxySrc=fs.readFileSync(path.resolve(root,'../nextastore-backend/src/assistantProxy.js'),'utf8'); assert.match(proxySrc,/for await \(const chunk of up\.body\) res\.write\(chunk\)/); assert.match(proxySrc,/res\.end\(text\)/); // /chat and /chat/stream pass upstream JSON/NDJSON through without rebuilding done fields
for(let i=0;i<20000;i++){const fuzz=Math.random().toString(36).repeat(i%9)+String(i)+'@example.com'; assert.doesNotThrow(()=>w.scrubHandoffText(fuzz));}
console.log(`WIP92 dependency-free checks passed: handoff, marker, Luganda gate (${matrixCases} matrix cases + mutation proof), real widget VM helpers, 20,000 redaction fuzz inputs`);
