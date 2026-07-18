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
2. `custom-domains-backend` — Domain management
3. `github-app-connect-backend` — GitHub App orchestration
4. `oidc-provider-backend` — SSO provider
5. `permission-backend-module-team-policy` — Team RBAC
6. `proposals-backend` — Review/approve mctl-agents proposals (agents-state in gitops)
7. `resource-usage-backend` — Quota monitoring
8. `tenant-backend` — Workspace management
9. `vault-secrets-backend` — Secret injection

## Key Paths
- `app-config.yaml` — local dev config
- `app-config.production.yaml` — production config
- `plugins/` — custom backend plugins
- `packages/app/` — frontend app
- `packages/backend/` — backend app
