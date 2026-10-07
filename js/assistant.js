/* ==========================================================================
   Nexi - NextaStore's AI assistant (WIP 53, layout + flagging reworked in WIP 55)

   One conversation, two doors into it:
     - the chat card in the Marketplace hero   (NexiAssistant.mountHero)
     - the floating assistant button + panel   (every page)
   Both show the same messages (kept in sessionStorage for the tab session).
   Also owns the back-to-top arrow that sits above the assistant button.

   Public API: window.NexiAssistant = { mountHero, open, close, toggle, ask }
   Page opt-out: <body data-assistant="off">
   Sticky bottom bars the dock should rise above: add data-dock-avoid.
   ========================================================================== */
(function () {
    'use strict';
    if (window.NexiAssistant) return;

    var STORE_KEY = 'nx.nexi.v1';
    var TEASE_KEY = 'nx.nexi.teased';
    var MAX_LEN = 600;
    var KEEP = 40;
    var ALLOWED_PATHS = ['/marketplace', '/stores', '/signup', '/login', '/dashboard', '/product-form', '/subscription', '/orders', '/messages', '/favorites', '/following', '/cart', '/safety', '/terms', '/privacy'];
    var AVOID = '.pf-actions, .onboarding-actions, .settings-form-actions--sticky, [data-dock-avoid]';
    var SUPPRESS = 'body.drawer-open, .nx-catpick.is-open';

    // ---- Conversation starters (the assistant service can override these via /starters) ----
    var STARTERS = {
        en: {
            guest: ['How do I start my first store?', 'What should I sell as a beginner?', 'Give me business ideas I can start with a small budget', 'How do I price my products?', 'How do I find a trustworthy seller?', 'How can I buy safely on NextaStore?'],
            seller: ['What should I add to my store next?', 'How do I get more customers?', 'How do I take good product photos?', 'How do I price my products?', 'How does the Seller Pass work?']
        },
        lg: {
            guest: ['Nnyinza ntya okutandika edduuka lyange erisooka?', 'Ntunde ki nga nkyatandika?', "Mpa ebirowoozo by'obusuubuzi bye nsobola okutandika n'ensimbi entono", "Nsalawo ntya ku bbeeyi y'ebintu byange?", 'Nnyinza ntya okufuna omutunzi omwesigwa?', 'Nnyinza ntya okugula mu ngeri etaliimu bulabe?'],
            seller: ['Ntunde ki ekirala mu dduuka lyange?', 'Nnyinza ntya okufuna bakasitoma abangi?', "Nnyinza ntya okukwata ebifaananyi ebirungi eby'ebintu byange?", "Nsalawo ntya ku bbeeyi y'ebintu byange?", 'Seller Pass ekola etya?']
        }
    };
    // Only wording that is certain is localised here ("Buuza Nexi" = "Ask Nexi"). The Luganda CONTENT comes from the
    // starters (machine-translated by the local Ganda Gemma model via `npm run translate:starters`) and the assistant service.
    var COPY = {
        en: { placeholder: 'Ask Nexi anything...', welcome: "Hi, I'm Nexi, your NextaStore guide. Ask me what to sell, how to open your first store, or how to buy safely.", title: 'Ask Nexi', sub: 'Your guide to buying and selling on NextaStore' },
        lg: { placeholder: 'Buuza Nexi...', welcome: "Hi, I'm Nexi, your NextaStore guide. Pick a question below, or type your own in Luganda or English.", title: 'Buuza Nexi', sub: 'Your guide to buying and selling on NextaStore' }
    };
    // Flagged messages (WIP 55): the assistant service marks turns that are clearly not about NextaStore.
    var FLAG_LABEL = { off_topic: 'Not about NextaStore', inappropriate: 'Inappropriate language', sensitive: 'Private details', manipulation: 'Not allowed', unclear: 'Unclear message' };
    var FLAG_TYPES = ['off_topic', 'inappropriate', 'sensitive', 'manipulation', 'unclear'];
    var SUGGEST_FOR = ['off_topic', 'inappropriate', 'manipulation', 'unclear']; // flags that offer "try asking" chips (not for private details)
    var STARTER_LABEL = 'Try asking';
    var FOOT = 'Nexi is an AI guide and can make mistakes. For orders and payments, check the page itself or message the seller.';

    // ---- Page opt-out ----
    function disabled() {
        return !!(document.body && document.body.getAttribute('data-assistant') === 'off');
    }

    // ---- Environment helpers ----
    function apiBase() {
        var meta = document.querySelector('meta[name="nextastore-assistant-base"]');
        if (meta && meta.content) return meta.content.replace(/\/$/, '');
        var base = '';
        try { if (typeof app !== 'undefined' && app && app.apiBaseUrl) base = app.apiBaseUrl; } catch (e) { /* no app on this page */ }
        if (!base) {
            var h = location.hostname;
            base = (h === 'localhost' || h === '127.0.0.1') ? 'http://localhost:4000/api' : location.origin + '/api';
        }
        return base.replace(/\/$/, '') + '/assistant';
    }
    function audience() {
        try { if (typeof app !== 'undefined' && app && app.user) return app.user.role === 'seller' ? 'seller' : 'buyer'; } catch (e) { /* ignore */ }
        return 'guest';
    }
    function pageKey() {
        var p = location.pathname.replace(/^\/+|\/+$/g, '').replace(/\.html$/, '').split('/')[0].toLowerCase();
        if (!p) return 'home';
        return /^[a-z0-9-]{1,30}$/.test(p) ? p : 'other';
    }
    var reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Phones, and any short window (phone in landscape, tiny browser window): the panel becomes a full-screen sheet.
    var isMobile = function () { return window.matchMedia && matchMedia('(max-width: 600px), (max-height: 520px)').matches; };

    // ---- Tiny DOM helper ----
    function el(tag, cls, attrs) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
        return n;
    }

    // ---- Icons (inline SVG; no icon-font dependency) ----
    function glyph(cls) {
        var stripes = '';
        var d = [
            'M6 12a3 3 0 0 1 3-3h3v8a3 3 0 0 1-6 0Z',
            'M12 9h6v8a3 3 0 0 1-6 0Z', 'M18 9h6v8a3 3 0 0 1-6 0Z', 'M24 9h6v8a3 3 0 0 1-6 0Z', 'M30 9h6v8a3 3 0 0 1-6 0Z',
            'M36 9h3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0Z'
        ];
        d.forEach(function (p, i) { stripes += '<path fill="' + (i % 2 ? '#fff' : '#FFB038') + '" d="' + p + '"/>'; });
        return '<svg class="nexi-glyph ' + (cls || '') + '" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
            '<path fill="#fff" d="M9 22.2H39V33a4 4 0 0 1-4 4H26.5L20 42.6c-.5.4-1.2.1-1.2-.6V37H13a4 4 0 0 1-4-4Z"/>' + stripes +
            '<path class="nexi-spark" fill="#01B075" d="M24 24.2c.7 3.7 1.8 4.8 5.5 5.5-3.7.7-4.8 1.8-5.5 5.5-.7-3.7-1.8-4.8-5.5-5.5 3.7-.7 4.8-1.8 5.5-5.5Z"/>' +
            '<circle cx="32.4" cy="26.2" r="1.3" fill="#01B075" opacity=".85"/></svg>';
    }
    var ICON_UP = '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    var ICON_SEND = '<svg class="i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg><svg class="i-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
    var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>';
    var ICON_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>';

    // ---- Safe message rendering: DOM nodes only, a handful of formats, whitelisted links ----
    function textNode(t) { return document.createTextNode(t); }
    function inline(parent, text) {
        var re = /\*\*([^*\n]+)\*\*|\[([^\]\n]{1,80})\]\((\/[A-Za-z0-9\-_\/]*)\)/g, last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) parent.appendChild(textNode(text.slice(last, m.index)));
            if (m[1] !== undefined) {
                var b = el('strong'); b.textContent = m[1]; parent.appendChild(b);
            } else {
                var path = m[3].replace(/\/$/, '') || '/';
                if (ALLOWED_PATHS.indexOf(path) > -1) { var a = el('a'); a.href = m[3]; a.textContent = m[2]; parent.appendChild(a); }
                else parent.appendChild(textNode(m[2]));
            }
            last = re.lastIndex;
        }
        if (last < text.length) parent.appendChild(textNode(text.slice(last)));
    }
    function renderRich(target, text) {
        target.textContent = '';
        var list = null, para = null;
        String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
            var li = /^\s*(?:[-*\u2022]|\d+[.)])\s+(.*)$/.exec(line);
            if (li) {
                para = null;
                var tag = /^\s*\d+[.)]\s/.test(line) ? 'ol' : 'ul';
                if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); target.appendChild(list); }
                var item = el('li'); inline(item, li[1]); list.appendChild(item);
            } else if (!line.trim()) {
                list = null; para = null;
            } else {
                list = null;
                if (!para) { para = el('p'); target.appendChild(para); } else para.appendChild(el('br'));
                inline(para, line.trim());
            }
        });
    }

    function cardImageUrl(raw) {
        if (!raw) return '';
        var url = String(raw).slice(0, 500);
        try {
            if (typeof app !== 'undefined' && app && typeof app.resolveImageUrl === 'function') url = app.resolveImageUrl(url);
        } catch (e) { /* no app on safety.html */ }
        return /^(https?:\/\/|\/)/i.test(String(url || '')) ? String(url) : '';
    }

    function cardPath(item) {
        var path = '';
        try {
            if (typeof app !== 'undefined' && app) {
                if (item.type === 'product' && typeof app.productLink === 'function') path = app.productLink(item);
                else if (item.type === 'store' && typeof app.storeLink === 'function') path = app.storeLink(item);
            }
        } catch (e) { /* fall back below */ }
        if (!path) {
            if (item.type === 'product') path = item.id ? '/p/' + encodeURIComponent(item.id) : '/marketplace';
            else if (item.slug && /^[A-Za-z0-9-]+$/.test(item.slug)) path = '/' + item.slug;
            else path = '/marketplace';
        }
        return /^\/(?!\/)/.test(String(path)) ? String(path) : '/marketplace';
    }

    function localCurrency(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
        return 'UGX ' + String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function cardCurrency(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
        try {
            if (typeof app !== 'undefined' && app && typeof app.formatCurrency === 'function') return String(app.formatCurrency(value));
        } catch (e) { /* use local formatter */ }
        return localCurrency(value);
    }

    function addCardImage(parent, src, name, placeholderClass) {
        var box = el('div', 'nexi-card-media ' + placeholderClass + ' is-placeholder');
        var img = el('img', '', { loading: 'lazy', alt: '' });
        var placeholder = el('span', 'nexi-card-placeholder');
        if (placeholderClass === 'nexi-store-media') placeholder.textContent = String(name || '').trim().slice(0, 1).toUpperCase() || 'S';
        box.appendChild(placeholder);
        var resolved = cardImageUrl(src);
        if (resolved) {
            img.src = resolved;
            img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); box.classList.add('is-placeholder'); });
            box.appendChild(img);
            box.classList.remove('is-placeholder');
        }
        parent.appendChild(box);
    }

    function shareCard(item, button, status) {
        var path = cardPath(item);
        var url = location.origin + path;
        var name = String(item.name || 'NextaStore item').slice(0, 120);
        var title = name;
        var line = item.type === 'product' ? 'View this product on NextaStore.' : 'View this store on NextaStore.';
        if (navigator && typeof navigator.share === 'function') {
            try {
                Promise.resolve(navigator.share({ title: title, text: line, url: url })).catch(function (e) {
                    if (!e || e.name !== 'AbortError') { /* failed share is intentionally quiet */ }
                });
            } catch (e) { /* failed share is intentionally quiet */ }
            return;
        }
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
                Promise.resolve(navigator.clipboard.writeText(url)).then(function () {
                    status.textContent = 'Link copied';
                    window.setTimeout(function () { status.textContent = ''; }, 2000);
                }).catch(function () { button.hidden = true; });
            } catch (e) { button.hidden = true; }
            return;
        }
        button.hidden = true;
    }

    function renderCards(parent, cards) {
        var clean = cleanCards(cards);
        if (!clean) return;
        var wrap = el('div', 'nexi-cards', { role: 'list', 'aria-label': clean.kind === 'products' ? 'Products' : 'Stores' });
        clean.items.forEach(function (item) {
            var card = el('div', 'nexi-card', { role: 'listitem' });
            var main = el('div', 'nexi-card-main');
            if (item.type === 'product') {
                addCardImage(main, item.thumbnail, item.name, 'nexi-product-media');
                var info = el('div', 'nexi-card-info');
                var name = el('div', 'nexi-card-name'); name.textContent = item.name || 'Product'; info.appendChild(name);
                var price = cardCurrency(item.price);
                if (price) {
                    var prices = el('div', 'nexi-card-prices');
                    var current = el('span', 'nexi-card-price'); current.textContent = price; prices.appendChild(current);
                    if (typeof item.originalPrice === 'number' && Number.isFinite(item.originalPrice) && item.originalPrice > item.price) { var old = el('del', 'nexi-card-original'); old.textContent = cardCurrency(item.originalPrice); prices.appendChild(old); }
                    info.appendChild(prices);
                }
                if (item.storeName) { var store = el('div', 'nexi-card-muted'); store.textContent = item.storeName; info.appendChild(store); }
                main.appendChild(info);
            } else {
                addCardImage(main, item.logo, item.name, 'nexi-store-media');
                var sinfo = el('div', 'nexi-card-info');
                var sname = el('div', 'nexi-card-name'); sname.textContent = item.name || 'Store'; sinfo.appendChild(sname);
                if (item.district) { var district = el('div', 'nexi-card-muted'); district.textContent = item.district; sinfo.appendChild(district); }
                if (item.description) { var desc = el('div', 'nexi-card-description'); desc.textContent = item.description; sinfo.appendChild(desc); }
                main.appendChild(sinfo);
            }
            card.appendChild(main);
            var actions = el('div', 'nexi-card-actions');
            var path = cardPath(item);
            var open = el('a', 'nexi-card-open', { href: path, 'aria-label': 'Open ' + String(item.name || 'item').slice(0, 120) });
            open.textContent = 'Open'; open.setAttribute('target', '_self'); actions.appendChild(open);
            var share = el('button', 'nexi-card-share', { type: 'button', 'aria-label': 'Share ' + String(item.name || 'item').slice(0, 120) });
            share.textContent = 'Share';
            var canShare = typeof navigator.share === 'function' || (navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
            var status = null;
            if (canShare) {
                status = el('span', 'nexi-card-share-status', { 'aria-live': 'polite' });
                share.addEventListener('click', function () { shareCard(item, share, status); });
            } else {
                share.hidden = true;
            }
            actions.appendChild(share);
            if (status) actions.appendChild(status);
            card.appendChild(actions);
            wrap.appendChild(card);
        });
        parent.appendChild(wrap);
    }

    // ==================================================================
    // Core: state + conversation
    // ==================================================================
    var state = { messages: [], lang: 'en', pending: false, unread: false };
    var nextId = 1;
    var listeners = [];
    var controller = null;
    var starterData = null;

    function cleanCards(value) {
        if (!value || typeof value !== 'object') return null;
        var kind = value.kind === 'products' || value.kind === 'stores' ? value.kind : null;
        if (!kind || !Array.isArray(value.items)) return null;
        var items = [];
        var invalid = false;
        value.items.slice(0, 4).forEach(function (raw) {
            if (invalid) return;
            if (!raw || typeof raw !== 'object') { invalid = true; return; }
            var proto = Object.getPrototypeOf(raw);
            if (proto !== Object.prototype && proto !== null) { invalid = true; return; }
            if (raw.type !== kind.slice(0, -1)) { invalid = true; return; }
            var item = {};
            if (raw.id !== undefined && raw.id !== null) item.id = String(raw.id).slice(0, 500);
            if (raw.name !== undefined && raw.name !== null) item.name = String(raw.name).slice(0, 120);
            if (kind === 'products') {
                if (raw.thumbnail !== undefined && raw.thumbnail !== null) item.thumbnail = String(raw.thumbnail).slice(0, 500);
                if (raw.storeName !== undefined && raw.storeName !== null) item.storeName = String(raw.storeName).slice(0, 120);
                if (raw.storeSlug !== undefined && raw.storeSlug !== null) item.storeSlug = String(raw.storeSlug).slice(0, 500);
                if (typeof raw.price === 'number' && Number.isFinite(raw.price)) item.price = raw.price;
                if (typeof raw.originalPrice === 'number' && Number.isFinite(raw.originalPrice)) item.originalPrice = raw.originalPrice;
            } else {
                if (raw.slug !== undefined && raw.slug !== null) item.slug = String(raw.slug).slice(0, 500);
                if (raw.logo !== undefined && raw.logo !== null) item.logo = String(raw.logo).slice(0, 500);
                if (raw.district !== undefined && raw.district !== null) item.district = String(raw.district).slice(0, 120);
                if (raw.description !== undefined && raw.description !== null) item.description = String(raw.description).slice(0, 200);
            }
            if (!item.id && !item.name) return;
            item.type = raw.type;
            items.push(item);
        });
        if (invalid || !items.length) return null;
        return { kind: kind, query: value.query === undefined || value.query === null ? '' : String(value.query).slice(0, 500), items: items };
    }

    function emit(type) { listeners.slice().forEach(function (fn) { try { fn(type); } catch (e) { console.error('[nexi]', e); } }); }
    function save() {
        try {
            var keep = state.messages.filter(function (m) { return !m.streaming; }).slice(-KEEP).map(function (m) {
                var out = { id: m.id, role: m.role, text: m.text, parts: m.role === 'bot' ? (m.parts || [m.text]) : undefined, error: !!m.error, retry: m.retry || '', flag: m.flag || '', drift: !!m.drift };
                if (m.role === 'bot' && m.cards) out.cards = cleanCards(m.cards);
                return out;
            });
            sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: keep, lang: state.lang }));
        } catch (e) { /* storage blocked: the conversation just won't survive navigation */ }
    }
    function load() {
        try {
            var d = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
            if (!d || !Array.isArray(d.messages)) return;
            state.lang = d.lang === 'lg' ? 'lg' : 'en';
            state.messages = d.messages.filter(function (m) { return m && (m.role === 'user' || m.role === 'bot') && typeof m.text === 'string'; }).map(function (m) {
                var parts = m.role === 'bot' ? (Array.isArray(m.parts) ? m.parts.map(String) : [m.text]) : undefined;
                var cards = m.role === 'bot' ? cleanCards(m.cards) : null;
                return { id: nextId++, v: 0, role: m.role, text: m.text, parts: parts, cards: cards || undefined, error: !!m.error, retry: m.retry || '', flag: FLAG_TYPES.indexOf(m.flag) > -1 ? m.flag : '', drift: !!m.drift };
            });
            var last = state.messages[state.messages.length - 1];
            if (last && last.role === 'user') {
                // the page changed while Nexi was answering: offer a retry instead of silence
                state.messages.push({ id: nextId++, v: 0, role: 'bot', text: 'That answer was interrupted when the page changed.', parts: ['That answer was interrupted when the page changed.'], error: true, retry: last.text });
            }
        } catch (e) { /* ignore */ }
    }

    function addMessage(role, text, extra) {
        var m = { id: nextId++, v: 0, role: role, text: text || '' };
        if (role === 'bot') m.parts = [text || ''];
        if (extra) for (var k in extra) m[k] = extra[k];
        state.messages.push(m);
        return m;
    }
    function bump(m) { m.v += 1; }

    function friendlyError(status, serverMsg) {
        if (status === 429) return serverMsg || 'You are sending messages quickly. Please wait a moment.';
        if (status === 400 && serverMsg) return serverMsg;
        if (!status) return 'Connection lost. Tap to retry.';
        return serverMsg || 'Nexi could not connect right now.';
    }

    function authHeaders() {
        var token = '';
        try { token = localStorage.getItem('nextastore_token') || sessionStorage.getItem('nextastore_token') || ''; } catch (e) { /* ignore */ }
        return token ? { 'Authorization': 'Bearer ' + token } : {};
    }

    function historyForRequest(exclude) {
        return state.messages.filter(function (m) { return !m.error && !m.streaming && exclude.indexOf(m) === -1 && m.text; })
            .slice(-12).map(function (m) { return { role: m.role === 'bot' ? 'assistant' : 'user', content: m.text.slice(0, 2000) }; });
    }

    /** The assistant service flagged this turn (off-topic, abusive, private details ...): mark both bubbles. */
    function applyFlag(userMsg, botMsg, flag) {
        if (!flag || FLAG_TYPES.indexOf(flag.type) === -1) return;
        userMsg.flag = flag.type; botMsg.flag = flag.type; botMsg.drift = !!flag.conversation;
        bump(userMsg);
    }

    function send(raw, opts) {
        var text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
        if (!text || state.pending) return false;
        opts = opts || {};
        var userMsg = addMessage('user', text);
        var botMsg = addMessage('bot', '', { streaming: true });
        state.pending = true;
        save(); emit('change');

        var payload = {
            message: text,
            history: historyForRequest([userMsg, botMsg]),
            context: { audience: audience(), page: pageKey() }
        };
        var lang = opts.lang || (state.lang === 'lg' ? 'lg' : undefined);
        if (lang) payload.lang = lang;

        controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var idleTimer = null;
        function arm() { clearTimeout(idleTimer); if (controller) idleTimer = setTimeout(function () { controller.abort(); botMsg.timedOut = true; }, 90000); }

        function finish(err, status, serverMsg) {
            clearTimeout(idleTimer);
            botMsg.streaming = false;
            if (err) {
                if (botMsg.stopped) {
                    if (!botMsg.text) { state.messages.splice(state.messages.indexOf(botMsg), 1); }
                } else {
                    botMsg.error = true;
                    botMsg.parts = [friendlyError(status, serverMsg)];
                    botMsg.text = botMsg.parts[0];
                    botMsg.retry = (!status && !botMsg.timedOut) ? text : '';
                }
            }
            botMsg.parts = (botMsg.parts || [botMsg.text]).map(function (part) { return String(part || '').trim(); }).filter(Boolean);
            botMsg.text = botMsg.parts.join('\n\n');
            state.pending = false; controller = null;
            if (!err || !botMsg.stopped) { if (!panelOpen && !heroVisible()) { state.unread = true; } }
            bump(botMsg); save(); emit('change');
        }

        function readStream(res) {
            var reader = res.body.getReader(), decoder = new TextDecoder('utf-8'), buf = '', gotDone = false;
            function handle(line) {
                var ev; try { ev = JSON.parse(line); } catch (e) { return; }
                if (ev.type === 'token' && ev.text) {
                    botMsg.queued = 0;
                    if (!Array.isArray(botMsg.parts) || !botMsg.parts.length) botMsg.parts = [''];
                    botMsg.parts[botMsg.parts.length - 1] += ev.text;
                    botMsg.text = botMsg.parts.join('\n\n');
                    bump(botMsg); emit('token');
                } else if (ev.type === 'break') {
                    if (!Array.isArray(botMsg.parts)) botMsg.parts = [botMsg.text || ''];
                    botMsg.parts.push('');
                    botMsg.text = botMsg.parts.join('\n\n');
                    bump(botMsg); emit('token');
                } else if (ev.type === 'done') {
                    gotDone = true;
                    botMsg.parts = Array.isArray(ev.bubbles) ? ev.bubbles.map(String) : [typeof ev.reply === 'string' ? ev.reply : ''];
                    botMsg.text = botMsg.parts.join('\n\n');
                    if (ev.cards && !botMsg.cards) botMsg.cards = cleanCards(ev.cards);
                    bump(botMsg); applyFlag(userMsg, botMsg, ev.flag);
                } else if (ev.type === 'reset') {
                    botMsg.parts = []; botMsg.text = ''; botMsg.cards = undefined; bump(botMsg); emit('reset');
                } else if (ev.type === 'cards') {
                    botMsg.cards = cleanCards(ev);
                    bump(botMsg);
                } else if (ev.type === 'typing') {
                    /* delivery progress is represented by the current bubble state */
                } else if (ev.type === 'status') { /* thinking/translating are intentionally shown only as the normal typing state */ }
                else if (ev.type === 'error') { var er = new Error(ev.message || 'stream error'); if (ev.busy) { er.status = 429; er.serverMsg = ev.message; } throw er; }
            }
            function pump() {
                return reader.read().then(function (r) {
                    arm();
                    if (r.done) {
                        buf += decoder.decode();
                        if (buf.trim()) handle(buf.trim());
                        if (!gotDone && !botMsg.text) throw new Error('empty');
                        return;
                    }
                    buf += decoder.decode(r.value, { stream: true });
                    var i;
                    while ((i = buf.indexOf('\n')) !== -1) { var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
                    return pump();
                });
            }
            return pump();
        }

        function plainFallback() {
            return fetch(apiBase() + '/chat', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(payload), signal: controller ? controller.signal : undefined })
                .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) { var e = new Error('http'); e.status = res.status; e.serverMsg = j.message || j.error; throw e; } botMsg.parts = Array.isArray(j.bubbles) ? j.bubbles.map(String) : [j.reply || '']; botMsg.text = botMsg.parts.join('\n\n'); if (j.cards) botMsg.cards = cleanCards(j.cards); bump(botMsg); applyFlag(userMsg, botMsg, j.flag); }); });
        }

        arm();
        var base = apiBase();
        fetch(base + '/chat/stream', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' }, authHeaders()), body: JSON.stringify(payload), signal: controller ? controller.signal : undefined })
            .then(function (res) {
                if (!res.ok) {
                    return res.json().catch(function () { return {}; }).then(function (j) { var e = new Error('http'); e.status = res.status; e.serverMsg = j.message || j.error; throw e; });
                }
                if (!res.body || !res.body.getReader || typeof TextDecoder === 'undefined') return plainFallback();
                return readStream(res);
            })
            .then(function () { if (!botMsg.text) throw new Error('empty'); finish(null); })
            .catch(function (e) {
                if (botMsg.timedOut) return finish(e, 504);
                finish(e, e && e.status, e && e.serverMsg);
            });

        if (opts.source === 'hero' && heroEl && heroEl.scrollIntoView) heroEl.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
        return true;
    }

    function stop() {
        if (!controller) return;
        var last = state.messages[state.messages.length - 1];
        if (last && last.streaming) last.stopped = true;
        controller.abort();
    }
    function clearChat() {
        if (state.pending) stop();
        state.messages = []; state.unread = false;
        save(); emit('reset');
    }
    function retry(text) {
        // drop the failed exchange, then ask again
        var i = state.messages.length - 1;
        while (i >= 0 && (state.messages[i].error || state.messages[i].role === 'user') && i >= state.messages.length - 2) i -= 1;
        state.messages = state.messages.slice(0, i + 1);
        save(); emit('reset');
        send(text);
    }

    // ---- starters (can be refreshed from the assistant service, e.g. machine-translated Luganda) ----
    function startersFor(lang) {
        var set = (starterData && starterData[lang]) || STARTERS[lang] || STARTERS.en;
        var list = set[audience() === 'seller' ? 'seller' : 'guest'] || set.guest || [];
        return list.filter(function (s) { return typeof s === 'string' && s.length <= MAX_LEN; }).slice(0, 6);
    }
    function fetchStarters() {
        if (!window.fetch || !AbortSignal || !AbortSignal.timeout) return;
        fetch(apiBase() + '/starters', { signal: AbortSignal.timeout(4000) })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.en && d.lg && d.en.guest && d.lg.guest) { starterData = { en: d.en, lg: d.lg }; emit('starters'); }
            })
            .catch(function () { /* built-in starters are fine */ });
    }

    // ==================================================================
    // Views
    // ==================================================================
    function messageClass(m) {
        var cls = 'nexi-msg ' + (m.role === 'user' ? 'is-user' : 'is-bot') + (m.error ? ' is-error' : '');
        if (m.flag) cls += (m.role === 'user' ? ' is-flagged has-tag' : ' is-flag is-flag-' + m.flag);
        if (m.role === 'bot' && Array.isArray(m.parts) && m.parts.length > 1) cls += ' is-stack';
        return cls;
    }
    function bubbleNode(m) {
        var row = el('div', messageClass(m));
        if (m.role === 'user') {
            var userBubble = el('div', 'nexi-bubble is-new');
            fillBubble(userBubble, m, m.text, true);
            row.appendChild(userBubble);
        } else {
            var parts = Array.isArray(m.parts) ? m.parts : [m.text || ''];
            parts.forEach(function (part, i) {
                var b = el('div', 'nexi-bubble is-new');
                fillBubble(b, m, part, i === parts.length - 1);
                row.appendChild(b);
            });
        }
        syncFlagTag(row, m);
        return row;
    }
    function syncFlagTag(row, m) {
        var old = row.querySelector('.nexi-flagtag');
        if (m.role !== 'user' || !m.flag) { if (old) old.parentNode.removeChild(old); return; }
        if (!old) { old = el('span', 'nexi-flagtag'); row.appendChild(old); }
        old.textContent = FLAG_LABEL[m.flag] || 'Flagged';
    }
    function fillBubble(b, m, text, isLast) {
        b.textContent = '';
        if (m.streaming && !String(text || '').trim()) {
            b.innerHTML = '<span class="nexi-typing" role="status" aria-label="Nexi is typing"><i></i><i></i><i></i></span>';
            return;
        }
        if (m.role === 'user') { b.textContent = text || ''; return; }
        renderRich(b, text || '');
        if (!isLast || m.streaming) return;
        if (m.error && m.retry) {
            var r = el('button', 'nexi-retry', { type: 'button' });
            r.textContent = 'Retry connection';
            r.addEventListener('click', function () { retry(m.retry); });
            b.appendChild(r);
        }
        if (m.cards) renderCards(b, m.cards);
        if (m.flag) {
            if (m.drift) {
                var nc = el('button', 'nexi-retry nexi-newchat', { type: 'button' });
                nc.textContent = 'Start a new chat';
                nc.addEventListener('click', clearChat);
                b.appendChild(nc);
            } else if (SUGGEST_FOR.indexOf(m.flag) > -1) {
                var sg = el('div', 'nexi-suggest', { role: 'group', 'aria-label': 'Questions Nexi can help with' });
                startersFor(state.lang).slice(0, 3).forEach(function (q) {
                    var c = el('button', 'nexi-chip', { type: 'button' });
                    c.textContent = q;
                    c.addEventListener('click', function () { send(q, { lang: state.lang === 'lg' ? 'lg' : undefined }); });
                    sg.appendChild(c);
                });
                b.appendChild(sg);
            }
        }
    }
    function updateMessageNode(node, m) {
        node.className = messageClass(m);
        if (m.role === 'user') {
            var ub = node.querySelector('.nexi-bubble');
            if (!ub) { ub = el('div', 'nexi-bubble'); node.insertBefore(ub, node.firstChild); }
            fillBubble(ub, m, m.text, true);
        } else {
            var parts = Array.isArray(m.parts) ? m.parts : [m.text || ''];
            var bubbles = Array.prototype.slice.call(node.querySelectorAll('.nexi-bubble'));
            parts.forEach(function (part, i) {
                var b = bubbles[i];
                if (!b) {
                    b = el('div', 'nexi-bubble is-new');
                    node.appendChild(b);
                }
                fillBubble(b, m, part, i === parts.length - 1);
            });
            while (node.querySelectorAll('.nexi-bubble').length > parts.length) {
                var all = node.querySelectorAll('.nexi-bubble');
                all[all.length - 1].parentNode.removeChild(all[all.length - 1]);
            }
        }
        syncFlagTag(node, m);
    }

    /** Keeps a thread container in step with state.messages without rebuilding finished bubbles. */
    function syncThread(thread, nodes, opts) {
        opts = opts || {};
        var sc = opts.scroller || thread;
        var nearBottom = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 90;
        function writeScroll(value) {
            var saved = sc.style.scrollBehavior;
            sc.style.scrollBehavior = 'auto';
            sc.scrollTop = value;
            sc.style.scrollBehavior = saved;
        }
        var count = Object.keys(nodes).length;
        var ids = {};
        var cardsArrivedNode = null;
        state.messages.forEach(function (m) {
            ids[m.id] = true;
            var rec = nodes[m.id];
            if (!rec) {
                var node = bubbleNode(m);
                thread.appendChild(node);
                nodes[m.id] = { node: node, v: m.v, error: !!m.error, streaming: !!m.streaming, parts: Array.isArray(m.parts) ? m.parts.length : 0, cards: m.cards ? JSON.stringify(m.cards) : '' };
            } else if (rec.v !== m.v || rec.error !== !!m.error || rec.streaming !== !!m.streaming || rec.parts !== (Array.isArray(m.parts) ? m.parts.length : 0) || rec.cards !== (m.cards ? JSON.stringify(m.cards) : '')) {
                if (rec.cards === '' && m.cards) cardsArrivedNode = rec.node;
                updateMessageNode(rec.node, m);
                nodes[m.id] = { node: rec.node, v: m.v, error: !!m.error, streaming: !!m.streaming, parts: Array.isArray(m.parts) ? m.parts.length : 0, cards: m.cards ? JSON.stringify(m.cards) : '' };
            }
        });
        Object.keys(nodes).forEach(function (id) { if (!ids[id]) { if (nodes[id].node.parentNode) nodes[id].node.parentNode.removeChild(nodes[id].node); delete nodes[id]; } });
        if (!state.messages.length) writeScroll(0);
        else if (cardsArrivedNode && nearBottom && cardsArrivedNode.getBoundingClientRect().height > sc.clientHeight) {
            writeScroll(Math.max(0, sc.scrollTop + (cardsArrivedNode.getBoundingClientRect().top - sc.getBoundingClientRect().top) - 8));
        } else if (nearBottom || Object.keys(nodes).length > count) writeScroll(sc.scrollHeight);
    }

    function buildLang() {
        var wrap = el('div', 'nexi-lang', { role: 'group', 'aria-label': 'Chat language' });
        [['en', 'English'], ['lg', 'Luganda']].forEach(function (p) {
            var b = el('button', '', { type: 'button', 'data-lang': p[0] });
            b.textContent = p[1];
            b.addEventListener('click', function () { if (state.lang !== p[0]) { state.lang = p[0]; save(); emit('lang'); } });
            wrap.appendChild(b);
        });
        return wrap;
    }
    function buildComposer(source) {
        var form = el('form', 'nexi-composer', { autocomplete: 'off' });
        var ta = el('textarea', '', { rows: '1', maxlength: String(MAX_LEN), 'aria-label': 'Message Nexi', enterkeyhint: 'send' });
        var btn = el('button', 'nexi-send', { type: 'submit', 'aria-label': 'Send message' });
        btn.innerHTML = ICON_SEND;
        form.appendChild(ta); form.appendChild(btn);
        function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 112) + 'px'; }
        ta.addEventListener('input', grow);
        ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
        });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (state.pending) { stop(); return; }
            var v = ta.value;
            if (send(v, { source: source })) { ta.value = ''; grow(); }
        });
        return { form: form, ta: ta, btn: btn, grow: grow };
    }
    function buildStarters(source) {
        var box = el('div', 'nexi-starters', { role: 'group', 'aria-label': 'Conversation starters' });
        box.addEventListener('click', function (e) {
            var c = e.target.closest('.nexi-chip');
            if (!c || c.disabled) return;
            send(c.getAttribute('data-q'), { source: source, lang: state.lang === 'lg' ? 'lg' : undefined });
        });
        return box;
    }
    function wireStarterRow(box, row) {
        var prev = el('button', 'nexi-starters-arrow nexi-starters-arrow--prev', { type: 'button', 'aria-label': 'Previous questions' });
        var next = el('button', 'nexi-starters-arrow nexi-starters-arrow--next', { type: 'button', 'aria-label': 'More questions' });
        prev.textContent = '‹';
        next.textContent = '›';
        function update() {
            var max = Math.max(0, row.scrollWidth - row.clientWidth);
            var left = row.scrollLeft;
            prev.hidden = max <= 1 || left <= 1;
            next.hidden = max <= 1 || left >= max - 1;
        }
        function move(dir) {
            row.scrollBy({ left: dir * Math.max(1, row.clientWidth * 0.8), behavior: reducedMotion ? 'auto' : 'smooth' });
        }
        prev.addEventListener('click', function () { move(-1); });
        next.addEventListener('click', function () { move(1); });
        row.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        box.appendChild(prev); box.appendChild(row); box.appendChild(next);
        update();
    }
    function paintStarters(box, opts) {
        opts = opts || {};
        box.textContent = '';
        if (opts.label) { var lab = el('p', 'nexi-starters-label'); lab.textContent = STARTER_LABEL; box.appendChild(lab); }
        var row = el('div', 'nexi-starters-row');
        startersFor(state.lang).forEach(function (q) {
            var c = el('button', 'nexi-chip', { type: 'button', 'data-q': q });
            c.textContent = q;
            row.appendChild(c);
        });
        wireStarterRow(box, row);
        row.scrollLeft = 0;
        box.hidden = state.messages.length > 0;
    }
    function paintLang(wrap) {
        Array.prototype.forEach.call(wrap.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === state.lang)); });
    }
    function paintBusy(c) {
        c.btn.classList.toggle('is-busy', state.pending);
        c.btn.setAttribute('aria-label', state.pending ? 'Stop answering' : 'Send message');
        c.ta.placeholder = COPY[state.lang].placeholder;
    }

    // ---- Hero view ----
    var heroEl = null, heroIO = null, heroIn = false;
    function heroVisible() { return !!heroEl && heroIn; }

    function mountHero(host) {
        if (!host || host.getAttribute('data-nexi-mounted') || disabled()) return;
        host.setAttribute('data-nexi-mounted', '1');
        heroEl = host;
        host.textContent = '';

        var head = el('div', 'hero-chat-head');
        var av = el('span', 'nexi-avatar'); av.innerHTML = glyph('');
        var title = el('div', 'hero-chat-title'); title.innerHTML = '<strong></strong><span></span>';
        var clear = el('button', 'nexi-iconbtn', { type: 'button', 'aria-label': 'Start a new chat', title: 'New chat' }); clear.innerHTML = ICON_NEW; clear.hidden = true;
        var lang = buildLang();
        head.appendChild(av); head.appendChild(title); head.appendChild(lang); head.appendChild(clear);

        var thread = el('div', 'nexi-thread', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text', 'aria-label': 'Conversation with Nexi' });
        thread.hidden = true;
        var comp = buildComposer('hero');
        var starters = buildStarters('hero');
        var foot = el('p', 'nexi-foot'); foot.textContent = FOOT;
        host.appendChild(head); host.appendChild(thread); host.appendChild(starters); host.appendChild(comp.form); host.appendChild(foot);

        var nodes = {};
        var hero = host.closest('.marketplace-hero');
        clear.addEventListener('click', clearChat);

        function paint(type) {
            if (type === 'token') { syncThread(thread, nodes); return; }
            var c = COPY[state.lang];
            title.firstChild.textContent = c.title; title.lastChild.textContent = c.sub;
            paintLang(lang); paintBusy(comp); paintStarters(starters, { label: true });
            var chatting = state.messages.length > 0;
            thread.hidden = !chatting; clear.hidden = !chatting;
            if (hero) hero.classList.toggle('is-chatting', chatting);
            Array.prototype.forEach.call(starters.querySelectorAll('button'), function (b) { b.disabled = state.pending; });
            if (type === 'reset') { thread.textContent = ''; nodes = {}; }
            syncThread(thread, nodes);
        }
        listeners.push(paint);
        paint('init');

        if ('IntersectionObserver' in window) {
            heroIn = true; // the hero is at the top of the page; the observer corrects this if not
            heroIO = new IntersectionObserver(function (entries) {
                heroIn = entries[0].isIntersecting && entries[0].intersectionRatio > 0.12;
                updateFab();
            }, { threshold: [0, 0.12, 0.3, 1] });
            heroIO.observe(host);
        } else { heroIn = true; }
        ensureDock();
        updateFab();
    }

    // ---- Dock + panel ----
    var dock = null, fabSlot = null, fab = null, label = null, topBtn = null, ringBar = null, panel = null, panelOpen = false;
    var panelParts = null;

    function ensureDock() {
        if (dock || !document.body || disabled()) return;
        dock = el('div', 'nexi-dock', { id: 'nexiDock' });

        topBtn = el('button', 'nexi-top', { type: 'button', 'aria-label': 'Back to top' });
        topBtn.innerHTML = '<svg class="nexi-top-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="19"/><circle class="bar" cx="22" cy="22" r="19"/></svg>' + ICON_UP;
        ringBar = topBtn.querySelector('.bar');
        topBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' }); });

        fabSlot = el('div', 'nexi-fab-slot');
        fab = el('button', 'nexi-fab', { type: 'button', 'aria-label': 'Ask Nexi, the NextaStore assistant', 'aria-expanded': 'false', 'aria-controls': 'nexiPanel' });
        fab.innerHTML = glyph('') + '<svg class="nexi-x" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
        label = el('span', 'nexi-fab-label', { 'aria-hidden': 'true' });
        label.textContent = 'Ask Nexi';
        fab.addEventListener('click', toggle);
        fabSlot.appendChild(fab); fabSlot.appendChild(label);
        if (document.getElementById('heroChat')) fabSlot.classList.add('is-hidden'); // hero chat is the door on first view

        dock.appendChild(topBtn); dock.appendChild(fabSlot);
        document.body.appendChild(dock);

        listeners.push(function () { if (fab) fab.classList.toggle('has-unread', state.unread && !panelOpen); });

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', function () { onScroll(); syncAvoid(); applyMode(); });
        window.addEventListener('orientationchange', function () { setTimeout(applyMode, 250); });
        if (window.visualViewport) { window.visualViewport.addEventListener('resize', applyMode); window.visualViewport.addEventListener('scroll', applyMode); }
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen) { close(); } });
        document.addEventListener('click', function () { setTimeout(syncAvoid, 250); }, true);
        setInterval(function () { if (!document.hidden) syncAvoid(); }, 1000);
        window.addEventListener('pagehide', function () { document.documentElement.classList.remove('nexi-lock'); });
        onScroll(); syncAvoid(); updateFab();
    }

    var ticking = false;
    function onScroll() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () {
            ticking = false;
            if (!topBtn) return;
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
            topBtn.classList.toggle('is-visible', y > Math.max(480, window.innerHeight * 0.6));
            ringBar.style.strokeDashoffset = String(119.4 * (1 - Math.min(1, y / max)));
        });
    }

    var lastLift = 0, teaseTimer = null, fabEverShown = false;
    function syncAvoid() {
        if (!dock) return;
        var lift = 0, suppressed = !!document.querySelector(SUPPRESS);
        var vh = window.innerHeight;
        Array.prototype.forEach.call(document.querySelectorAll(AVOID), function (n) {
            var r = n.getBoundingClientRect();
            if (!r.width || !r.height) return;
            var cs = getComputedStyle(n);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (r.bottom >= vh - 110 && r.top < vh) lift = Math.max(lift, Math.round(vh - r.top - 8));
        });
        if (lift !== lastLift) { lastLift = lift; document.documentElement.style.setProperty('--nexi-lift', lift + 'px'); }
        dock.classList.toggle('is-suppressed', suppressed && !panelOpen);
    }

    function updateFab() {
        if (!fabSlot) return;
        var hide = heroVisible() && !panelOpen;
        fabSlot.classList.toggle('is-hidden', hide);
        if (!hide && !fabEverShown) {
            fabEverShown = true;
            var teased = false; try { teased = !!sessionStorage.getItem(TEASE_KEY); } catch (e) { /* ignore */ }
            if (!teased && !reducedMotion) {
                teaseTimer = setTimeout(function () {
                    if (panelOpen || !label) return;
                    label.classList.add('is-shown');
                    try { sessionStorage.setItem(TEASE_KEY, '1'); } catch (e) { /* ignore */ }
                    setTimeout(function () { label && label.classList.remove('is-shown'); }, 5000);
                }, 6000);
            }
        }
    }

    function buildPanel() {
        panel = el('section', 'nexi-panel', { id: 'nexiPanel', role: 'dialog', 'aria-label': 'Nexi, NextaStore assistant' });
        panel.inert = true;
        var head = el('div', 'nexi-panel-head');
        var av = el('span', 'nexi-avatar'); av.innerHTML = glyph('');
        var title = el('div', 'nexi-panel-title'); title.innerHTML = '<strong></strong><span></span>';
        var clear = el('button', 'nexi-iconbtn', { type: 'button', 'aria-label': 'Start a new chat', title: 'New chat' }); clear.innerHTML = ICON_NEW; clear.hidden = true;
        var min = el('button', 'nexi-iconbtn', { type: 'button', 'aria-label': 'Close assistant', title: 'Close' }); min.innerHTML = isMobile() ? ICON_X : ICON_MIN;
        head.appendChild(av); head.appendChild(title); head.appendChild(clear); head.appendChild(min);

        var lang = buildLang();
        var sub = el('div', 'nexi-panel-sub'); sub.appendChild(lang);
        // ONE scrolling area holds the conversation AND the starter questions, so the starters can never
        // squeeze the conversation to nothing (the old layout gave them their own un-scrollable block).
        var body = el('div', 'nexi-panel-body');
        var thread = el('div', 'nexi-thread', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text', 'aria-label': 'Conversation with Nexi' });
        var welcome = el('div', 'nexi-msg is-bot'); var wb = el('div', 'nexi-bubble'); welcome.appendChild(wb);
        thread.appendChild(welcome);
        var starters = buildStarters('panel');
        body.appendChild(thread);
        var comp = buildComposer('panel');
        var foot = el('p', 'nexi-foot'); foot.textContent = FOOT;
        var bottom = el('div', 'nexi-panel-bottom'); bottom.appendChild(starters); bottom.appendChild(comp.form); bottom.appendChild(foot);
        panel.appendChild(head); panel.appendChild(sub); panel.appendChild(body); panel.appendChild(bottom);
        document.body.appendChild(panel);

        var nodes = {};
        clear.addEventListener('click', clearChat);
        min.addEventListener('click', close);
        panelParts = { thread: thread, body: body, comp: comp, min: min };

        function paint(type) {
            if (type === 'token') { syncThread(thread, nodes, { scroller: body }); return; }
            var c = COPY[state.lang];
            title.firstChild.textContent = c.title; title.lastChild.textContent = c.sub;
            wb.textContent = c.welcome;
            welcome.hidden = state.messages.length > 0;
            clear.hidden = state.messages.length === 0;
            paintLang(lang); paintBusy(comp); paintStarters(starters, { label: true });
            Array.prototype.forEach.call(starters.querySelectorAll('button'), function (b) { b.disabled = state.pending; });
            if (type === 'reset') { Array.prototype.forEach.call(thread.querySelectorAll('.nexi-msg'), function (n) { if (n !== welcome) n.parentNode.removeChild(n); }); nodes = {}; }
            syncThread(thread, nodes, { scroller: body });
        }
        listeners.push(paint);
        paint('init');

        // keep Tab inside the panel while it is a full-screen sheet (phones)
        panel.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab' || !isMobile()) return;
            var f = panel.querySelectorAll('button:not([disabled]):not([hidden]), textarea, a[href]');
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    /**
     * Desktop floating window vs phone full-screen sheet. Re-run on open and whenever the window changes
     * (rotation, resizing, the on-screen keyboard), so the panel always fits the visible screen.
     */
    function applyMode() {
        if (!panel || !panelOpen) return;
        var sheet = isMobile();
        panel.setAttribute('aria-modal', sheet ? 'true' : 'false');
        document.documentElement.classList.toggle('nexi-lock', sheet);
        if (panelParts && panelParts.min) panelParts.min.innerHTML = sheet ? ICON_X : ICON_MIN;
        var vv = window.visualViewport;
        if (sheet && vv) {
            // the on-screen keyboard shrinks the VISUAL viewport, not the layout one: follow it so the
            // composer is never hidden behind the keyboard and the header never scrolls out of view
            panel.style.height = Math.round(vv.height) + 'px';
            panel.style.top = Math.round(vv.offsetTop) + 'px';
            panel.style.bottom = 'auto';
        } else { panel.style.height = ''; panel.style.top = ''; panel.style.bottom = ''; }
    }

    function open() {
        if (disabled()) return;
        ensureDock();
        if (!dock) return;
        if (!panel) buildPanel();
        panelOpen = true;
        state.unread = false; emit('change');
        panel.inert = false;
        panel.classList.add('is-open');
        dock.classList.add('has-panel');
        fab.setAttribute('aria-expanded', 'true');
        applyMode();
        label.classList.remove('is-shown');
        updateFab();
        // Phones: do not focus the box on open, or the keyboard would instantly cover the starter questions.
        if (!isMobile()) setTimeout(function () { try { panelParts.comp.ta.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
        panelParts.body.scrollTop = state.messages.length ? panelParts.body.scrollHeight : 0;
    }
    function close() {
        if (!panel || !panelOpen) return;
        panelOpen = false;
        panel.classList.remove('is-open');
        panel.inert = true;
        if (dock) dock.classList.remove('has-panel');
        fab.setAttribute('aria-expanded', 'false');
        document.documentElement.classList.remove('nexi-lock');
        panel.style.height = ''; panel.style.top = ''; panel.style.bottom = '';
        updateFab();
        try { fab.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    function toggle() { panelOpen ? close() : open(); }

    /** Programmatic: open the panel and ask something. */
    function ask(text) { open(); return send(text, { source: 'panel' }); }

    // ---- Boot ----
    load();
    function init() {
        if (disabled()) return;
        ensureDock();
        fetchStarters();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    window.NexiAssistant = { mountHero: mountHero, open: open, close: close, toggle: toggle, ask: ask, version: '56' };
})();
