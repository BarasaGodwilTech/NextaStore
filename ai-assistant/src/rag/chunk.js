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
 */
function chunkMarkdown(filename, raw) {
    const lines = raw.split('\n');
    const chunks = [];
    let title = filename;
    let currentHeading = null;
    let buffer = [];

    function flush() {
        const text = buffer.join('\n').trim();
        if (currentHeading && text) {
            chunks.push({
                source: filename,
                heading: currentHeading,
                text,
            });
        }
        buffer = [];
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
        buffer.push(line);
    }
    flush();

    return { title, chunks };
}

module.exports = { chunkMarkdown };
