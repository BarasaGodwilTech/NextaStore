/* Live preview card for the desktop Add/Edit Product page.
   Read-only: it only reads the form's own fields and photo gallery, so the
   existing validation, draft and edit code in product-form.js is untouched.
   The card is hidden by CSS below 1100px (phones and tablets keep the form as is). */
(function () {
    'use strict';
    var card = document.getElementById('pfPreview');
    if (!card) return;
    var wide = window.matchMedia('(min-width: 1100px)');
    var $ = function (id) { return document.getElementById(id); };
    var last = '';

    function money(n) {
        return (window.app && app.formatCurrency) ? app.formatCurrency(n) : 'UGX ' + Number(n).toLocaleString();
    }

    function update() {
        if (!wide.matches) return;
        var name = ($('productName').value || '').trim();
        var price = parseFloat($('productPrice').value);
        var orig = parseFloat($('productOriginalPrice').value);
        var cat = $('productCategory').value;
        var img = document.querySelector('#imageGallery .gallery-tile img');
        var src = img ? img.getAttribute('src') : '';
        var key = [name, price, orig, cat, src].join('|');
        if (key === last) return;
        last = key;

        var thumb = card.querySelector('.pf-preview-img');
        thumb.innerHTML = src ? '' : '<i class="fas fa-image" aria-hidden="true"></i>';
        if (src) { var im = new Image(); im.alt = ''; im.src = src; thumb.appendChild(im); }

        card.querySelector('.pf-preview-name').textContent = name || 'Your product name';
        card.querySelector('.pf-preview-name').classList.toggle('is-empty', !name);

        var catEl = card.querySelector('.pf-preview-cat');
        catEl.innerHTML = cat && window.NXCategories ? NXCategories.iconHTML(cat, 16) + '<span>' + NXCategories.escape(NXCategories.label(cat)) + '</span>' : '';

        var p = card.querySelector('.pf-preview-price');
        p.textContent = price >= 0 ? money(price) : 'UGX 0';
        var o = card.querySelector('.pf-preview-orig');
        var off = card.querySelector('.pf-preview-off');
        var hasDiscount = orig > price && price >= 0;
        o.hidden = off.hidden = !hasDiscount;
        if (hasDiscount) {
            o.textContent = money(orig);
            off.textContent = '-' + Math.round((1 - price / orig) * 100) + '%';
        }
    }

    /* Typing fires input/change; the edit page fills fields in code (no event)
       and the gallery redraws itself, so a cheap 400ms check covers those too. */
    document.addEventListener('input', update);
    document.addEventListener('change', update);
    setInterval(update, 400);
    wide.addEventListener ? wide.addEventListener('change', function () { last = ''; update(); }) : 0;
    update();
})();
