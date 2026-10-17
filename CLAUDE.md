# mctl-portal

Backstage-based developer portal. Service catalog, templates, deploy UI.

## Stack
- Backstage (Node.js 22), TypeScript
- yarn for package management
- 9 custom backend plugins

## Conventions
- TypeScript strict mode (`strict: true`)
- Prefer `const` over `let`
- Use async/await over raw Promises
- Follow Backstage plugin conventions for backend plugins
- Plugins live in `plugins/` directory

## Custom Plugins
1. `argo-workflows-backend` — Workflow integration
2. `custom-domains-backend` — Gateway to mctl-api's custom-domains registry (no local store)
3. `github-app-connect-backend` — GitHub App orchestration
4. `oidc-provider-backend` — SSO provider
5. `permission-backend-module-team-policy` — Team RBAC
6. `resource-usage-backend` — Quota monitoring
7. `tenant-backend` — Workspace management. `POST /tenants` resolves a named creator's GitHub login to the canonical principal through mctl-api (`POST /api/v1/surface-principals/github`, as `surface:portal` with `workItems.baseUrl`/`workItems.surfaceToken`) and passes it to `create-tenant` as `creator_principal_id`; if it cannot, it refuses with nothing written (mctl-api#377). A values.yaml member with `catalogKey: principal` (a self-service customer, mctl-web site-onboarding stage C2) is a catalog User named by its lowercased principal id, never by its login; the ZITADEL sign-in (`packages/backend/src/zitadelAuthModule.ts`) resolves customers-org tokens to that User through mctl-api `POST /api/v1/surface-principals/zitadel` and refuses any token whose organization it cannot read (`zitadelCustomers.organizationId` plus the `urn:zitadel:iam:user:resourceowner` scope must be configured, or no ZITADEL sign-in is accepted). From the landing page, `POST /tenants` with `creatorIdToken` (the mctl-web site's ZITADEL ID token) resolves the customer through the same route (purpose `create`) and creates the tenant with `creator_catalog_key=principal`, one workspace per customer (held by the store: a partial unique index on principal-keyed `tenant_members.user_id`, tenant and owner written in one transaction before the workflow is submitted, released again if the submit fails); `POST /tenants/availability` is the site's name check for it. A portal (admin) request may name only the caller as `creatorUserId`
8. `vault-secrets-backend` — Secret injection
9. `work-items-backend` — Canonical WorkItem view via mctl-api. Authenticates as the `surface:portal` principal (`MCTL_SURFACE_PORTAL_TOKEN`) with `X-MCTL-Surface-Actor` (surface relay, mctl-api#350); never uses `MCTL_API_TOKEN`/admin credentials. The actor id is `user:<namespace>:<name>` (lowercased; both parts must be Backstage object names, so no `:` or `/`), pinned in CONTRACT.md "Actor id". mctl-api is the authorization authority. Mutations are off unless `workItems.actionsEnabled` is true (default false). See `plugins/work-items-backend/CONTRACT.md`

## Key Paths
- `app-config.yaml` — local dev config
- `app-config.production.yaml` — production config
- `plugins/` — custom backend plugins
- `packages/app/` — frontend app
- `packages/backend/` — backend app

## Workspace Access
- Operations and delivery reconciliation: `docs/workspace-access.md`
