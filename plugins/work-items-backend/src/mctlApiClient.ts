import type {
  CanvasLinkStatus,
  EvidenceRef,
  ExecutionRequestRef,
  ExecutionRef,
  Observed,
  PortalWorkItem,
  SnapshotRef,
  WorkItemEventRef,
} from './types';

/**
 * Client for the mctl-api WorkItem runtime API (mctl-api#349), reached as the
 * `surface:portal` principal with `X-MCTL-Surface-Actor` (mctl-api#350). The
 * pinned contract is in ../CONTRACT.md. Only routes on the relay allowlist are
 * callable; anything else throws before any I/O. This client never uses
 * the shared admin API token or any admin credential.
 */

export interface ClientLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: ClientLogger = { warn: () => {}, error: () => {} };

export class MctlApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'MctlApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

const ID = '[A-Za-z0-9_.:-]+';
/** Relay allowlist: method + path pattern (CONTRACT.md). */
const RELAY_ALLOWLIST: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: new RegExp(`^/api/v1/work-items/${ID}$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/work-items/${ID}/intents(/${ID})?$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/work-items/${ID}/execution-requests(/${ID})?$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/work-items/${ID}/execution-requests$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/work-items/${ID}/(intents|surface-refs)$`) },
  // Read-only history (mctl-api#436). `.../executions/{id}/snapshot` serves the
  // snapshot bytes and is deliberately not here; `.../snapshots/{id}` is left
  // out until something calls it with its own mapper.
  { method: 'GET', pattern: new RegExp(`^/api/v1/work-items/${ID}/(executions|snapshots|events|evidence)$`) },
  { method: 'GET', pattern: new RegExp(`^/api/v1/human-input(/${ID})?$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/human-input/${ID}/response$`) },
  { method: 'POST', pattern: /^\/api\/v1\/surface-identities\/redeem$/ },
];

export function isRelayAllowed(method: string, path: string): boolean {
  return RELAY_ALLOWLIST.some(r => r.method === method && r.pattern.test(path));
}

/** mctl-api internal/surfaceid/store.go externalIDPattern[SurfacePortal]. */
const PORTAL_EXTERNAL_ID = /^[A-Za-z0-9._:@|-]{1,256}$/;

