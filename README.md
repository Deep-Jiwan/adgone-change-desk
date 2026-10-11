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

- **GitHub sync** (optional, per app): tickets created here are also created as GitHub issues, and closing or commenting on those issues updates the ticket. See [GitHub sync](#github-sync).

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

## GitHub sync

Each app can be linked to one GitHub repository. **Only tickets created in Change Desk are ever shown on GitHub, and
GitHub issues are never imported into the desk.**

| When this happens in the desk… | …this happens on GitHub |
| --- | --- |
| A ticket is created | An issue `[CHAI-0042] Title` is opened with labels `change-desk`, `type:<category>`, `priority:<priority>` |
| Title/description/category/priority edited | Issue title/body/labels updated |
| A comment is added | Posted as an issue comment |
| Status changes | A "Status: A → B" comment; **Completed** closes the issue, **Rejected** closes it as *not planned*, reopening reopens it |
| Files/screenshots attached | Listed in the issue body with a link back to the ticket (files stay in the desk, which requires a login) |

| When this happens on GitHub (for a desk ticket)… | …this happens in the desk |
| --- | --- |
| The issue is closed | Ticket becomes **Completed** (or **Rejected** if closed as *not planned*) |
| The issue is reopened | Completed → **In Progress**, Rejected → **New** |
| Someone comments | The comment appears in the ticket's discussion, marked *GitHub* |

Setup (one time):

1. Set an encryption secret. It protects saved GitHub tokens, so keep it safe: changing it invalidates saved connections.
   ```bash
   npx wrangler secret put ENCRYPTION_KEY        # any random string of 16+ characters
   ```
   (Locally, put `ENCRYPTION_KEY=...` in a `.dev.vars` file.) Secrets persist across `wrangler deploy`.
2. Sign in as an admin, open the **GitHub** page and add a connection, either:
   - **Token (recommended):** a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to the repos you
     want, with *Issues: Read and write* and *Webhooks: Read and write*. It is verified and stored encrypted.
   - **OAuth:** create a GitHub OAuth App with the callback URL `https://<your-domain>/api/github/oauth/callback`, then
     `npx wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. A **Connect with GitHub** button appears.
     OAuth grants access to every repo your account can reach, so a scoped token is the tighter choice.
3. Open an app → **Edit** → **GitHub repository**, pick the connection, enter `owner/name` and **Link repository**.
   Change Desk checks access, then registers a webhook so GitHub → desk updates arrive. If the connection cannot manage
   webhooks, the dialog shows the payload URL and secret to add by hand (Settings → Webhooks, events *Issues* and *Issue comments*).

Good to know:

- Tickets created **before** linking are not back-filled; open one and press **Create GitHub issue** if you want it on GitHub.
- A GitHub failure never blocks the desk. The ticket is saved and the GitHub box shows the error with a **Retry** button.
- Closing an issue on GitHub completes the ticket directly, without the requester's testing sign-off.
- The webhook URL is fixed to the address you linked from. If you move to a different domain, press **Update link** again.
- `@mentions` in desk text are neutralised before posting, so desk users cannot ping GitHub accounts.
- GitHub Enterprise: set the `GITHUB_API_URL` and `GITHUB_WEB_URL` variables (e.g. `https://ghe.example.com/api/v3`).

## Automatic deployment (GitHub Actions)

`.github/workflows/deploy.yml` tests, migrates the database and deploys on every push to `main`. One-time setup:

1. Do the **Deploy** steps above once by hand (creates the D1 database and R2 bucket) and commit the real `database_id` in `wrangler.toml`.
2. In Cloudflare: *My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"* template, then add the permission
   **Account → D1 → Edit**. Copy your **Account ID** from the dashboard sidebar.
3. In GitHub: *Settings → Secrets and variables → Actions* → add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Until steps 1 and 3 are done the workflow skips the deploy and finishes green.

Alternative: Cloudflare's own Git integration (*Workers & Pages → Create → Import a repository*, build command empty,
deploy command `npx wrangler deploy`) does the same without secrets in GitHub, but you set it up in the Cloudflare dashboard.

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

# ...plus the GitHub tests, which run against an in-process fake GitHub (test/mock-github.mjs):
npx wrangler dev --port 8787 --var ENCRYPTION_KEY:test-encryption-key-0123456789 \
  --var GITHUB_API_URL:http://127.0.0.1:9911 --var GITHUB_WEB_URL:http://127.0.0.1:9911 \
  --var GITHUB_CLIENT_ID:cid --var GITHUB_CLIENT_SECRET:csecret
BASE=http://localhost:8787 GH_MOCK_PORT=9911 npm test
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
- GitHub tokens are encrypted at rest (AES-GCM, key derived from `ENCRYPTION_KEY`) and are never sent to the browser. Incoming
  GitHub webhooks are accepted only with a valid HMAC signature (a per-app secret derived from the same key).
- Every signed-in user can see all apps and requests. There are no per-app permissions yet.
- Prefer SSO? Put the Worker behind **Cloudflare Access** as well; the built-in login still applies.

## Layout

```
src/index.js      API routes + dispatcher
src/workflow.js   status transitions and permission rules (pure, unit-tested)
src/auth.js       password hashing, sessions, login throttling
src/github.js     GitHub integration: encryption, API client, desk<->GitHub sync, webhook handling
migrations/       D1 schema
public/           static frontend (index.html, app.js, style.css, _headers)
test/             unit tests, API integration tests, and a fake GitHub server
```
