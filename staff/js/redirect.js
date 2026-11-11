/* Clean-URL stub: /staff/invite and /staff/reset forward to the real page and keep the ?token= query. */
(function () {
    'use strict';
    var s = document.currentScript, target = s && s.getAttribute('data-target');
    if (target) location.replace(target + location.search);
})();
