/**
 * NextaStore AI Assistant — drop-in widget.
 *
 * Usage (once you're ready to wire it into a page):
 *   <link rel="stylesheet" href="/assistant/assistant-widget.css">
 *   <script src="/assistant/assistant-widget.js"
 *           data-api-base="http://localhost:4100/api/assistant"></script>
 *
 * Or configure it in JS before the script loads:
 *   <script>window.NextaAssistantConfig = { apiBase: 'https://your-domain/api/assistant' };</script>
 *
 * This file only talks to YOUR assistant backend (never Ollama or any AI
 * vendor directly) — the backend is what talks to Ollama. Nothing here
 * needs an API key.
 *
 * It's deliberately a single self-contained IIFE with no build step and no
 * dependencies, matching how the rest of nextastore's frontend (js/main.js
 * etc.) works — drop it in a <script> tag and it just runs.
 */
(function () {
    'use strict';

    var scriptTag = document.currentScript;
    var cfg = Object.assign(
        {
            apiBase: 'http://localhost:4100/api/assistant',
            title: 'NextaStore Assistant',
            greeting: "Hi! I'm Nexi, the NextaStore assistant. Ask me anything about buying, selling, or your store — in English, Luganda, or Swahili.",
        },
        window.NextaAssistantConfig || {},
        scriptTag && scriptTag.dataset.apiBase ? { apiBase: scriptTag.dataset.apiBase } : {}
    );

    var history = []; // {role, content} pairs sent back to the API for short-term context
    var selectedLang = 'auto';
    var sending = false;

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'class') node.className = attrs[k];
            else if (k === 'html') node.innerHTML = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        (children || []).forEach(function (c) { node.appendChild(c); });
        return node;
    }

    function buildUI() {
        var root = el('div', { id: 'nexta-assistant-root' });

        var bubble = el('button', { class: 'na-bubble', 'aria-label': 'Open assistant', html: '💬' });

        var panel = el('div', { class: 'na-panel' });
        var header = el('div', { class: 'na-header' }, [
            el('div', { class: 'na-header-title', html: '<span class="na-dot"></span>' + cfg.title }),
        ]);
        var controls = el('div', { class: 'na-header-controls' });
        var langSelect = el('select', { class: 'na-lang-select', 'aria-label': 'Reply language' });
        [['auto', 'Auto'], ['en', 'English'], ['lg', 'Luganda'], ['sw', 'Swahili']].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt[0]; o.textContent = opt[1];
            langSelect.appendChild(o);
        });
        langSelect.addEventListener('change', function () { selectedLang = langSelect.value; });
        var closeBtn = el('button', { class: 'na-close', 'aria-label': 'Close', html: '&times;' });
        controls.appendChild(langSelect);
        controls.appendChild(closeBtn);
        header.appendChild(controls);

        var messages = el('div', { class: 'na-messages' });

        var inputRow = el('div', { class: 'na-input-row' });
        var input = el('textarea', { class: 'na-input', rows: '1', placeholder: 'Type a message...' });
        var sendBtn = el('button', { class: 'na-send', 'aria-label': 'Send', html: '&#10148;' });
        inputRow.appendChild(input);
        inputRow.appendChild(sendBtn);

        panel.appendChild(header);
        panel.appendChild(messages);
        panel.appendChild(inputRow);
        root.appendChild(panel);
        root.appendChild(bubble);
        document.body.appendChild(root);

        return { root: root, bubble: bubble, panel: panel, messages: messages, input: input, sendBtn: sendBtn, closeBtn: closeBtn };
    }

    function addMessage(container, role, text, meta) {
        var bubbleEl = el('div', { class: 'na-msg na-msg-' + role });
        bubbleEl.textContent = text;
        container.appendChild(bubbleEl);
        if (meta) {
            var metaEl = el('div', { class: 'na-msg-meta' });
            metaEl.textContent = meta;
            container.appendChild(metaEl);
        }
        container.scrollTop = container.scrollHeight;
        return bubbleEl;
    }

    async function sendMessage(ui) {
        var text = ui.input.value.trim();
        if (!text || sending) return;
        sending = true;
        ui.sendBtn.disabled = true;
        ui.input.value = '';

        addMessage(ui.messages, 'user', text);
        var typing = el('div', { class: 'na-typing' });
        typing.textContent = 'Nexi is typing...';
        ui.messages.appendChild(typing);
        ui.messages.scrollTop = ui.messages.scrollHeight;

        try {
            var res = await fetch(cfg.apiBase + '/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    history: history,
                    lang: selectedLang === 'auto' ? undefined : selectedLang,
                }),
            });
            if (!res.ok) throw new Error('Request failed: ' + res.status);
            var data = await res.json();

            typing.remove();
            addMessage(ui.messages, 'assistant', data.reply, data.language ? ('via ' + data.language.label) : null);

            history.push({ role: 'user', content: text });
            history.push({ role: 'assistant', content: data.reply });
            // Keep the client-side copy bounded; the server also trims its side.
            if (history.length > 20) history = history.slice(-20);
        } catch (err) {
            typing.remove();
            addMessage(
                ui.messages,
                'assistant',
                "Sorry — I can't reach the assistant service right now. Please try again in a moment, or use Messages / support for anything urgent."
            );
            console.error('[nexta-assistant]', err);
        } finally {
            sending = false;
            ui.sendBtn.disabled = false;
        }
    }

    function init() {
        var ui = buildUI();
        var open = false;

        function setOpen(v) {
            open = v;
            ui.panel.classList.toggle('na-open', open);
            if (open) ui.input.focus();
        }

        ui.bubble.addEventListener('click', function () { setOpen(!open); });
        ui.closeBtn.addEventListener('click', function () { setOpen(false); });
        ui.sendBtn.addEventListener('click', function () { sendMessage(ui); });
        ui.input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(ui);
            }
        });

        addMessage(ui.messages, 'assistant', cfg.greeting);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
