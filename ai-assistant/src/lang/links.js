/**
 * Keeps markdown links like [Open a store](/signup) safe while text goes through a
 * translator: they are swapped for opaque tokens before translation and put back after.
 * (Moved here from the removed hosted-translation module so the local translator keeps working.)
 */

/** Swap markdown links for opaque tokens so translation can't corrupt paths. */
function protectLinks(text) {
    const links = [];
    const out = text.replace(/\[([^\]]{1,80})\]\((\/[A-Za-z0-9\-_/]*)\)/g, (m) => {
        links.push(m);
        return `⟦${links.length - 1}⟧`;
    });
    return { out, links };
}

function restoreLinks(text, links) {
    let res = text;
    const used = new Set();
    links.forEach((l, i) => {
        const re = new RegExp(`⟦\\s*${i}\\s*⟧`);
        if (re.test(res)) { res = res.replace(re, l); used.add(i); }
    });
    const missing = links.filter((_, i) => !used.has(i));
    if (missing.length) res += `\n${missing.join(' · ')}`;
    return res;
}

module.exports = { protectLinks, restoreLinks };
