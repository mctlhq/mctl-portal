# mctl-portal

Backstage service catalog for the mctl.ai platform. Available at `app.mctl.me`.

## What's here

- **Service catalog** — all platform services with ownership, docs, and links
- **Software templates** — scaffolders for new services, databases, and workspaces
- **TechDocs** — generated documentation for platform components
- **ArgoCD plugin** — deployment status inline in the catalog

## Local Development

```bash
yarn install
yarn start
```

Open `http://localhost:3000`.

Requires a GitHub token with `read:org` scope for org-level catalog ingestion.

## Deployment

Docker image `ghcr.io/mctlhq/mctl-portal:{version}` served via Kubernetes Deployment in the `admins` namespace.

ArgoCD syncs from `platform-gitops/services/admins/mctl-portal/values.yaml`.

## Key URLs

| URL | What |
|---|---|
| `app.mctl.me` | Backstage UI |
| `app.mctl.me/catalog` | Service catalog |
| `app.mctl.me/create` | Software templates |
| `app.mctl.me/docs` | TechDocs |

## Auth

GitHub OAuth — users sign in with their GitHub account. Access is restricted to members of the `mctlhq` GitHub org.

## Integration with mctl-api

Backstage templates can trigger platform operations via `api.mctl.ai`:

```
Scaffolder template → POST api.mctl.ai/api/v1/operations/deploy-service
                    → Argo Workflow → GitOps commit → ArgoCD sync
```
