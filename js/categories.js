/* NextaStore shared category list (WIP 44).
 *
 * ONE place for category ids, labels, icons, groups and listing kinds. Used by the
 * marketplace tiles, the category pickers (product form + dashboard), the store page
 * and the product page. Load js/category-sprite.js BEFORE this file so the icons exist.
 *
 * Ids are stored on products, so NEVER rename or remove one - add new ones instead.
 * The first seven legacy ids (clothing, accessories, food, home, electronics, crafts,
 * other) keep working exactly as before. The backend accepts any id up to 40 chars,
 * so adding a category here needs no migration.
 *
 * kind: 'product' | 'service' | 'digital' - groundwork for listing types; nothing
 * reads it yet except the picker's group headings.
 * Order of CATEGORIES = order of the marketplace tiles (most common first).
 */
(function () {
    'use strict';

    // Dropdown group headings, in display order.
    var GROUPS = [
        'Fashion & beauty',
        'Phones & electronics',
        'Home & family',
        'Food & farm',
        'Health & sport',
        'Vehicles & property',
        'Building & business',
        'Books, music & gifts',
        'Services',
        'Digital',
        'Other'
    ];

    // [id, label, short tile label, group, kind]
    var RAW = [
        ['clothing',      'Clothing',              'Clothing',    'Fashion & beauty',     'product'],
        ['phones',        'Phones & Tablets',      'Phones',      'Phones & electronics', 'product'],
        ['electronics',   'Electronics',           'Electronics', 'Phones & electronics', 'product'],
        ['shoes',         'Shoes',                 'Shoes',       'Fashion & beauty',     'product'],
        ['food',          'Food & Drinks',         'Food',        'Food & farm',          'product'],
        ['home',          'Home & Living',         'Home',        'Home & family',        'product'],
        ['vehicles',      'Vehicles & Parts',      'Vehicles',    'Vehicles & property',  'product'],
        ['beauty',        'Beauty & Care',         'Beauty',      'Fashion & beauty',     'product'],
        ['accessories',   'Accessories',           'Accessories', 'Fashion & beauty',     'product'],
        ['appliances',    'Appliances',            'Appliances',  'Phones & electronics', 'product'],
        ['farm',          'Farm & Agriculture',    'Farm',        'Food & farm',          'product'],
        ['property',      'Property',              'Property',    'Vehicles & property',  'product'],
        ['baby',          'Baby & Kids',           'Baby & Kids', 'Home & family',        'product'],
        ['health',        'Health Products',       'Health',      'Health & sport',       'product'],
        ['sports',        'Sports & Outdoors',     'Sports',      'Health & sport',       'product'],
        ['construction',  'Building Materials',    'Building',    'Building & business',  'product'],
        ['commercial',    'Business Equipment',    'Equipment',   'Building & business',  'product'],
        ['crafts',        'Arts & Crafts',         'Crafts',      'Books, music & gifts', 'product'],
        ['gifts',         'Gifts & Flowers',       'Gifts',       'Books, music & gifts', 'product'],
        ['books',         'Books & Stationery',    'Books',       'Books, music & gifts', 'product'],
        ['music',         'Music & Instruments',   'Music',       'Books, music & gifts', 'product'],
        ['pets',          'Pets',                  'Pets',        'Home & family',        'product'],
        ['home_services', 'Home Services',         'Home Services', 'Services',           'service'],
        ['repairs',       'Repairs',               'Repairs',     'Services',             'service'],
        ['salon',         'Salon & Barber',        'Salon',       'Services',             'service'],
        ['events',        'Events & Catering',     'Events',      'Services',             'service'],
        ['creative',      'Creative Services',     'Creative',    'Services',             'service'],
        ['transport',     'Transport & Delivery',  'Transport',   'Services',             'service'],
        ['education',     'Education & Tutoring',  'Education',   'Services',             'service'],
        ['wellness',      'Wellness & Fitness',    'Wellness',    'Services',             'service'],
        ['business',      'Business Services',     'Business',    'Services',             'service'],
        ['tech',          'Tech Services',         'Tech',        'Services',             'service'],
        ['travel',        'Travel & Tours',        'Travel',      'Services',             'service'],
        ['digital',       'Digital Products',      'Digital',     'Digital',              'digital'],
        ['other',         'Other',                 'Other',       'Other',                'product']
    ];

    var CATEGORIES = RAW.map(function (r) {
        return { id: r[0], label: r[1], short: r[2], group: r[3], kind: r[4], icon: 'c-' + r[0] };
    });
    var BY_ID = {};
    CATEGORIES.forEach(function (c) { BY_ID[c.id] = c; });

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function get(id) { return BY_ID[String(id || '').toLowerCase()] || null; }

    /** Display name. Unknown / legacy ids get a readable fallback instead of the raw id. */
    function label(id) {
        var c = get(id);
        if (c) return c.label;
        var key = String(id || '');
        return key ? key.replace(/[-_]+/g, ' ').replace(/^./, function (ch) { return ch.toUpperCase(); }) : 'General';
    }

    function shortLabel(id) { var c = get(id); return c ? c.short : label(id); }
    function kind(id) { var c = get(id); return c ? c.kind : 'product'; }

    /** Inline <svg><use> for a category (or a UI icon id such as 'trending', 'sell', 'all'). */
    function iconHTML(id, size) {
        var key = String(id || '').toLowerCase();
        var known = BY_ID[key] || key === 'trending' || key === 'sell' || key === 'all';
        var sym = 'c-' + (known ? key : 'other');
        var px = size || 20;
        return '<svg class="nx-cat-icon" width="' + px + '" height="' + px + '" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><use href="#' + sym + '"></use></svg>';
    }

    /** Categories grouped for dropdowns: [{ group, items: [category] }] in GROUPS order. */
    function grouped() {
        return GROUPS.map(function (g) {
            return { group: g, items: CATEGORIES.filter(function (c) { return c.group === g; }) };
        }).filter(function (g) { return g.items.length; });
    }

    /** Put the icon sprite in the page once. Safe to call repeatedly. */
    function injectSprite() {
        if (document.getElementById('nxCategorySpriteHost')) return;
        if (!window.NX_CATEGORY_SPRITE || !document.body) return;
        var host = document.createElement('div');
        host.id = 'nxCategorySpriteHost';
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        host.innerHTML = window.NX_CATEGORY_SPRITE;
        document.body.insertBefore(host, document.body.firstChild);
    }

    /** Replace a <select>'s category options with the shared list (grouped). Options with an
     *  empty value (the "All categories" / "Select a category" prompts) are kept in place. */
    function populateSelect(select) {
        if (!select) return;
        var keep = Array.prototype.filter.call(select.children, function (el) {
            return el.tagName === 'OPTION' && el.value === '';
        });
        var current = select.value;
        select.innerHTML = '';
        keep.forEach(function (o) { select.appendChild(o); });
        grouped().forEach(function (g) {
            var og = document.createElement('optgroup');
            og.label = g.group;
            g.items.forEach(function (c) {
                var o = document.createElement('option');
                o.value = c.id;
                o.textContent = c.label;
                og.appendChild(o);
            });
            select.appendChild(og);
        });
        if (current) select.value = current;
    }

    window.NXCategories = {
        list: CATEGORIES,
        groups: GROUPS,
        get: get,
        label: label,
        shortLabel: shortLabel,
        kind: kind,
        iconHTML: iconHTML,
        grouped: grouped,
        injectSprite: injectSprite,
        populateSelect: populateSelect,
        escape: esc
    };

    if (document.body) injectSprite();
    else document.addEventListener('DOMContentLoaded', injectSprite);
})();
