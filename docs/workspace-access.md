# Workspace access and ready notifications

The canonical onboarding plan is maintained in
[mctl-web](https://github.com/mctlhq/mctl-web/blob/main/docs/plans/site-onboarding-review.md).
This document describes operating the portal implementation, not a second plan.

## Current access

`GET /api/tenant-management/me/workspace-access` requires a signed-in portal
user. User, tenant and principal request parameters cannot select another
identity. It reads current principal-keyed membership, the API's fresh platform
observation and the catalog's Group/User (including principal and role).
Unreachable, partial, stale or malformed observations return 503, never an empty
list or ready state. The browser refreshes `/workspace/access` every 30 seconds
and removes previously displayed access if the next check fails.

Readiness requires both namespaces' quotas, a Synced/Healthy tenant Application,
current API membership/role and converged portal catalog/sign-in configuration.
A principal's optional display login is not an authorization input: an unknown
account identifier is omitted. The API checks the active principal and keeps
customer MCP blocked until principal authorization and customer OAuth are
enabled. The readiness endpoint cannot enable either or bypass the launch gate.

## Delivery

`tenantManagement.workspaceReady.enabled` defaults to false. When enabled,
`resendApiKey` is required and is secret-only configuration. A scheduled task
checks pending customer owners every minute, with failure backoff from one to
15 minutes. Accepted/terminal jobs are skipped before platform/catalog reads.
The source email comes from the verified customer-create contact address.
Provisioning does not depend on the notification task or provider availability.

The `tenant-management.workspace_ready_emails` table keeps one durable record
per tenant/principal, including the exact frozen payload, snapshot timestamp,
provider id and delivery state. Claims are atomic across replicas. Retries use
the same payload and provider idempotency key. `accepted` means the provider
accepted the message, not that the recipient received or read it.

Resend retains idempotency keys for 24 hours. Ambiguous attempts stop after
23 hours with `status = reconcile` and `reconcile_reason = dedup_window_expired`.
A changed recipient or withdrawn snapshot capability also becomes `reconcile`
with `recipient_or_grants_changed`: a previous timed-out send may already have
been delivered, so automatically creating a new key could violate the one-email
contract. Both transitions emit a warning once. Reconciliation is explicit and
does not affect access or the current Access page.

Inspect metadata without dumping email addresses or message payloads:

```sql
SELECT id, tenant_name, principal_id, status, reconcile_reason,
       first_attempt_ms, provider_id, accepted_ms
FROM "tenant-management".workspace_ready_emails
WHERE status = 'reconcile';
```

Reconcile with the provider's delivery records. If acceptance is confirmed,
record the provider id and mark the existing row accepted. If acceptance cannot
be established or excluded, retain the ambiguous state. Never reset the first
attempt timestamp, delete the row, change its idempotency key or create a new
generation just to make a retry run. A reused tenant name must not resurrect a
notification already delivered for that principal.

The ready email is a dated snapshot containing only verified capabilities. It
links to the Access page for current permissions and never lists ArgoCD,
Workflows or kubectl merely because those services exist. Extended grants and
revocation remain the separate Stage E initiative.

## Configuration

Portal links use `app.baseUrl`; MCP uses `/mcp` at `workItems.baseUrl`. Display account
identifiers use `platform.domain`. `tenantManagement.workspaceReady.from`
overrides the sender, which otherwise uses `noreply@<platform.domain>`.
`maxObservationAgeSeconds` and `maxFutureClockSkewSeconds` under
`tenantManagement.workspaceReady` independently default to 300 seconds. Invalid
values fail startup; observations outside these bounds fail explicitly and are
logged without being treated as ready. Workflow links use the configured Argo
Workflows base URL. Production defaults use `mctl.ai`.
