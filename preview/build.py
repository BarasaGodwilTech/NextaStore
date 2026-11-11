#!/usr/bin/env python3
"""Builds ONE self-contained preview page (preview/gallery.html) from the studio's real JS, so it opens anywhere, phone included."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
files = ['js/growth-qr.js', 'js/brand-kit.js', 'js/brand-kit-templates.js', 'js/brand-kit-posts.js']
scripts = '\n'.join((root / f).read_text() for f in files).replace('</script', '<\\/script')
html = (root / 'preview/gallery.template.html').read_text().replace('/*__SCRIPTS__*/', scripts)
(root / 'preview/gallery.html').write_text(html)
print('wrote preview/gallery.html', len(html) // 1024, 'KB')
