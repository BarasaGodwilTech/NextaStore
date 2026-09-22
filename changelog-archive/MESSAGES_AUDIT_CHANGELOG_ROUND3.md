# Messages flow — round 3: location/product card redesign + send-preview

Files touched: `js/messages.js`, `css/messages.css`,
`nextastore-backend/src/routes/messages.js`. Drop them in at the same
paths, replacing the existing files. No new migration this round.

## 1. Fixed: the enlarged ("wide") map modal still redirected out of the app
`openLocationPreview()` — the modal that's supposed to let someone see a
shared pin bigger without leaving the platform — was passing `mapsUrl`
into `NextaStoreMapPreview.render()`. That option lays a full-bleed,
invisible `<a target="_blank">` over the whole map (by design, for the
*other*, non-modal previews on the storefront/order pages that have no
expand-in-place option of their own). The result: tapping anywhere on the
enlarged map itself — inside the exact modal whose comment already said
"leaving the platform is now a deliberate choice" — silently opened Google
Maps in a new tab anyway. The explicit "Open in Google Maps" button in the
modal's footer is now the only way out of it.

## 2. Redesigned the in-chat location card
Previously: a small map thumbnail with a plain white strip underneath
holding the label and "Tap to view" text — functional, but read as a map
snapshot with a caption stapled on, and the two-tile mosaic (visible in
your screenshot) could show a faint seam where adjacent OpenStreetMap
tiles meet (tiles can differ very slightly tile-to-tile in exposure/
compression — normal for a raw mosaic, but looks like a glitch).

Now:
- Label and "tap to view" sit as a bottom gradient scrim laid directly over
  the map, with a small pin badge — the pattern real map apps use for a
  pin card — so it reads as one object instead of a thumbnail + caption.
- A small round "expand" icon in the corner makes the "this is tappable"
  affordance visible instead of implicit.
- A subtle inward vignette (`box-shadow: inset`) plus a touch of extra
  saturation/contrast across the whole tile mosaic soften the tile-seam
  look — reads as an intentional frame instead of a rendering artifact.
- Taller preview (120px → 148px) for better legibility of both the map and
  the overlaid text.

**Implementation note:** the expand icon and scrim are siblings of the map
slot, not children of it — `NextaStoreMapPreview.render()` does a full
`innerHTML` replace on whatever element it's given, so nesting the new
overlay badges inside that exact slot would've gotten them wiped out the
instant the map tiles rendered. They live in a new wrapping element,
`.message-location-media`, instead.

## 3. Redesigned the in-chat product card
Previously: a compact card with a small thumbnail, name, and price — easy
to misread as just "a message with a picture" rather than specifically a
shared catalog item. Now: a bigger thumbnail (52px → 64px), a small
"Shared product" eyebrow label for context, and an "out of stock" chip when
relevant (the metadata snapshot didn't carry `stock` before — added it on
the backend, in both the "share a product" path and the "message seller
about this product" context path, plus the frontend's optimistic-bubble
builder, so the badge actually has data to work with everywhere a product
card can appear).

## 4. Added: preview before sending, for all three attachment flows
This is the main functional addition. Sharing your live location, sharing
your store's location, and sharing a product from your catalog all used to
send the instant something was picked or your GPS fix came back — no way
to back out, double-check the pin, or add/edit a caption afterwards (only
whatever you'd already typed *before* opening the picker rode along).

All three now open a confirm dialog first, showing **the exact card the
recipient is about to see** — it's rendered with the very same function
that builds real message bubbles (`messageContentHtml`), not a separate
mockup that could drift out of sync with it — plus an editable caption
field, and Cancel/Send. A few details worth knowing:
- The location card in this preview is still tappable to open the same
  enlarged map view as a real sent message, so you can double-check the
  pin before committing.
- Cancelling doesn't throw away anything you typed in the caption field —
  it goes back into the main composer.
- Pressing Escape while the enlarged map preview is open (opened from
  inside this dialog) closes just that, not the whole confirmation — the
  two modals' Escape handlers are aware of each other so one keypress
  doesn't dismiss both at once.

## Not changed in this round
- A shared GPS location's label still isn't editable in the confirm dialog
  (only a store-location share gets an automatic label, from the store
  name). Worth adding an optional label field there later if it comes up.
- The product card's thumbnail size change and the location card's taller
  preview slightly increase the vertical space attachment bubbles take up
  in a dense thread — worth a look if anyone has an unusually long history
  of shared products/locations in one conversation, though nothing in
  testing suggested it's a problem in practice.
