A tiny stand-in for the NextaStore main site, used ONLY by the browser tests when PROJECT_DIR is not set,
so the growth pages can be exercised without the real project. It copies the few behaviours the growth
pages depend on: `app.apiRequest` (token in localStorage under nextastore_token, errors with .status/.code/.isNetwork),
the `data-auth-required` / `data-admin-required` guard that sends signed-out people to /login, and the
account menu. It is NOT the real main.js. Run the browser test with PROJECT_DIR=/your/NextaStore to use the real one.
