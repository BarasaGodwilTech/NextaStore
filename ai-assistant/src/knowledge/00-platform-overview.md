# Platform overview

## What NextaStore is
NextaStore is a multi-vendor online marketplace built for Uganda. Anyone can
browse and buy from many independent stores in one place, and any seller can
open their own branded store on the platform — set a logo, banner, theme and
layout, and list products — without building a website from scratch.

## Main areas of the platform
- **Marketplace** — the main browse/search page across every store's products.
- **Store pages** — each seller's own storefront (their products, banner, follower count).
- **Product detail page** — full description, price, images, and a way to message the seller or add to cart.
- **Cart & checkout** — review items, choose a payment method, place the order.
- **Orders** — buyers track their own orders; sellers manage incoming orders for their store.
- **Dashboard** — a seller's control center: products, orders, store settings, subscription status.
- **Messages** — direct chat between buyers and sellers (and presence indicators showing who's online).
- **Favorites & Following** — buyers can save products (favorites) and follow stores they like.
- **Notifications** — in-app and push notifications for order updates, messages, new products from followed stores, and subscription reminders.
- **Admin console** — platform staff manage users, stores, payment methods, and subscription approvals.

## Who this assistant is for
This assistant answers questions from buyers and sellers using the platform:
how to do something, how a feature works, and general guidance. It does not
have access to any individual user's private account data (their orders,
messages, balance, etc.) unless that is wired in separately — see
README.md "Connecting real account data" for how to extend it safely.

## Keeping this assistant accurate as the platform changes
This file and the others in `src/knowledge/` are the assistant's entire
factual memory of the platform. There is no hidden training happening —
whoever maintains the platform is expected to:
1. Update the relevant `.md` file here when a feature changes or ships.
2. Save it. The assistant reloads knowledge files by itself (no reindex, no restart).
That's it — the next question about that topic is answered from the new
text. If a fact isn't written down here, the assistant is instructed to say
it doesn't know rather than guess (see `src/chat/systemPrompt.js`).
