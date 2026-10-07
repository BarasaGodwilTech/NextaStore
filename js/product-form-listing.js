/* Add/Edit Product: shows only the fields that fit what is being listed.
   Physical = price + stock. Service = starting price + area + duration, no stock.
   Digital = price, no stock. Shoppers enquire about services and digital items
   through Messages (see README "Listing types"). product-form.js dispatches a
   'change' on #productListingType after it fills the form for editing. */
(function () {
    'use strict';
    var sel = document.getElementById('productListingType');
    if (!sel) return;
    var $ = function (id) { return document.getElementById(id); };
    var hints = {
        physical: 'Shoppers add it to their cart and you track stock.',
        service: 'Shoppers message you to agree the details. There is no cart or stock for services.',
        digital: 'Shoppers message you to arrange it. There is no cart or stock for digital items.'
    };
    function apply() {
        var t = sel.value || 'physical';
        $('serviceFields').hidden = t !== 'service';
        $('inventoryCard').hidden = t !== 'physical';
        $('priceLabelText').textContent = t === 'service' ? 'Starting price (UGX)' : 'Price (UGX)';
        $('listingTypeHint').textContent = hints[t];
    }
    sel.addEventListener('change', apply);
    apply();
})();
