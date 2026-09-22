// Stand-in used ONLY when the real `dotenv` package is not installed (e.g. an
// offline sandbox). Node looks here last (via NODE_PATH), so a real install
// always wins. Deliberately does not read any .env file.
module.exports = { config() { return { parsed: {} }; } };
