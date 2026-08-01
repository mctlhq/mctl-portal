# Platform Conventions

This document defines naming rules, terminology, and template taxonomy for the mctl.me platform. Consistency matters: developers interact with the platform through Backstage UI and the `mctl` CLI — the language here is what they see.

---

## Terminology

Platform-facing terms deliberately avoid Kubernetes/infrastructure jargon.

| Infrastructure term | Platform term |
|---|---|
| Component / Service | **Service** |
| Worker (no HTTP) | **Background Service** |
| Deploy | **Release** |
| Delete / Remove | **Retire** |
| Update config / env | **Manage Environment** |
| Provision DB | **Provision Database** |
| Namespace | **Workspace** |
| Cluster | **Platform** |
| Secrets | **Secure Variables** |
| ArgoCD Application | *(internal — never surfaced to users)* |

---

## Catalog Entity Hierarchy

Backstage organises everything in a three-level hierarchy:

| Entity | What it is | Example |
|---|---|---|
| **System** | A logical product boundary — groups related components, APIs and resources under one roof | `platform` — the mctl.me platform |
| **Component** | A single deployable unit (service, website, worker) | `landing-page`, `billing-api` |
| **Resource** | A backing resource owned by a team (database, queue, bucket) | `payments-billing-db` |

Every `Component` should declare `spec.system: platform` so it appears under the platform system page in the catalog.

A `System` entity must be explicitly registered in the catalog before any component can link to it — otherwise Backstage shows "Entity not found". The `platform` system is registered at `platform-gitops/catalog-info.yaml`.

---

## Template Type Taxonomy

Every Backstage scaffolder template has a `spec.type` that classifies its intent:

| Type | When to use | Examples |
|---|---|---|
| `deployment` | Creates or updates running workloads | Release Service |
| `configuration` | Changes settings of an existing resource | Manage Environment |
| `lifecycle` | Removes or decommissions a resource | Retire Service |
| `provisioning` | Creates a new backing resource (DB, queue, etc.) | Provision Database |

---

## Naming Principles

1. **No Kubernetes terms in user-facing UI.** Users never see "pod", "namespace", "CRD", "ArgoCD", or "Helm" in template titles, descriptions, or output messages.

2. **Use soft, action-oriented verbs.** Prefer *Release*, *Retire*, *Provision*, *Manage* over *Deploy*, *Delete*, *Create*, *Update*.

3. **Platform abstractions, not implementation details.** Say "the service will be available in ~2 minutes" not "ArgoCD will reconcile the Helm chart".

4. **Consistent slug format.** All team names, service names, and database names use `kebab-case` (`^[a-z0-9][a-z0-9-]{0,30}$`). PostgreSQL role/database names use the same slug (CNPG operator quotes them automatically).

5. **Resource naming derived from `{team}-{app}`.** All platform resources for a given service follow a single pattern:

   | Resource | Pattern | Example |
   |---|---|---|
   | K8s resources (service, secret, etc.) | `{team}-{app}` | `payments-billing` |
   | K8s Database CRD | `{team}-{app}-db` | `payments-billing-db` |
   | K8s Secret (DB creds) | `{team}-{app}-db-creds` | `payments-billing-db-creds` |
   | PostgreSQL role | `{team}-{app}` | `payments-billing` |
   | PostgreSQL database | `{team}-{app}` | `payments-billing` |
   | Vault path (DB) | `teams/{team}/{app}/database` | `teams/payments/billing/database` |
   | Vault path (env secrets) | `teams/{team}/{service}` | `teams/payments/billing` |
   | ArgoCD app *(internal)* | `preview-{team}-{app}` | `preview-payments-billing` |

---

## Workflow File Naming

GitHub Actions workflow files in `.github/workflows/` follow the same platform verb convention:

| Workflow file | Platform action |
|---|---|
| `release-service.yml` | Release Service |
| `retire-service.yml` | Retire Service |
| `provision-db.yml` | Provision Database |
| `sync-argocd-teams.yml` | *(internal, not user-facing)* |
| `auto-merge.yml` | *(internal)* |
| `terraform.yml` | *(internal)* |
