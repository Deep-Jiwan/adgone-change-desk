# Change Desk

A change-management dashboard for your apps. Open it, see every app, pick one, and request a change by
pasting a screenshot. Built on Cloudflare: **Workers** (API + static frontend), **D1** (database) and **R2** (screenshots/files).
No framework, no build step.

## What's in version 1

- **Dashboard** of all apps with pending / in-progress / completed / overdue counts, search and status filter.
- **Per-app page** with its full change history, filters (status, priority, category, assignee, overdue, text) and CSV export.
- **Request form**: title, description, category (Bug Fix / New Feature / Improvement / UI Change), priority, and
  **Ctrl+V screenshot paste**, drag-and-drop or browse. Images can be **annotated** (box, arrow, freehand) before upload.
- **Request IDs** like `CHAI-0042`, workflow `New → Under Review → Approved → In Progress → Testing → Completed` (plus `Rejected`),
  assignee, due date, progress %, activity log and comments.
- **Testing & sign-off**: the developer marks a change ready for testing; the requester (or an admin) accepts it or sends it back
  with a note. Completed requests can be reopened.
- **Team logins** with roles:

| Role | Can do |
| --- | --- |
| **Admin** | Everything: manage apps and people, accept completed work |
| **Developer** | Review, approve, assign, set due date/progress, move requests through the workflow |
| **Requester** | Submit requests, edit their own while still `New`, comment, sign off on testing, reopen their own |

Not in v1 yet: @mentions, email/push notifications, linked/duplicate requests, release history, PDF export.

## Deploy

Requires a Cloudflare account and Node 20+.

```bash
npm install
npx wrangler login

# 1. Create the database and bucket
npx wrangler d1 create change-desk        # copy the printed database_id into wrangler.toml
npx wrangler r2 bucket create change-desk-files

# 2. Create the tables
npm run db:migrate:remote

# 3. Ship it
npm run deploy
```

Open the deployed URL. **The first account created becomes the admin.** Then add apps (Dashboard → *Add app*) and invite your
team (*Team* → *Invite a teammate*). Invited people get a one-time temporary password you pass on to them; they must change it
on first sign-in.

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev                # http://localhost:8787
```

Tests:

```bash
npm test                                           # workflow rules run; API tests are skipped without BASE
# API integration tests need a running dev server on a FRESH local database:
rm -rf .wrangler/state && npm run db:migrate:local && npm run dev
BASE=http://localhost:8787 npm test
```

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers maximum) and a per-user salt. Sessions are random 256-bit
  tokens stored hashed, delivered in `HttpOnly; SameSite=Lax; Secure` cookies, and expire after 14 days.
- Logins are throttled per email (8 failures / 15 min). For stronger protection against distributed guessing, add a Cloudflare
  **Rate Limiting rule** for `POST /api/login`.
- State-changing requests require a custom `X-Requested-With` header and a same-origin `Origin`, on top of `SameSite` cookies.
- Uploads are limited to 10 MB, 20 per request and an allow-list of types (no SVG/HTML). Only images and video display inline;
  everything else downloads. Files are only served to signed-in users.
- The frontend builds the DOM with `textContent` (never `innerHTML`) and ships a strict CSP (`public/_headers`).
- Every signed-in user can see all apps and requests. There are no per-app permissions yet.
- Prefer SSO? Put the Worker behind **Cloudflare Access** as well; the built-in login still applies.

## Layout

```
src/index.js      API routes + dispatcher
src/workflow.js   status transitions and permission rules (pure, unit-tested)
src/auth.js       password hashing, sessions, login throttling
migrations/       D1 schema
public/           static frontend (index.html, app.js, style.css, _headers)
test/             workflow unit tests + API integration tests
```
