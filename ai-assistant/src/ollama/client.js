/**
 * Thin wrapper around the local Ollama HTTP API. This is the ONLY file in
 * the whole assistant that knows Ollama's request/response shapes — if
 * Ollama's API ever changes, or you swap it for LM Studio / llama.cpp
 * server / vLLM later, this is the only file that needs to change.
 *
 * No API keys, no external hosts. `config.ollamaHost` defaults to
 * http://127.0.0.1:11434, which is where Ollama listens by default.
 */

const config = require('../config');

async function ensureOk(res, context) {
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
            `Ollama request failed (${context}): ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
        );
    }
}

/**
 * Non-streaming chat completion.
 * @param {{role: 'system'|'user'|'assistant', content: string}[]} messages
 * @param {{temperature?: number, model?: string}} [opts]
 * @returns {Promise<string>} the assistant's reply text
 */
async function chat(messages, opts = {}) {
    const res = await fetch(`${config.ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: opts.model || config.chatModel,
            messages,
            stream: false,
            keep_alive: config.keepAlive,
            options: {
                temperature: opts.temperature ?? 0.3,
                num_ctx: opts.numCtx ?? config.numCtx,
                num_predict: opts.numPredict ?? config.maxReplyTokens,
            },
        }),
        signal: opts.signal,
    });
    await ensureOk(res, 'chat');
    const data = await res.json();
    if (config.debug) console.log('[assistant] ollama chat metrics', JSON.stringify({
        prompt_eval_count: data?.prompt_eval_count ?? null,
        prompt_chars: messages.reduce((n, m) => n + String(m.content || '').length, 0),
        num_ctx: opts.numCtx ?? config.numCtx,
    }));
    return data?.message?.content ?? '';
}

/**
 * Streaming chat completion. Calls onToken(chunk) as text arrives and
 * resolves with the full reply once done. Ollama streams newline-delimited
 * JSON objects, not SSE, so we parse it ourselves.
 */
async function chatStream(messages, onToken, opts = {}) {
    const res = await fetch(`${config.ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: opts.model || config.chatModel,
            messages,
            stream: true,
            keep_alive: config.keepAlive,
            options: {
                temperature: opts.temperature ?? 0.3,
                num_ctx: opts.numCtx ?? config.numCtx,
                num_predict: opts.numPredict ?? config.maxReplyTokens,
            },
        }),
        signal: opts.signal,
    });
    await ensureOk(res, 'chat-stream');

    let full = '';
    let buffer = '';
    let promptEvalCount = null;
    // TextDecoder in streaming mode so multi-byte characters (e.g. Luganda ŋ,
    // emoji) split across network chunks are not corrupted.
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            const parsed = JSON.parse(line);
            if (parsed?.prompt_eval_count != null) promptEvalCount = parsed.prompt_eval_count;
            const piece = parsed?.message?.content;
            if (piece) {
                full += piece;
                onToken(piece);
            }
        }
    }
    if (config.debug) console.log('[assistant] ollama stream metrics', JSON.stringify({
        prompt_eval_count: promptEvalCount,
        prompt_chars: messages.reduce((n, m) => n + String(m.content || '').length, 0),
        num_ctx: opts.numCtx ?? config.numCtx,
    }));
    return full;
}

/**
 * Embeds a single string into a vector. Only used when RETRIEVAL=hybrid (the default keyword
 * search needs no embedding model). bge-m3 is multilingual, which helps Luganda/Swahili/French queries.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
    const res = await fetch(`${config.ollamaHost}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.embedModel, prompt: text }),
    });
    await ensureOk(res, 'embeddings');
    const data = await res.json();
    return data.embedding;
}

/** Quick reachability + model-presence check, used by /health and the setup script. */
async function checkHealth() {
    const needsEmbed = config.retrieval === 'hybrid';
    const result = { reachable: false, chatModelPulled: false, embedModelPulled: !needsEmbed, gandaModelPulled: !config.gandaModel, models: [], retrieval: config.retrieval };
    let res;
    try {
        res = await fetch(`${config.ollamaHost}/api/tags`);
    } catch (err) {
        result.error = `Cannot reach Ollama at ${config.ollamaHost}. Is 'ollama serve' running? (${err.message})`;
        return result;
    }
    if (!res.ok) {
        result.error = `Ollama responded with ${res.status}`;
        return result;
    }
    const data = await res.json();
    result.reachable = true;
    result.models = (data.models || []).map((m) => m.name);
    // Ollama tags sometimes come back without the ':latest' suffix a user's
    // config might include — compare on the base name too.
    const base = (name) => name.split(':')[0];
    result.chatModelPulled = result.models.some((m) => m === config.chatModel || base(m) === base(config.chatModel));
    if (needsEmbed) result.embedModelPulled = result.models.some((m) => m === config.embedModel || base(m) === base(config.embedModel));
    if (config.gandaModel) result.gandaModelPulled = result.models.some((m) => m === config.gandaModel || base(m) === base(config.gandaModel));
    return result;
}

/**
 * Loads the chat model into memory so the first real visitor does not wait for it.
 * Never throws: a failed warm-up just means the first question is slower.
 */
async function warmup() {
    try {
        await chat([{ role: 'user', content: 'hi' }], { numPredict: 1, temperature: 0 });
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { chat, chatStream, embed, checkHealth, warmup };
