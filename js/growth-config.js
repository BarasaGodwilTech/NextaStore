/**
 * OPTIONAL. You normally do not need to touch this file.
 *
 * When the server mounts growth.hostRouter(...) it writes the host settings into every page by itself,
 * and the pages also work them out from the address. Edit this only if you serve the pages as plain
 * static files AND your main site is not simply the "root" of circle.<root> (for example it is www.<root>):
 *
 *   window.NEXTA_HOSTS = { mode: 'subdomain', main: 'https://www.nextastore.com',
 *                          circle: 'https://circle.nextastore.com', crew: 'https://crew.nextastore.com' };
 */
window.NEXTA_HOSTS = window.NEXTA_HOSTS || undefined;
