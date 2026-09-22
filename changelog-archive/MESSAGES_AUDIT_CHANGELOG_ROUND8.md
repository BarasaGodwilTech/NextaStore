# Messages audit — round 8: mobile/PWA viewport lock-in + pull-to-refresh

Files touched: `messages.html`, `css/messages.css`, `js/messages.js`. Drop
all three in at the same paths, replacing the existing files. No backend
or migration changes this round.

## 1. Fixed: header/search/filter/composer/credit line could get cut off,
   and differed between the browser and the installed PWA
**Root cause — two separate bugs stacked on top of each other:**
- The page shell was sized with `height: 100dvh` (`100svh` in standalone),
  relying on the browser to define "dynamic viewport height." Different
  engines resolve that differently once a page is running as an installed
  PWA versus a plain browser tab — for the *same physical screen* — which
  is exactly why the layout behaved differently in the two places.
- Separately, iOS Safari has a known bug where focusing an input (the
  conversation search box, the message composer) can scroll the whole
  *document* upward to "reveal" the input — even though the document was
  already `overflow: hidden` and should not have been scrollable at all.
  That's what could shove the topbar off the top of the screen.

**Fix:** `body.messages-page` is now pinned with `position: fixed; inset: 0`
instead of being sized with a length unit — a fixed element can't be
document-scrolled out of place, which removes bug two outright. Bug one is
fixed by computing the real, current viewport height ourselves in JS
(`syncViewportHeight()`, using `visualViewport.height`) into a `--app-vh`
custom property that the CSS height now reads from, instead of trusting
the browser's own dvh/svh resolution. Both the browser tab and the
installed PWA now measure the same thing, the same way, so they render
identically. `100dvh` is kept as a pre-JS fallback for the very first
paint only.

`syncViewportHeight()` re-runs on `resize`, `orientationchange`, and every
`visualViewport` `resize`/`scroll` event — covering the address bar
showing/hiding in a browser tab and the on-screen keyboard opening/closing
in both places. It also defensively resets the real document scroll to 0
whenever iOS reports the visual viewport has been panned (`offsetTop > 0`)
rather than resized, which is the specific shape that bug two takes.

Net effect on all five points asked for: the topbar, the conversation
search box, the filter tabs, the thread header/contact row, and the
composer's text box + Send button are now structurally pinned in place —
none of them can be scrolled out of view, cut off, or partially hidden, on
a mobile browser tab or the installed PWA.

## 2. Fixed: the "Powered by Nextawills Technologies" line disappeared
   while a thread was open on mobile
This was a deliberate space-saving choice in an earlier round, but it's
the opposite of what was asked for here. Removed the rule entirely — the
credit line is now part of the fixed shell like everything else above and
stays visible at all times, list view or an open chat, browser or PWA.

## 3. Confirmed: both lists were already independently scrollable
The conversation list (names/contacts) and an open thread's message
history each already scroll inside their own pane — only they scroll,
never the page itself — so scrolling to see older items has always worked
and needed no change. Verified with a full-content mock (30 conversation
rows, 40 message bubbles) at several phone viewport sizes; nothing spills
outside the fixed shell or forces a page-level scroll at any of them.

## 4. Added: pull-to-refresh (previously did not exist anywhere)
There was no pull-to-refresh gesture in the app at all — only tap-to-load
buttons ("Load more conversations", "Load older messages"). Native
pull-to-refresh can't work here regardless, in either environment: it
needs the document itself to scroll and rubber-band, which the fixed
shell above deliberately prevents (that's what keeps the header/composer
from being scrollable away).

Added a hand-rolled version, `bindPullToRefresh()`, bound to both panes:
- **Conversation list** — pulling down at the very top re-fetches the
  latest conversations via the existing silent/preserve-loaded refresh
  path (the same call the 8-second background poll already uses), merging
  in anything new without disturbing scroll position or open state.
- **Open thread** — pulling down at the very top loads older messages,
  reusing the existing `loadOlderMessages()` call and its pagination
  cursor — same request, same de-duplication, just a second way to
  trigger it besides the button.

Each pane gets a small indicator row (`.ptr-indicator`, in
`css/messages.css`) that grows as you pull, flips to a spinner once
released past the threshold, and collapses again once the refresh settles
— on both browser and PWA, since it's plain touch-event JS rather than
anything the platform provides natively. The indicator elements live as
siblings of the lists they sit beside (`#convListPtr`, `#threadPtr` in
messages.html), specifically so they survive the wholesale `innerHTML`
repaints those lists already do on every render — nothing needed to
change in `renderConversationList()` or `paintThreadMessages()` for this.

## Not changed (reviewed, still correct)
- The mobile single-pane sliding layout (list ↔ thread via `transform`)
  and the `inert` handling for the off-screen pane — unaffected by the
  shell change, re-verified at the 880px breakpoint.
- 16px input font-size (iOS zoom prevention), 44px touch targets,
  `interactive-widget=resizes-content` — all still in place.
- Safe-area insets (notch / home indicator) on the topbar, composer, and
  credit line — unchanged, still correct with the new fixed shell.
