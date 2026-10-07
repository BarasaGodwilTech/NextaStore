# How to keep the assistant accurate (read this before editing)

This folder is not documentation for developers — it's written the way you'd
write a help-center article, because it's fed almost word-for-word into the
model's context when it answers a related question. Keep that in mind:

- **Write facts, not internal notes.** Don't paste raw changelog/WIP text in
  here — summarize what's actually true for a user *today*. If something is
  half-built or unverified in production, either leave it out until it's
  confirmed live, or phrase it the way `03-payments.md` does ("this is
  admin-configurable, don't assume a fixed list").
- **One topic per `##` heading.** The indexer treats each `## Heading` as one
  retrievable chunk (see `src/rag/chunk.js`). A heading that tries to cover
  three unrelated things will retrieve badly for all three.
- **Say "point them to support" instead of guessing.** For anything
  time-sensitive, per-account, or that changes without a code deploy
  (subscription status, a specific order, whether a specific payment cleared)
  — write instructions telling the assistant to defer, not a fact that will
  go stale.
- **Never write a price, fee, number of days or months, limit or status name in these files.** Those come
  from the backend code and are copied into `90-project-facts.generated.md` automatically (see
  `src/sync/factsSync.js`). Say "the exact amount is in the platform facts" and describe the idea in words. Do not
  edit the generated file: it is rewritten every few minutes. `npm run selftest` has a drift check that fails if a
  hand-written file states an amount, day count or month count that disagrees with the generated facts.
- **No reindex step.** The assistant reads these files directly and notices an edit, a new file or a
  deleted file within a second or two. No command, no restart (see `src/rag/retrieve.js`). If a file is
  caught half-saved, the assistant keeps using the last good version until the next check.
  (`npm run reindex` only matters if you switch on the optional `RETRIEVAL=hybrid` mode.)
- **Use the words people use.** Search is keyword-based, so a section about "Seller Pass" should actually
  contain the words "Seller Pass", "subscription", "badge" and so on. If people ask in Luganda or Swahili,
  add their words to `src/lang/retrieval-lexicon.json` (see the note at the top of that file).
- **New topic = new file.** Add `08-whatever.md` following the same
  `# Title` / `## Section` shape as the others, and it's picked up
  automatically — nothing else to register.

If you want the assistant to also be aware of *upcoming* changes before
they ship (so support doesn't get caught flat-footed on launch day), add
them here under a clear "Coming soon, not live yet" heading rather than
waiting until release day to write the doc.
