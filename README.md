# mctl-portal

Backstage-based Internal Developer Platform portal — the central hub for the mctl.ai platform.

## What It Does

mctl-portal provides a unified developer experience for service catalog browsing, self-service
infrastructure provisioning, and team workspace management. Built on Backstage v1.47.0, it
combines 23+ community plugins with 8 custom backend plugins to deliver multi-tenancy, OIDC
identity federation, Vault secret delivery, and real-time Kubernetes resource monitoring.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        app.mctl.ai                              │
├────────────────────────────┬────────────────────────────────────┤
│   Frontend (React :3000)   │     Backend (Node.js :7007)        │
│                            │                                    │
│  Service Catalog UI        │  23+ Backstage plugins             │
│  Software Scaffolder       │  8 custom backend plugins          │
│  TechDocs Viewer           │  GitHub OAuth / Guest auth         │
│  Resource Monitoring       │  PostgreSQL (prod) / SQLite (dev)  │
│  Custom Domain Mgmt        │                                    │
└────────────┬───────────────┴──────────┬─────────────────────────┘
             │                          │
     ┌───────▼───────┐        ┌────────▼─────────┐
     │  GitHub APIs   │        │  Platform APIs    │
     │  OAuth + App   │        │  Argo Workflows   │
     │  Actions Logs  │        │  ArgoCD           │
     └───────────────┘        │  Vault             │
                               │  Kubernetes API    │
                               └──────────────────┘
```

## Tech Stack

| Category | Details |
|----------|---------|
| Frontend | TypeScript, React |
| Backend | TypeScript, Node.js |
| Framework | Backstage v1.47.0 |
| Runtime | Node.js 22 or 24 |
| Package Manager | Yarn 4.4.1 (monorepo workspaces) |
| Unit Tests | Jest 30.2.0 |
| E2E Tests | Playwright 1.32.3 |
| Database | PostgreSQL (production), SQLite (development) |
| Container | Multi-stage Docker build, published to GHCR |

## Project Structure

```
mctl-portal/
├── packages/
│   ├── app/                        # Backstage frontend (React)
│   │   └── src/
│   │       ├── App.tsx             # Routes, UI, themes
│   │       ├── apis.ts            # API integration
│   │       ├── platformConfig.ts  # Environment config
│   │       ├── components/        # Custom React components
│   │       └── theme/             # mctl custom theme
│   └── backend/                    # Backstage backend (Node.js)
│       └── src/
│           ├── index.ts            # Plugin registration (23+)
│           ├── githubAuthModule.ts # OAuth fallback for new users
│           └── scaffolder-filters.ts # Custom Nunjucks filters
├── plugins/                        # 8 custom backend plugins
│   ├── argo-workflows-backend/
│   ├── custom-domains-backend/
│   ├── github-app-connect-backend/
│   ├── oidc-provider-backend/
│   ├── permission-backend-module-team-policy/
│   ├── resource-usage-backend/
│   ├── tenant-backend/
│   └── vault-secrets-backend/
├── examples/                       # Sample catalog entities & templates
├── app-config.yaml                 # Local dev configuration
├── app-config.production.yaml      # Production configuration
├── Dockerfile                      # Multi-stage Docker build
├── playwright.config.ts            # E2E test configuration
└── catalog-info.yaml               # Self-registration in catalog
```

## Custom Plugins

The platform ships 8 custom backend plugins that extend Backstage with mctl-specific capabilities:

| Plugin | Purpose |
|--------|---------|
| `tenant-backend` | Multi-tenant workspace management — member invites, quota distribution, namespace isolation |
| `github-app-connect-backend` | Self-service GitHub App installation, Actions log streaming, catalog discovery |
| `argo-workflows-backend` | Argo Workflow submission directly from scaffolder templates |
| `oidc-provider-backend` | OIDC identity provider for downstream services (ArgoCD, Dex, Argo Workflows) |
| `vault-secrets-backend` | Secure credential delivery from HashiCorp Vault to authorized users |
| `resource-usage-backend` | Kubernetes namespace quota monitoring and live resource metrics display |
| `permission-backend-module-team-policy` | Team-based catalog entity filtering via RBAC policies |
| `custom-domains-backend` | Custom domain route mapping and management for deployed services |

Core Backstage plugins (catalog, scaffolder, techdocs, kubernetes, org, search, notifications,
signals, permission, user-settings, catalog-graph, api-docs, proxy, app-backend, and others)
are registered in `packages/backend/src/index.ts`.

## Getting Started

### Prerequisites

- Node.js 22 or 24
- Yarn 4.4.1
- GitHub token with `read:org` scope (for catalog ingestion)
- PostgreSQL (optional — SQLite is used by default in development)

### Local Development

```bash
yarn install          # Install all dependencies
yarn start            # Start frontend (:3000) + backend (:7007)
```

Open `http://localhost:3000`. The backend API is available at `http://localhost:7007`.

