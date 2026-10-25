/**
 * Splits a knowledge markdown file into retrievable chunks, one per
 * "## Heading" section. Keeping chunks section-sized (not paragraph-sized,
 * not whole-file-sized) is a deliberate middle ground: small enough that
 * retrieval is precise, big enough that each chunk is still a complete
 * thought the model can quote from without losing context.
 *
 * Convention for every knowledge file (see src/knowledge/*.md):
 *   # File title
 *   ## Section heading
 *   content...
 *   ## Another section heading
 *   content...
 *   aliases: another way to ask it | and another   (optional, indexed at a lower weight)
 */
function chunkMarkdown(filename, raw) {
    const lines = raw.split('\n');
    const chunks = [];
    let title = filename;
    let currentHeading = null;
    let buffer = [];
    let aliases = [];

    function flush() {
        const text = buffer.join('\n').trim();
        if (currentHeading && text) {
            chunks.push({
                source: filename,
                heading: currentHeading,
                text,
                aliases,
            });
        }
        buffer = [];
        aliases = [];
    }

    for (const line of lines) {
        const h1 = line.match(/^#\s+(.*)/);
        const h2 = line.match(/^##\s+(.*)/);
        if (h1) {
            title = h1[1].trim();
            continue;
        }
        if (h2) {
            flush();
            currentHeading = h2[1].trim();
            continue;
        }
        // WIP 97: optional `aliases: phrasing one | phrasing two` lines (natural and messy ways people ask
        // the question this section answers). Indexed with a lower weight, never shown to the model or the user.
        const al = line.match(/^aliases:\s*(.*)$/i);
        if (al) { aliases.push(...al[1].split(/[|;]/).map((x) => x.trim()).filter(Boolean)); continue; }
        buffer.push(line);
    }
    flush();

    return { title, chunks };
}

module.exports = { chunkMarkdown };
