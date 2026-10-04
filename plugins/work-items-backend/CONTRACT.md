# WorkItem contract consumed by this plugin

Source: mctl-api `docs/work-context-contract.md` ("Surface relay (mctl-api#350)",
"Execution requests (mctl-api#368)"), `internal/openapi/openapi.yaml`, and for the
history shapes `internal/workitems` and `internal/evidence`, as of mctl-api revision
`768057717c66732b079bbd53ee160e78c0c5b151` (main, 2026-10-04).
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
- Only `user` refs are accepted. Namespace and name must both match
  `^[a-z0-9]([a-z0-9_.-]{0,61}[a-z0-9])?$` after lowercasing: Backstage's
  `isValidObjectName` (1-63 characters, first and last alphanumeric, `-`, `_`
  and `.` anywhere in between, repeats allowed). For names that is exactly
  Backstage's rule; for namespaces it is a superset of Backstage's default (a
  DNS label), so custom namespaces with `_` or `.` also work. Examples:
  `user:my_org/alice` -> `user:my_org:alice`, `user:default/john..doe` ->
  `user:default:john..doe`. A ref outside the grammar is refused with 401 and a
  warn log naming the ref. It is never escaped or truncated.
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
- Read-only history (mctl-api#436): `GET /api/v1/work-items/{id}/executions`,
  `GET /api/v1/work-items/{id}/snapshots`, `GET /api/v1/work-items/{id}/events`,
  `GET /api/v1/work-items/{id}/evidence`

NOT relay routes today: `GET /work-items/{id}/executions/{execution_id}/snapshot`
(it serves the snapshot bytes), `/approvals`, any write method on a history path,
and `POST /work-items/{id}/resume`. The surfaces section has no relay route and is
rendered `{state:'unknown', reason:'not_available_via_relay'}`.
This client only calls the routes it uses (`GET /work-items/{id}`,
`GET|POST /work-items/{id}/execution-requests`, the four history lists,
`POST /surface-identities/redeem`) and refuses anything outside the allowlist
before any I/O. mctl-api also relays `GET /work-items/{id}/snapshots/{snapshot_id}`
(metadata only), but nothing here calls it, so it stays off this client's
allowlist until a caller and its mapper land together. It does not create
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

### History sections (mctl-api#436)

`getWorkItem` reads the item first; only that read is fatal. It then reads
`execution-requests` and the four history lists in parallel, and each becomes
its own `Observed` section:

- a 2xx body whose list is present and every entry is recognised -> `ok` (an
  empty list is `ok` with `[]`, never unknown);
- a missing or non-array list, or any unrecognised entry -> `unknown` /
  `unrecognised_shape` (a list is mapped whole or not at all, so a dropped entry
  can never make the history look shorter than it is);
- any upstream error answer -> `unknown` / `fetch_failed`.

mctl-api returns a relayed history read in the same body as a direct read, so
the mapper is the allow-list.

Completeness: `executions`, `snapshots` and `events` return the item's full list
(mctl-api `Store.Executions`, `Store.Snapshots` and `Store.Events` select every row
of the item, with no limit), so an `ok` section is the whole history. Only
evidence is paged; see `truncated` below. If mctl-api ever bounds one of the three,
it must carry a completeness signal and this mapper must treat it like evidence.

`GET /work-items/{id}/executions` -> `{executions: WorkItemExecution[]}`:
`id, attempt, phase, started_at, ended_at, resumed_from_execution_id`. `engine` and
`engine_ref` are not forwarded.

`GET /work-items/{id}/snapshots` -> `{snapshots: ContextSnapshotSummary[]}`:
`id, execution_id, content_hash, execution_sequence, strategy, strategy_version,
prior_snapshot_id, created_at`. `produced_by` is not forwarded; `canonical_b64` is
never read (a relayed single-snapshot read is metadata only anyway).

`GET /work-items/{id}/evidence` -> `{evidence: Evidence[], truncated, limit}`, newest
first: `id, execution_id, content_hash, api_version, created_at, primary_ref_kind,
primary_ref_id`. `id`, `content_hash`, `primary_ref_kind` and `primary_ref_id` are
required; a row without one makes the section `unrecognised_shape`. `execution_id`
is optional: it is blank for evidence joined only to a runtime context, and
mctl-api refuses evidence with neither id, so the primary ref is always set.
`primary_ref_id` is forwarded on purpose: for kind `work` it is the work-item
execution id (`we_...`), and for kind `runtime` an opaque ADR 011 execution-context
id (`ex-` + 16 hex). Neither names an engine or an engine run; engine names and
`engine_ref` are never forwarded. `envelope_b64`, `ingested_by`, `ingested_by_principal_id` and the
derived `ref` (which carries engine identity) are not forwarded. `truncated` must be
a boolean or the section is `unrecognised_shape`; when it is true the portal sets
`evidenceTruncated: {limit}` and the page says it shows only the latest `limit`.

`GET /work-items/{id}/events` -> `{events: WorkItemEvent[]}`: `seq, kind, from_state,
to_state, surface, created_at`. `actor_principal`, `acting_principal`, `request_id`
and `detail` are not forwarded.

### Execution request body

`POST /work-items/{id}/execution-requests` body: `{kind, expected_state_version,
resumed_from_execution_id?, intent_id?, idempotency_key?}`. `engine`, `engine_ref`,
`execution_id` are refused by mctl-api (400 `execution_identity_not_accepted`) and are
never sent by this plugin. Errors pass through: 409 `state_version_conflict`,
`invalid_transition`, `execution_active`, `idempotency_key_reused`,
`execution_request_open`.

## Known gaps

- Relayed snapshot reads are metadata only: the portal cannot show a
  snapshot's canonical bytes (`.../executions/{execution_id}/snapshot` is not a
  relay route).
- Human input is not wired in this PR. mctl-api already has what the portal
  needs: `GET /human-input?work_item_id=<id>&state=pending` and
  `POST /human-input/{request_id}/response` (`{request_hash, value, surface?}`)
  are both relay routes, so no mctl-api follow-up is needed for it. Wiring it is
  portal-side follow-up work.
