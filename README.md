# Roofline

Construction CRM (lead → closed job), built as an AMOS-hosted vertical app.
Own domain, platform end-user auth, deployed and governed through AMOS.

Scope: 8-stage pipeline with role-scoped visibility (rep/manager/admin),
job files with communication threads + measurement reports, lead intake,
contacts, SRS-priced catalogue, proposals → signing → orders → invoices →
payments, commission view, production calendar. Integrations (SRS Roof Hub,
GAF QuickMeasure, QuickBooks, Google Calendar, signing) are represented in
Settings and stubbed at their exact seams — **Roofline holds zero third-party
credentials**; every integration lives in the AMOS platform.

## Persistence

One async query surface (`lib/db.ts`), two backends:

- **Postgres** — set `DATABASE_URL` and the app runs on pooled `pg`.
  Idempotent migrations in `migrations/*.sql` are applied at boot
  (`instrumentation.ts`; also lazily before the first query, single-flight,
  behind a Postgres advisory lock so concurrent instances don't race).
- **Demo sqlite** — leave `DATABASE_URL` unset and the original `node:sqlite`
  database with the demo seed comes back, so local dev needs no services.
  `ROOFLINE_SQLITE_PATH` overrides the file location (default
  `data/roofline.db`).

App SQL stays in the sqlite dialect; `lib/db-postgres.ts` translates the few
sqlite-isms in use (`?` placeholders, `datetime('now')`/`date('now', …)`,
`date(col)`). Timestamps are stored as UTC TEXT in sqlite's
`YYYY-MM-DD HH:MM:SS` format on both backends so the whole read surface
renders identically — a later migration can move to `timestamptz`.

### Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Unset → demo sqlite. |
| `DATABASE_SSL` | `disable` \| `no-verify` \| `verify`. Default in production: `verify` against the bundled RDS CA (`certs/rds-global-bundle.pem`). `DATABASE_CA_BUNDLE` overrides the path. |
| `DATABASE_POOL_MAX` | Pool size (default 10). |
| `AUTH_MODE` | `amos` \| `demo`. Default: `amos` when `DATABASE_URL` is set, `demo` otherwise. |
| `AMOS_APP_AUTH_APP_ID` | This app's id — the required `aud` of identity tokens. Fails closed when unset. |
| `AMOS_APP_AUTH_JWKS_URL` | JWKS override (default `https://app.amoslabs.com/.well-known/amos-app-auth/jwks.json`). |
| `AMOS_APP_AUTH_LOGIN_URL` | Where "Continue with AMOS" sends the user. Default is `https://app.amoslabs.com/app-auth/{app_id}/login?redirect_uri=https://<this-host>/auth/callback` (path param, not `?app_id=`). |
| `ROOFLINE_SESSION_SECRET` | HMAC key for the session cookie. |

## Org model

Every business table (`users`, `contacts`, `jobs`, `job_events`,
`measurements`, `catalogue`, `proposals`, `proposal_lines`, `templates`,
`documents`, `material_orders`, `work_orders`, `invoices`, `payments`,
`tasks`, `automations`) carries `org_id UUID NOT NULL` referencing `orgs`:

```
orgs(id UUID PK, name, amos_tenant_id UUID NULL UNIQUE, created_at)
```

`amos_tenant_id` links the org to its AMOS platform tenant. **org_id is the
tenancy key** — every query is scoped by it, and it always comes from the
authenticated session (UI) or the verified identity token (API/MCP), never
from client input. The demo seed lives in a fixed demo org
(`00000000-0000-4000-8000-000000000001`), sqlite only.

## Auth (`AUTH_MODE`)

- **demo** — email/password against the seeded demo users
  (`jeff@ / dana@ / marcus@ / priya@ @demo.roofline`, password `demo2026`).
  These users exist only in the sqlite demo seed.
- **amos** — the platform IdP owns signup, login, orgs and sessions. The
  login page shows "Continue with AMOS"; the IdP redirects to
  `/auth/amos` with the short-lived EdDSA `X-Amos-Identity` JWT (header when
  proxied, `?token=` otherwise). `lib/amos-identity.ts` verifies it against
  the published JWKS (no shared secret, no password storage);
  `lib/amos-auth.ts` maps the token's tenant to an org —
  **auto-provisioned on first login** (with default templates/catalogue/
  automations seeded) — and upserts the user (sub/email/name/role claims,
  refreshed each login; roles map owner/admin→admin, manager→manager,
  else→rep). Both modes end in the same HMAC session cookie, so everything
  downstream of `currentUser()` is mode-agnostic.

## API / MCP surface

`app/api/*` (the published MCP tools) requires a verified `X-Amos-Identity`
on every call and resolves the token's org claim through
`orgs.amos_tenant_id` (`requireOrgIdentity`). Tokens whose tenant has no org
mapping get **403** — provisioning is an interactive act, the MCP surface
never creates orgs. All route queries are org-scoped.

## Importing customer data

```
DATABASE_URL=postgres://… node scripts/import-snapshot.ts snapshot.json --org <org uuid>
```

Runbook:
1. Have the customer's owner sign in once (provisions the org), then read the
   org id: `SELECT id FROM orgs WHERE name = '…'`.
2. Build the snapshot JSON — the exact shape is documented in the header of
   `scripts/import-snapshot.ts` (contacts/jobs carry snapshot-local `ref`
   keys; proposals/invoices/tasks/events reference jobs by `job_ref`;
   proposal `lines` and invoice `payments` nest inside their parents).
3. Run the importer. It assigns fresh ids while preserving relationships,
   skips rows whose contact names / job titles match the demo seed
   (`lib/demo-fixtures.ts` is the single source of truth for that), and is
   idempotent on re-run via natural-key lookups — safe to run again after a
   partial failure or with an extended snapshot.
4. Read the per-table report it prints
   (`inserted / existing / skipped_demo / skipped_dangling`).

## Development

```
npm install
npm run dev        # demo mode, sqlite, no services needed
npm test           # node:test; the org-scoping suite runs against Postgres at
                   # localhost (ROOFLINE_TEST_DATABASE_URL to point elsewhere)
                   # and skips with a message when none is reachable
npm run build
```

Node >= 22.18 (`node:sqlite` + type-stripping for scripts/tests; the
container uses Node 24).