const LINK_CODES = new Set(['link_not_found', 'link_revoked', 'link_expired', 'relay_required']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function safeHttpUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one link filter: an absolute http(s) URL, or a same-origin path. A
 * protocol-relative `//host` (or `/\\host`, which browsers treat the same
 * way) is not a same-origin path and is dropped.
 */
export function isSafeLink(url: string): boolean {
  if (safeHttpUrl(url)) return true;
  return /^\/(?![/\\])/.test(url);
}

function mapExecution(raw: unknown): ExecutionRef | undefined {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return undefined;
  return {
    id,
    attempt: typeof r.attempt === 'number' ? r.attempt : undefined,
    phase: str(r.phase) ?? 'unknown',
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
    resumedFromExecutionId: str(r.resumed_from_execution_id),
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Metadata only: `produced_by` and `canonical_b64` are never read. */
function mapSnapshot(raw: unknown): SnapshotRef | undefined {
  const r = obj(raw);
  const id = str(r?.id);
  const executionId = str(r?.execution_id);
  const contentHash = str(r?.content_hash);
  if (!r || !id || !executionId || !contentHash) return undefined;
  return {
    id,
    executionId,
    contentHash,
    executionSequence: num(r.execution_sequence),
    strategy: str(r.strategy),
    strategyVersion: str(r.strategy_version),
    priorSnapshotId: str(r.prior_snapshot_id),
    createdAt: str(r.created_at),
  };
}

/**
 * `envelope_b64`, `ingested_by*` and the derived `ref` (which carries engine
 * identity) are never read. mctl-api refuses evidence with neither an
 * execution id nor a runtime context id, so the primary ref is always set;
 * `execution_id` alone may be blank.
 */
function mapEvidence(raw: unknown): EvidenceRef | undefined {
  const r = obj(raw);
  const id = str(r?.id);
  const contentHash = str(r?.content_hash);
  const primaryRefKind = str(r?.primary_ref_kind);
  const primaryRefId = str(r?.primary_ref_id);
  if (!r || !id || !contentHash || !primaryRefKind || !primaryRefId) return undefined;
  return {
    id,
    executionId: str(r.execution_id),
    contentHash,
    apiVersion: str(r.api_version),
    createdAt: str(r.created_at),
    primaryRefKind,
    primaryRefId,
  };
}

/** `actor_principal`, `acting_principal`, `request_id` and `detail` are never read. */
function mapEvent(raw: unknown): WorkItemEventRef | undefined {
  const r = obj(raw);
  const seq = num(r?.seq);
  const kind = str(r?.kind);
  if (!r || seq === undefined || !kind) return undefined;
  return {
    seq,
    kind,
    fromState: str(r.from_state),
    toState: str(r.to_state),
    surface: str(r.surface),
    createdAt: str(r.created_at),
  };
}

/**
 * Maps every entry or nothing: one unrecognised entry makes the whole list
 * unrecognised, because a silently shorter list would read as a complete one.
 */
function mapAll<T>(list: unknown, map: (raw: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: T[] = [];
  for (const raw of list) {
    const m = map(raw);
    if (m === undefined) return undefined;
    out.push(m);
  }
  return out;
}

/** A bounded evidence page; `truncated` means older envelopes exist. */
export interface EvidencePage {
  evidence: EvidenceRef[];
  truncated: boolean;
  limit?: number;
}

/** The history sections, each observed (or not) on its own. */
export interface WorkItemHistory {
  executions: Observed<ExecutionRef[]>;
  snapshots: Observed<SnapshotRef[]>;
  evidence: Observed<EvidencePage>;
  events: Observed<WorkItemEventRef[]>;
}

export function toPortalExecutionRequest(raw: unknown): ExecutionRequestRef | undefined {
  const r = obj(raw);
  const id = str(r?.id);
  if (!r || !id) return undefined;
  return {
    id,
    kind: str(r.kind) ?? 'unknown',
    state: str(r.state) ?? 'unknown',
    surface: str(r.surface),
    executionId: str(r.execution_id),
    reason: str(r.reason),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    closedAt: str(r.closed_at),
  };
}

const NOT_VIA_RELAY: Observed<never> = { state: 'unknown', reason: 'not_available_via_relay' };

/**
 * Allow-list mapper: only fields pinned in CONTRACT.md are copied. Conversation
 * content, transcripts, engine identity and principals are never forwarded.
 */
export function toPortalWorkItem(
  view: unknown,
  executionRequests: Observed<ExecutionRequestRef[]>,
  history: WorkItemHistory,
  canvasLinks: { label: string; url: string }[] = [],
  canvasConfigured = false,
): PortalWorkItem {
  const v = obj(view);
  const w = obj(v?.work_item);
  const id = str(w?.id);
  if (!v || !w || !id) {
    throw new MctlApiError(502, 'mctl-api returned an unrecognised work item body');
  }
  let stateVersion = 0;
  if (typeof v.state_version === 'number') stateVersion = v.state_version;
  else if (typeof w.state_version === 'number') stateVersion = w.state_version;

  const exec = v.latest_execution === null ? null : mapExecution(v.latest_execution);
  const snap = v.latest_snapshot === null ? null : mapSnapshot(v.latest_snapshot);
  const links = canvasLinks.filter(l => isSafeLink(l.url));
  let canvas: CanvasLinkStatus;
  if (links.length > 0) canvas = 'ok';
  else if (!canvasConfigured) canvas = 'not_configured';
  else if (exec === null) canvas = 'no_execution';
  else canvas = 'unavailable';

  const ev = history.evidence;
  const evidence: Observed<EvidenceRef[]> = ev.state === 'unknown' ? ev : { ...ev, value: ev.value.evidence };
  const evidenceTruncated = ev.state !== 'unknown' && ev.value.truncated ? { limit: ev.value.limit } : undefined;

  return {
    id,
    title: str(w.title) ?? '',
    state: str(w.state) ?? 'unknown',
    waitingReason: str(w.waiting_reason),
    supersededBy: str(w.superseded_by),
    stateVersion,
    tenant: str(w.tenant),
    visibility: str(w.visibility),
    originSurface: str(w.origin_surface),
    createdAt: str(w.created_at),
    updatedAt: str(w.updated_at),
    completedAt: str(w.completed_at),
    latestExecution:
      exec === undefined ? { state: 'unknown', reason: 'unrecognised_shape' } : { state: 'ok', value: exec },
    latestSnapshot:
      snap === undefined ? { state: 'unknown', reason: 'unrecognised_shape' } : { state: 'ok', value: snap },
    executionRequests,
    executions: history.executions,
    snapshots: history.snapshots,
    evidence,
    evidenceTruncated,
    events: history.events,
    surfaces: NOT_VIA_RELAY,
    links,
    canvas,
  };
}

export interface CreateExecutionRequestParams {
  kind: 'start' | 'resume';
  expectedStateVersion: number;
  resumedFromExecutionId?: string;
  intentId?: number;
  idempotencyKey?: string;
}

export interface WorkItemsClient {
  isConfigured(): boolean;
  getWorkItem(id: string, actor: string): Promise<PortalWorkItem>;
  createExecutionRequest(
    id: string,
    actor: string,
    params: CreateExecutionRequestParams,
  ): Promise<{ executionRequest: ExecutionRequestRef; replay: boolean }>;
  redeemIdentity(code: string, actor: string): Promise<void>;
}

export class MctlApiWorkItemsClient implements WorkItemsClient {
  private readonly baseUrl: string;
  private readonly surfaceToken?: string;
  private readonly logger: ClientLogger;
  private readonly canvasTemplate?: string;

  constructor(options: {
    baseUrl: string;
    surfaceToken?: string;
    executionCanvasUrlTemplate?: string;
    logger?: ClientLogger;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.surfaceToken = options.surfaceToken || undefined;
    this.canvasTemplate = options.executionCanvasUrlTemplate;
    this.logger = options.logger ?? noopLogger;
  }

  isConfigured(): boolean {
    return Boolean(this.surfaceToken);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    actor: string,
    body?: unknown,
    idempotencyKey?: string,
    redact: string[] = [],
  ): Promise<{ status: number; json: unknown }> {
    // Values that must never reach a log line (the redeem code), even when
    // mctl-api or the network driver echoes them back.
    const scrub = (t: string) => redact.reduce((acc, v) => (v ? acc.split(v).join('[redacted]') : acc), t);
    if (!isRelayAllowed(method, path)) {
      // A programming error in this plugin, not an upstream answer: a plain
      // Error, so the router logs it and the browser sees only a generic 502.
      throw new Error(`route ${method} ${path} is not on the surface relay allowlist`);
    }
    if (!PORTAL_EXTERNAL_ID.test(actor)) {
      // mctl-api would answer 400 invalid_request; never send it.
      throw new Error('surface actor id does not match the mctl-api portal pattern');
    }
    if (!this.surfaceToken) {
      throw new MctlApiError(503, 'work items are not configured', 'work_items_unconfigured');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.surfaceToken}`,
      'X-MCTL-Surface-Actor': actor,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Log the driver message locally only; the thrown message names the
      // route and never the URL host, token or driver detail.
      this.logger.error(
        scrub(`mctl-api request failed for ${method} ${path}: ${err instanceof Error ? err.message : 'network error'}`),
      );
      throw new MctlApiError(502, 'mctl-api request failed');
    }

    const text = await resp.text().catch(() => '');
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!resp.ok) {
      const e = obj(parsed);
      const code = str(e?.code);
      const message = str(e?.error);
      if (resp.status === 403) {
        if (code && LINK_CODES.has(code)) {
          throw new MctlApiError(403, 'portal identity is not linked to a platform identity', 'link_required');
        }
        throw new MctlApiError(403, message ?? 'forbidden', 'forbidden');
      }
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 401) {
        throw new MctlApiError(resp.status, message ?? `mctl-api ${resp.status}`, code, e?.details);
      }
      // 401 means the portal's own surface token is wrong; 5xx bodies may carry
      // internals. Neither reaches the browser.
      this.logger.error(scrub(`mctl-api ${resp.status} for ${method} ${path}: ${text.slice(0, 500)}`));
      throw new MctlApiError(502, `mctl-api upstream error ${resp.status}`);
    }
    return { status: resp.status, json: parsed };
  }

  async getWorkItem(id: string, actor: string): Promise<PortalWorkItem> {
    const base = `/api/v1/work-items/${encodeURIComponent(id)}`;
    const view = await this.request('GET', base, actor);
    if (!obj(view.json)) {
      throw new MctlApiError(502, 'mctl-api returned an empty body');
    }

    // Only the item read above is fatal; every section below degrades alone.
    const [requests, executions, snapshots, evidence, events] = await Promise.all([
      this.observe(`${base}/execution-requests`, actor, b => mapAll(b.execution_requests, toPortalExecutionRequest)),
      this.observe(`${base}/executions`, actor, b => mapAll(b.executions, mapExecution)),
      this.observe(`${base}/snapshots`, actor, b => mapAll(b.snapshots, mapSnapshot)),
      this.observe(`${base}/evidence`, actor, (b): EvidencePage | undefined => {
        const list = mapAll(b.evidence, mapEvidence);
        // Without a readable `truncated` the page cannot be told complete.
        if (!list || typeof b.truncated !== 'boolean') return undefined;
        return { evidence: list, truncated: b.truncated, limit: num(b.limit) };
      }),
      this.observe(`${base}/events`, actor, b => mapAll(b.events, mapEvent)),
    ]);

    // Canvas link candidates go through the mapper, so one filter governs
    // every link the browser receives.
    return toPortalWorkItem(
      view.json,
      requests,
      { executions, snapshots, evidence, events },
      this.canvasLinks(id, view.json),
      !!this.canvasTemplate,
    );
  }

  /**
   * One section read: a recognised 2xx body is ok (an empty list included), an
   * unrecognised one is unknown, and any upstream answer (403, 404, 429, 5xx,
   * ...) is fetch_failed. Only a non-MctlApiError (a plugin bug such as an
   * allowlist violation) propagates.
   */
  private async observe<T>(
    path: string,
    actor: string,
    read: (body: Record<string, unknown>) => T | undefined,
  ): Promise<Observed<T>> {
    let json: unknown;
    try {
      json = (await this.request('GET', path, actor)).json;
    } catch (err) {
      if (err instanceof MctlApiError) return { state: 'unknown', reason: 'fetch_failed' };
      throw err;
    }
    const body = obj(json);
    const value = body ? read(body) : undefined;
    return value === undefined
      ? { state: 'unknown', reason: 'unrecognised_shape' }
      : { state: 'ok', value, observedAt: new Date().toISOString() };
  }

  private canvasLinks(id: string, view: unknown): { label: string; url: string }[] {
    const tpl = this.canvasTemplate;
    const exec = mapExecution(obj(view)?.latest_execution);
    if (!tpl || !exec) return [];
    const url = tpl
      .replace('{executionId}', encodeURIComponent(exec.id))
      .replace('{workItemId}', encodeURIComponent(id));
    return [{ label: 'Execution Canvas', url }];
  }

  async createExecutionRequest(
    id: string,
    actor: string,
    params: CreateExecutionRequestParams,
  ): Promise<{ executionRequest: ExecutionRequestRef; replay: boolean }> {
    // Deliberately no engine, engine_ref or execution_id: a surface requests
    // execution, it never declares execution identity.
    const body: Record<string, unknown> = {
      kind: params.kind,
      expected_state_version: params.expectedStateVersion,
    };
    if (params.resumedFromExecutionId) body.resumed_from_execution_id = params.resumedFromExecutionId;
    if (params.intentId !== undefined) body.intent_id = params.intentId;
    if (params.idempotencyKey) body.idempotency_key = params.idempotencyKey;
    const path = `/api/v1/work-items/${encodeURIComponent(id)}/execution-requests`;
    const res = await this.request('POST', path, actor, body, params.idempotencyKey);
    const mapped = toPortalExecutionRequest(obj(res.json)?.execution_request);
    if (!mapped) {
      throw new MctlApiError(502, 'mctl-api returned an empty body');
    }
    return { executionRequest: mapped, replay: res.status === 200 };
  }

  async redeemIdentity(code: string, actor: string): Promise<void> {
    await this.request('POST', '/api/v1/surface-identities/redeem', actor, { code }, undefined, [code]);
  }
}