Authentication defaults to guest mode in local development. For GitHub OAuth,
configure `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` in your environment.

### Docker

```bash
yarn build-image      # Build multi-stage Docker image
```

The image is published to `ghcr.io/mctlhq/mctl-portal:{version}` during CI.

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GITHUB_TOKEN` | Org catalog discovery (`read:org` scope) | — | Yes |
| `GITHUB_APP_ID` | GitHub App numeric ID | — | Yes |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) | — | Yes |
| `AUTH_GITHUB_CLIENT_ID` | GitHub OAuth Client ID | — | Yes |
| `AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | — | Yes |
| `POSTGRES_HOST` | PostgreSQL host | — | Yes |
| `POSTGRES_PORT` | PostgreSQL port | `5432` | Yes |
| `POSTGRES_USER` | PostgreSQL user | — | Yes |
| `POSTGRES_PASSWORD` | PostgreSQL password | — | Yes |
| `VAULT_ADDR` | HashiCorp Vault URL | — | Yes |
| `K8S_SERVICE_ACCOUNT_TOKEN` | Kubernetes API token | — | Yes |
| `APP_BASE_URL` | Public-facing portal URL | — | Yes |
| `ARGO_WORKFLOWS_URL` | Argo Workflows API endpoint | — | No |
| `ARGOCD_BASE_URL` | ArgoCD server URL | — | No |

### Config Files

| File | Purpose |
|------|---------|
| `app-config.yaml` | Local development — SQLite, guest auth, localhost URLs |
| `app-config.production.yaml` | Production — PostgreSQL, GitHub OAuth, real service URLs |
| `backstage.json` | Backstage framework version metadata |
| `catalog-info.yaml` | Self-registration of mctl-portal in the service catalog |

## Testing

```bash
yarn test             # Unit tests (modified packages only)
yarn test:all         # All unit tests with coverage
yarn test:e2e         # Playwright end-to-end tests
yarn tsc              # TypeScript type checking
yarn lint             # ESLint (modified packages)
yarn lint:all         # ESLint (all packages)
yarn prettier:check   # Formatting check
yarn fix              # Auto-fix lint issues
```

## CI/CD

The `build.yml` workflow runs on every push to `main` and on pull requests:

1. **Checkout** — clone repository
2. **Setup** — Node.js 22, Yarn 4.4.1
3. **Validate** — TypeScript type checking
4. **Build** — compile backend and all packages
5. **Version** (main only) — semantic version from commit messages
6. **Tag** (main only) — create git tag
7. **Docker** (main only) — multi-stage build, push to GHCR
8. **Security** (main only) — Trivy container scan
9. **Deploy** (main only) — update image tag in mctl-gitops
10. **Notify** — Telegram alert on failure

Semantic versioning follows conventional commits:

| Prefix | Version Bump |
|--------|-------------|
| `feat!:` | Major |
| `feat:` | Minor |
| `fix:` | Patch |

Container images are published to `ghcr.io/mctlhq/mctl-portal`.

## Deployment

mctl-portal runs in the `admins` Kubernetes namespace. ArgoCD continuously syncs
the desired state from `mctl-gitops/services/admins/mctl-portal/values.yaml`.

Authentication in production uses GitHub OAuth, restricted to members of the `mctlhq`
GitHub organization. The OIDC provider plugin federates identity to downstream services
(ArgoCD, Dex, Argo Workflows).

## Release Process

1. Merge PR to `main` using conventional commit prefixes
2. CI derives the next semantic version automatically
3. Git tag is created and Docker image is built
4. Image is pushed to `ghcr.io/mctlhq/mctl-portal:{version}`
5. Trivy scans the image for vulnerabilities
6. CI updates the image tag in `mctl-gitops`
7. ArgoCD detects the change and syncs the new version to the cluster

## Key URLs

| URL | Description |
|-----|-------------|
| `app.mctl.ai` | Backstage portal |
| `app.mctl.ai/catalog` | Service catalog |
| `app.mctl.ai/create` | Software scaffolder templates |
| `app.mctl.ai/docs` | TechDocs documentation |
| `app.mctl.ai/api-docs` | API documentation |

## Related Projects

| Repository | Description |
|------------|-------------|
| [mctl-api](https://github.com/mctlhq/mctl-api) | Platform control plane API |
| [mctl-agent](https://github.com/mctlhq/mctl-agent) | AI-powered Copilot extension for platform operations |
| [mctl-gitops](https://github.com/mctlhq/mctl-gitops) | GitOps manifests and Helm values |
| [mctl-web](https://github.com/mctlhq/mctl-web) | Marketing website (mctl.ai) |

## License

Apache 2.0
