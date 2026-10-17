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

The readiness API service contract is separate from work-item relay headers:
`GET /api/v1/surface-principals/workspace-access/{tenant}` accepts only the portal
surface token and `X-MCTL-Surface-Actor: principal:<canonical principal ID>`.
The principal ID preserves canonical case; catalog User names use its lowercase
form. This endpoint does not accept delegated work-item credentials and grants
no permissions. Production verification reached the readiness sources with this
contract; a forbidden quota read returned 503 rather than a false ready result.

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

Explicit provider refusal (400/401/403/404/422/429) preserves retry eligibility
when no earlier ambiguous attempt exists. Transport errors, 5xx and idempotency
conflicts remain ambiguous; a later refusal never erases an earlier ambiguity.
Correcting credentials or verifying the sender therefore recovers previously
refused sends without reopening potentially delivered ones.

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
logged without being treated as ready. Workflow links use the browser-facing `platform.argoWorkflowsBaseUrl`. Production defaults use `mctl.ai`.

Tenant contact addresses remain private portal database state. TenantSync never
imports contact data from public GitOps and omission during sync preserves the
existing private address. Missing/invalid contacts produce a retry warning with
backoff, rather than silently skipping a promised notification. For an existing
workspace affected by historical sync erasure, restore the address only from
the verified ZITADEL customer mapped to its current canonical owner; never put
it into GitOps values or log the address.

Customer `creatorIdToken` requests require a valid `contactEmail` or receive 400
before any write. The deployed mctl-web 7.8.1 worker already sends the verified
session email in this field. The workflow still receives `contact_email=` as
an empty compatibility parameter; private contact data is never forwarded.

A frozen snapshot can be replaced under its delivery lease only when no prior
ambiguous/crashed attempt exists (all earlier sends were explicitly refused).
The provider idempotency key remains unchanged. If Resend remembers the old
refused payload, retries wait out its key retention rather than minting a new
key. Any earlier ambiguous attempt instead requires provider reconciliation.


## Account-deletion recovery

A complete customer deletion is an irreversible operation with a durable API
manifest. Portal `prepare` freezes the exact principal before teardown; failure
or workflow cancellation does not reactivate old credentials. Retry the same
MCP deletion with `delete_customer_account=true` and the original
`customer_principal_id`. The API resumes its immutable manifest, including after
GitOps membership or the ZITADEL user has disappeared. No SQL unfreeze is needed.
A standalone portal cancel route would be unsafe after another provider already
revoked or deleted identity state, so recovery resumes deletion instead.

The root fence initializes and awaits its schema before observing revocations;
failed reads are logged and return 503, never a clean result. Its indexed reads
are deliberately uncached to invalidate a customer across portal replicas
immediately. Completed tombstones remain: a re-registering GitHub identity gets
a new ZITADEL subject and a new API principal ID, never the deleted principal.

Ready-email preparation, lease acquisition and tenant deletion serialize on the
same tenant lifecycle lock. Preparation and claim recheck current principal
membership and deletion state, so a stale scheduler snapshot cannot recreate
contact data or deliver a first notification after cleanup.
