# WorkItem contract consumed by this plugin

Source: mctl-api `docs/work-context-contract.md` ("Surface relay (mctl-api#350)",
"Execution requests (mctl-api#368)") and `internal/openapi/openapi.yaml`, as of
mctl-api revision `7656351875a78989f65719908065e1206485ff57` (main, 2026-10-03).
WorkItem runtime API: mctl-api#349. Delegated surface identity: mctl-api#350.

## Identity model

- The portal authenticates as the `surface:portal` principal
  (`workItems.surfaceToken` = `MCTL_SURFACE_PORTAL_TOKEN`). It is non-admin, has no
  tenant and is confined to the relay allowlist. This plugin never reads
  `MCTL_API_TOKEN` or any admin credential.
- Every call carries `X-MCTL-Surface-Actor: <external id>`, derived from the
  caller's Backstage user entity ref (see "Actor id" below), resolved from a
  Backstage user credential only (service credentials are refused).
- mctl-api resolves the verified SurfaceIdentityLink for (`portal`, that id) and
  runs the handler as the linked human, with that human's tenant groups, never admin.
- mctl-api is the authorization authority. Ownership/visibility is the WorkItem
  `tenant` plus `visibility`; an item the caller may not see is 404. There is no
  `owner.team` field. The portal does not grant anything mctl-api refused.
- 403 codes on relay: `link_not_found`, `link_revoked`, `link_expired`,
  `relay_required`. The plugin maps these to `link_required` (the user must link
  the portal identity via `POST /surface-identities/redeem`); any other 403 is
  `forbidden`.

## Actor id

mctl-api bounds a portal external id with `^[A-Za-z0-9._:@|-]{1,256}$`
(`externalIDPattern[SurfacePortal]` in `internal/surfaceid/store.go`). Relay
routes and redeem answer 400 `invalid_request` for anything else, so a raw entity
ref such as `user:default/alice` (which contains `/`) cannot be sent.

Rule (`toSurfaceActorId` in `src/router.ts`):

- `user:<namespace>/<name>` becomes `user:<namespace>:<name>`, lowercased.
  Example: `user:default/Alice` -> `user:default:alice`.
- Only `user` refs are accepted. The namespace must be a DNS label
  (`[a-z0-9]+(-[a-z0-9]+)*`, max 63) and the name a Backstage object name
  (`[a-z0-9]+([-_.][a-z0-9]+)*`, max 63), which is Backstage's own grammar.
  A ref outside it is refused with 401; it is never escaped or truncated.
- Collision-free: neither part can contain `:` or `/`, so an id splits back into
  exactly one (namespace, name) pair. Lowercasing only merges refs that differ in
  case, which Backstage already treats as the same entity.
- The id uses only `[a-z0-9._:-]` and is at most 132 characters. The client
  checks it against the mctl-api pattern again and makes no request if it fails.
- The id is the key of every portal SurfaceIdentityLink. Changing this rule
  orphans existing links, so it is part of this contract.

## Relay allowlist (exact)

- `POST /api/v1/work-items`
- `GET /api/v1/work-items/{id}`
- `GET /api/v1/work-items/{id}/intents[/{intent_id}]`
- `GET|POST /api/v1/work-items/{id}/execution-requests[/{request_id}]`
  (the `{request_id}` form is GET only)
- `POST /api/v1/work-items/{id}/intents`, `POST /api/v1/work-items/{id}/surface-refs`
- `GET /api/v1/human-input[/{id}]`, `POST /api/v1/human-input/{id}/response`
- `POST /api/v1/surface-identities/redeem` (surface principal itself, with the actor header)

NOT relay routes today: `GET /work-items/{id}/executions`, `/snapshots`,
`/events`, `/evidence`, `/approvals`, and `POST /work-items/{id}/resume`. Sections
that depend on them are rendered `{state:'unknown', reason:'not_available_via_relay'}`.
This client only calls the routes it uses (`GET /work-items/{id}`,
`GET|POST /work-items/{id}/execution-requests`, `POST /surface-identities/redeem`)
and refuses anything outside the allowlist before any I/O. It does not create
work items (`POST /work-items` is on mctl-api's allowlist but not on this
client's). A refused route is a bug in the plugin: it is logged and the browser
gets a generic 502, never the internal path.

## Fields the mapper reads

`GET /work-items/{id}` -> `WorkItemView`:
`schema_version`, `state_version`, `work_item{id, tenant, visibility, origin_surface,
title, state (active|waiting|completed|superseded|archived), waiting_reason (input|approval),
superseded_by, state_version, created_at, updated_at, completed_at}`,
`latest_execution{id, attempt, phase, started_at, ended_at, resumed_from_execution_id}|null`
(engine and engine_ref are deliberately not forwarded),
`latest_snapshot{id, execution_id, content_hash}|null`.
`owner_principal`, `created_by` and `external_key` are not forwarded.

`GET /work-items/{id}/execution-requests` -> `{execution_requests: ExecutionRequest[]}`
(newest first, max 100): `id, kind (start|resume), state (pending|claimed|fulfilled|rejected),
surface, execution_id, reason, created_at, updated_at, closed_at`. `claimed_by`,
`requested_by` and idempotency keys are not forwarded.

`POST /work-items/{id}/execution-requests` body: `{kind, expected_state_version,
resumed_from_execution_id?, intent_id?, idempotency_key?}`. `engine`, `engine_ref`,
`execution_id` are refused by mctl-api (400 `execution_identity_not_accepted`) and are
never sent by this plugin. Errors pass through: 409 `state_version_conflict`,
`invalid_transition`, `execution_active`, `idempotency_key_reused`,
`execution_request_open`.

## Known gaps

- Read-only relay access to executions, snapshots (metadata), events and
  evidence: mctlhq/mctl-api#436. Until then those sections stay
  `not_available_via_relay`.
- Human input is not wired in this PR. mctl-api already has what the portal
  needs: `GET /human-input?work_item_id=<id>&state=pending` and
  `POST /human-input/{request_id}/response` (`{request_hash, value, surface?}`)
  are both relay routes, so no mctl-api follow-up is needed for it. Wiring it is
  portal-side follow-up work.
