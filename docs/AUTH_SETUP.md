# Sign-in setup: "Continue with Google" and email verification

Two things to set up, in this order. Everything in the code is done; what is left is the account settings only you can make
(Google's console and your email provider). Each part takes about 15 minutes.

## What people will see

- **Sign up with a password:** the account is created but **cannot sign in until the email is confirmed** (changed in WIP 115). A confirmation message is sent straight away; opening its link confirms the address and signs the person in. (Older text follows.) They can use the site meanwhile; things that need a verified email (such as joining Circle or Crew) ask for it first and offer to send the message again.
- **Continue with Google:** one tap, no password. Google has already verified the email, so these accounts are verified from the start.
- **Someone who already has a password account** and then uses Google with the same email is joined to that same account (see "How accounts are joined" below).

---

## Part 1: Google

You need one thing from Google: a **Web client ID**. It is public (the browser needs it), there is no secret to keep, and nothing is stored with Google.

### 1. Create the project and consent screen
1. Open <https://console.cloud.google.com> and sign in with the Google account that should own this (a company account, not a personal one you might lose).
2. Top bar, project picker, **New project**, name it `NextaStore`.
3. Menu, **APIs & Services**, **OAuth consent screen** (newer consoles call it **Google Auth Platform**) and **Get started** / **Branding**:
   - App name: `NextaStore`. Support email: yours.
   - Audience / user type: **External**.
   - Authorised domain: your site's domain (for example `nextastores.com`). Developer contact email: yours.
   - Scopes: leave the defaults (`openid`, `email`, `profile`). These are not "sensitive", so Google does not need to review the app.
4. While testing, the app is in **Testing** and only the test users you list can sign in. Before real people use it, press **Publish app** (Audience page). With only the default scopes this is immediate.

### 2. Create the Web client ID
1. **APIs & Services**, **Credentials**, **Create credentials**, **OAuth client ID**.
2. Application type: **Web application**. Name: `NextaStore web`.
3. **Authorised JavaScript origins**: add every address the login page is opened from, exactly, with no path and no trailing slash:
   - `http://localhost:3000` (your computer; add any other port you use)
   - `https://nextastores.com` (and `https://www.nextastores.com` if you use it)
4. **Authorised redirect URIs**: leave empty. This button does not use them.
5. **Create**, then copy the **Client ID** (it ends in `.apps.googleusercontent.com`). Ignore the client secret; we never use it.

> Circle and Crew on subdomains do not need their own entries: people sign in on the main site and are handed over.

### 3. Give it to the server and update the database
1. In the backend `.env`: `GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com`
2. Add the new column (one time, safe to repeat): `cd nextastore-backend && npx prisma migrate deploy && npx prisma generate`
3. Restart the backend.

### 4. Check it
- Open `http://localhost:4000/api/auth/config`. You should see your client id under `google`. If it says `"google": null`, the `.env` value was not read (wrong file, or the server was not restarted).
- Open the login page. A **Continue with Google** button appears under the form. Sign up page: **Sign up with Google**, after the agreement box.
- Google changes to origins can take a few minutes to apply.

### If something is wrong
| You see | Cause and fix |
|---|---|
| No Google button at all | `/api/auth/config` returns `google: null` (set `GOOGLE_CLIENT_ID`, restart), or an ad blocker is blocking `accounts.google.com` (the page then says email still works). |
| Google says "origin_mismatch" / "The given origin is not allowed" | The address in the browser is not in **Authorised JavaScript origins**. Add it exactly, including `http`/`https` and the port. |
| "Access blocked: app has not completed verification" or only some people can sign in | The app is still in **Testing**. Publish it, or add the person as a test user. |
| "That Google sign-in was made for a different site" | The client id the page used is not the one the server expects. Both come from `GOOGLE_CLIENT_ID`, so check there are no two different ids. |
| "Your device clock looks wrong" | The phone or computer's time is far off. Fix the time. |
| "We could not reach Google just now" | The server could not fetch Google's public keys (no internet from the server, or a firewall). It retries on the next sign-in. |
| "Your Google email address is not verified" | Very rare; Google itself has not verified that address, so we will not accept it. |
| "Admin accounts sign in with their email and password" | By design: an admin account is never linked or created through Google. |

### How accounts are joined (and why it is safe)
- The server checks Google's signature itself, that the token was made for **your** client id, that it has not expired, and that Google has verified the email. Nothing the browser says about who the person is is trusted.
- **Same Google account again:** signs in to the same NextaStore account.
- **Email already has an account that was verified:** Google is joined to it, and they get in. Their password keeps working.
- **Email already has an account that was never verified:** it is joined too, but the old password is thrown away and every old session is signed out. (Otherwise someone could register another person's email with their own password, and take over the account the day the real owner arrives with Google.)
- **Suspended accounts** cannot get in through Google. **Admin accounts** cannot use Google at all.
- A person who only ever used Google has no password they know. If they want one, **Forgot password** on the login page sets one.
- One Google account can only ever be linked to one NextaStore account.

---

## Part 2: Email (verification and password reset)

Until you set up email, the server **prints** each message in its own log instead of sending it. That is fine on your computer (copy the link from the terminal). A live site needs real email, and production refuses to start without it.

### 1. Choose a provider
Any service that gives you SMTP details works: Brevo, Mailgun, SendGrid, Amazon SES, Zoho Mail, or Google Workspace SMTP. For a new site a transactional-email service (Brevo, Mailgun, SES) is the safest choice, because ordinary inboxes limit how much they can send and flag bulk mail. Send from an address on **your own domain** (for example `no-reply@nextastores.com`).

### 2. Put the details in the backend `.env`
```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false          # true only if your provider tells you to use port 465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="NextaStore <no-reply@nextastores.com>"
FRONTEND_URL=https://nextastores.com
```
`FRONTEND_URL` matters: it is the address inside the emailed link, so it must be your real site, not `localhost`, in production.

### 3. Make the email land in the inbox, not spam
In your domain's DNS, add what your provider tells you for **SPF** and **DKIM**, plus a **DMARC** record. Providers show these as a checklist and mark each one green when it is correct. Without them, many messages go to spam.

### 4. Test it
`cd nextastore-backend && node scripts/mail-check.js you@example.com` sends the real confirmation email to that address (or prints it, if SMTP is not set). Then sign up with a real address and confirm the message arrives and the button opens the "Email verified" page.

### How it behaves
- The link works **once** and for **24 hours**; asking for a new one cancels the old.
- "Send me a new link" can be used once a minute (so it cannot flood anyone's inbox).
- The "Link invalid or expired" page offers a new link right there; if the person is not signed in it takes them to sign in first.
- If the mail provider is down at the moment of signup, the account is still created; the person can ask again from the app.
- Password reset emails use the same look.


## Email must be confirmed (WIP 115)

Every password sign-up has to prove the address is real before anyone gets in. How it behaves:

- **Sign-up** creates the account but issues **no session**. The page shows "Check your inbox" with the address, a resend button (60 second cooldown) and "Use a different email".
- **Sign-in before confirming** is refused with `EMAIL_NOT_VERIFIED`; the page shows the same inbox panel with an immediate resend. The right password is already proven at that point, so saying why leaks nothing.
- **The link** confirms the address **and signs the person in**. A new seller goes straight to store setup. The page POSTs the token, so a mail scanner that only fetches the page cannot use the link up.
- **Resend without being signed in:** `POST /auth/resend-verification {email}`. It answers the same way for unknown, unconfirmed and confirmed addresses, so it cannot be used to find out who is registered.
- **An address nobody confirmed does not lock out its real owner.** Signing up again with it replaces the unconfirmed account. This applies only to accounts created under this rule that never signed in; older accounts, confirmed accounts, Google accounts and admin accounts are never replaced.
- **Resetting a password through the emailed link also confirms the address** (it proves the inbox).
- **Who is exempt:** admin accounts, and accounts created **before** `EMAIL_VERIFICATION_REQUIRED_FROM` (default `2026-10-28T00:00:00Z`) so nobody is locked out of a live shop. The features that handle money still need a verified email either way. Set the variable to an earlier date to apply the rule to everyone; to a later date to delay it.

### When email is not working

`GET /auth/config` now also says whether email is usable (`email.available`):

- **No SMTP set up, production:** not available. **Development:** available, and the confirmation link is printed in the server log **and returned to the page** (never in production) so you can click it.
- **A provider outage:** after 3 failed sends in a row, email counts as unavailable for 5 minutes.
- While unavailable, the sign-up page shows a notice, switches the email form off and leaves **Continue with Google** as the way in; the server also refuses password sign-up with `503 EMAIL_UNAVAILABLE` before creating anything. Signing in with an already-confirmed account is unaffected.
- If only one send fails, the account exists and the page says "we could not send the email" with a resend button.

### Google first

Login and sign-up put **Continue with Google** at the top, then "or sign in / sign up with email". After the first visit the page remembers that Google is set up and holds its place, so the form does not jump when Google's button appears. The Terms/Privacy agreement is stated beside both buttons ("By continuing you agree to...") instead of a checkbox. If someone picks **Sell** on the sign-up page and Google matches an account that is only a buyer, their shop is opened and they go to store setup.
