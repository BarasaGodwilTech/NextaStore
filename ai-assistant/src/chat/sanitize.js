/** Validates/cleans the browser-supplied chat body. Never trust the client's roles. */
const MAX_MESSAGE = 600;
const MAX_HISTORY = 12;
const MAX_HISTORY_CONTENT = 2000;

function sanitizeChatBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) return { error: 'message (non-empty string) is required' };
    if (message.length > MAX_MESSAGE) return { error: `message is too long (max ${MAX_MESSAGE} characters)` };

    const history = (Array.isArray(b.history) ? b.history : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_HISTORY_CONTENT) }));

    const lang = ['en', 'lg', 'sw'].includes(b.lang) ? b.lang : undefined;

    const c = b.context && typeof b.context === 'object' ? b.context : {};
    const context = {
        audience: ['guest', 'buyer', 'seller'].includes(c.audience) ? c.audience : 'guest',
        page: typeof c.page === 'string' && /^[a-z0-9-]{1,30}$/.test(c.page) ? c.page : 'other',
    };
    return { value: { message, history, lang, context } };
}

module.exports = { sanitizeChatBody, MAX_MESSAGE };
