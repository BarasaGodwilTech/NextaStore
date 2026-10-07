/* Category picker (WIP 44) - turns <select data-nx-category> into an icon dropdown.
 *
 * The native <select> stays in the DOM as the source of truth, so existing code that
 * reads select.value, sets select.value = '...', listens for 'change', or toggles
 * .input-error keeps working untouched. Only the look changes. If JS fails, the page
 * falls back to the plain native select.
 *
 * Needs js/categories.js (and js/category-sprite.js for the icons).
 */
(function () {
    'use strict';
    if (!window.NXCategories) return;
    var C = window.NXCategories;
    var uid = 0;

    function enhance(select) {
        if (select.dataset.nxEnhanced) return;
        select.dataset.nxEnhanced = '1';
        C.populateSelect(select);

        var id = 'nxcp' + (++uid);
        var wrap = document.createElement('div');
        wrap.className = 'nx-catpick' + (select.classList.contains('form-select-sm') ? ' is-sm' : '');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nx-catpick-btn form-select';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', id + '-list');
        var list = document.createElement('div');
        list.className = 'nx-catpick-list';
        list.id = id + '-list';
        list.setAttribute('role', 'listbox');
        list.tabIndex = -1;
        list.hidden = true;

        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(btn);
        wrap.appendChild(list);
        wrap.appendChild(select);
        select.classList.add('nx-catpick-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');

        var options = []; // { value, el, text }
        function build() {
            list.innerHTML = '';
            options = [];
            var cur = select.firstElementChild;
            function addOption(opt, parent) {
                // The disabled "Select a category" prompt is only the button's placeholder, not a choice.
                if (opt.value === '' && opt.disabled) return;
                var el = document.createElement('div');
                el.className = 'nx-catpick-opt';
                el.setAttribute('role', 'option');
                el.id = id + '-o' + options.length;
                el.dataset.value = opt.value;
                var isPrompt = opt.value === '';
                el.innerHTML = (isPrompt ? '' : C.iconHTML(opt.value, 22)) +
                    '<span>' + C.escape(opt.textContent) + '</span>';
                parent.appendChild(el);
                options.push({ value: opt.value, el: el, text: opt.textContent.toLowerCase(), disabled: false });
            }
            for (; cur; cur = cur.nextElementSibling) {
                if (cur.tagName === 'OPTION') addOption(cur, list);
                else if (cur.tagName === 'OPTGROUP') {
                    var g = document.createElement('div');
                    g.setAttribute('role', 'group');
                    g.setAttribute('aria-label', cur.label);
                    var h = document.createElement('div');
                    h.className = 'nx-catpick-group';
                    h.setAttribute('aria-hidden', 'true');
                    h.textContent = cur.label;
                    g.appendChild(h);
                    Array.prototype.forEach.call(cur.children, function (o) { addOption(o, g); });
                    list.appendChild(g);
                }
            }
        }

        function refresh() {
            var v = select.value;
            var sel = options.filter(function (o) { return o.value === v; })[0];
            var shown = sel && v !== '' ? sel : null;
            var promptEl = select.querySelector('option[value=""]');
            btn.innerHTML = (shown ? C.iconHTML(shown.value, 22) : '') +
                '<span class="nx-catpick-text' + (shown || !(promptEl && promptEl.disabled) ? '' : ' is-placeholder') + '">' +
                C.escape(shown ? C.label(shown.value) : (promptEl ? promptEl.textContent : 'Select a category')) +
                '</span><i class="fas fa-chevron-down nx-catpick-caret" aria-hidden="true"></i>';
            options.forEach(function (o) {
                var on = o.value === v;
                o.el.setAttribute('aria-selected', on ? 'true' : 'false');
                o.el.classList.toggle('is-selected', on);
            });
            btn.disabled = select.disabled;
        }

        // Existing code sets select.value = x without firing events, so wrap the property.
        var proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        Object.defineProperty(select, 'value', {
            configurable: true,
            get: function () { return proto.get.call(select); },
            set: function (v) { proto.set.call(select, v); refresh(); }
        });
        // Label clicks / scroll-to-error call select.focus() - send it to the visible button.
        select.focus = function () { btn.focus.apply(btn, arguments); };
        // A <label for> click focuses the hidden native select internally (not via .focus()), so hand it on.
        select.addEventListener('focus', function () { btn.focus(); });

        // Mirror the native select's invalid styling and aria state onto the button.
        function mirror() {
            btn.classList.toggle('input-error', select.classList.contains('input-error'));
            var inv = select.getAttribute('aria-invalid');
            if (inv) btn.setAttribute('aria-invalid', inv); else btn.removeAttribute('aria-invalid');
            var d = select.getAttribute('aria-describedby');
            if (d) btn.setAttribute('aria-describedby', d);
            btn.disabled = select.disabled;
        }
        new MutationObserver(mirror).observe(select, { attributes: true, attributeFilter: ['class', 'aria-invalid', 'aria-describedby', 'disabled'] });
        mirror();
        var lab = select.id && document.querySelector('label[for="' + select.id + '"]');
        if (lab) { if (!lab.id) lab.id = id + '-label'; btn.setAttribute('aria-labelledby', lab.id + ' ' + (btn.id = btn.id || id + '-btn')); list.setAttribute('aria-labelledby', lab.id); }

        var active = -1;
        function enabled() { return options.filter(function (o) { return !o.disabled; }); }
        function setActive(o) {
            options.forEach(function (x) { x.el.classList.remove('is-active'); });
            if (!o) { active = -1; list.removeAttribute('aria-activedescendant'); return; }
            active = options.indexOf(o);
            o.el.classList.add('is-active');
            list.setAttribute('aria-activedescendant', o.el.id);
            o.el.scrollIntoView({ block: 'nearest' });
        }
        function isOpen() { return !list.hidden; }
        function open() {
            if (btn.disabled || isOpen()) return;
            list.hidden = false;
            wrap.classList.add('is-open');
            btn.setAttribute('aria-expanded', 'true');
            var cur = options.filter(function (o) { return o.value === select.value && !o.disabled; })[0] || enabled()[0];
            setActive(cur);
            list.focus({ preventScroll: true });
            // On phones the list is a bottom sheet; flip up near the screen bottom on desktop.
            var r = btn.getBoundingClientRect();
            wrap.classList.toggle('opens-up', window.innerWidth > 640 && (window.innerHeight - r.bottom) < 300 && r.top > 320);
        }
        function close(focusBtn) {
            if (!isOpen()) return;
            list.hidden = true;
            wrap.classList.remove('is-open', 'opens-up');
            btn.setAttribute('aria-expanded', 'false');
            if (focusBtn) btn.focus();
        }
        function choose(o) {
            if (!o || o.disabled) return;
            var changed = select.value !== o.value;
            select.value = o.value;
            close(true);
            if (changed) {
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        function move(delta) {
            var en = enabled();
            if (!en.length) return;
            var i = en.indexOf(options[active]);
            setActive(en[Math.max(0, Math.min(en.length - 1, (i < 0 ? 0 : i + delta)))]);
        }
        var typed = '', typedTimer;
        function typeahead(ch) {
            clearTimeout(typedTimer);
            typed += ch.toLowerCase();
            typedTimer = setTimeout(function () { typed = ''; }, 600);
            var hit = enabled().filter(function (o) { return o.text.indexOf(typed) === 0; })[0];
            if (hit) { if (!isOpen()) open(); setActive(hit); }
        }

        btn.addEventListener('click', function () { isOpen() ? close(false) : open(); });
        btn.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(e.key);
        });
        list.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Home') { e.preventDefault(); setActive(enabled()[0]); }
            else if (e.key === 'End') { e.preventDefault(); var en = enabled(); setActive(en[en.length - 1]); }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
            else if (e.key === 'Tab') close(false);
            else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(e.key);
        });
        list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the list
        list.addEventListener('click', function (e) {
            var el = e.target.closest('.nx-catpick-opt');
            if (!el) return;
            choose(options.filter(function (o) { return o.el === el; })[0]);
        });
        list.addEventListener('mousemove', function (e) {
            var el = e.target.closest('.nx-catpick-opt');
            var o = el && options.filter(function (x) { return x.el === el; })[0];
            if (o && !o.disabled && options.indexOf(o) !== active) setActive(o);
        });
        document.addEventListener('mousedown', function (e) { if (isOpen() && (!wrap.contains(e.target) || e.target === wrap)) close(false); });
        document.addEventListener('touchstart', function (e) { if (isOpen() && (!wrap.contains(e.target) || e.target === wrap)) close(false); }, { passive: true });
        list.addEventListener('focusout', function (e) { if (isOpen() && !wrap.contains(e.relatedTarget)) close(false); });
        // Programmatic resets (form.reset(), option rewrites) keep the button in step.
        if (select.form) select.form.addEventListener('reset', function () { setTimeout(refresh, 0); });
        select.addEventListener('change', refresh);

        build();
        refresh();
    }

    function init(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('select[data-nx-category]'), enhance);
    }
    window.NXCategoryPicker = { init: init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
    else init();
})();
