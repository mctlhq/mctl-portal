import type { ExecutionRequestRef, ExecutionRef, Observed, PortalWorkItem, SnapshotRef } from './types';

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
  { method: 'GET', pattern: new RegExp(`^/api/v1/human-input(/${ID})?$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/human-input/${ID}/response$`) },
  { method: 'POST', pattern: /^\/api\/v1\/surface-identities\/redeem$/ },
];

export function isRelayAllowed(method: string, path: string): boolean {
  return RELAY_ALLOWLIST.some(r => r.method === method && r.pattern.test(path));
}

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

function mapSnapshot(raw: unknown): SnapshotRef | undefined {
  const r = obj(raw);
  const id = str(r?.id);
  const executionId = str(r?.execution_id);
  const contentHash = str(r?.content_hash);
  if (!id || !executionId || !contentHash) return undefined;
  return { id, executionId, contentHash };
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
  canvasLinks: { label: string; url: string }[] = [],
): PortalWorkItem {
  const v = obj(view);
  const w = obj(v?.work_item);
  const id = str(w?.id);
  if (!v || !w || !id) {
    throw new MctlApiError(502, 'mctl-api returned an unrecognised work item body');
  }
  const stateVersion =
    typeof v.state_version === 'number'
      ? v.state_version
      : typeof w.state_version === 'number'
        ? w.state_version
        : 0;

  const exec = v.latest_execution === null ? null : mapExecution(v.latest_execution);
  const snap = v.latest_snapshot === null ? null : mapSnapshot(v.latest_snapshot);

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
    executions: NOT_VIA_RELAY,
    snapshots: NOT_VIA_RELAY,
    evidence: NOT_VIA_RELAY,
    surfaces: NOT_VIA_RELAY,
    links: canvasLinks.filter(l => safeHttpUrl(l.url)),
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
  ): Promise<{ status: number; json: unknown }> {
    if (!isRelayAllowed(method, path)) {
      throw new MctlApiError(500, `route ${method} ${path} is not on the surface relay allowlist`);
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
      this.logger.error(`mctl-api request failed for ${method} ${path}: ${err instanceof Error ? err.message : 'network error'}`);
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
      this.logger.error(`mctl-api ${resp.status} for ${method} ${path}: ${text.slice(0, 500)}`);
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

    let requests: Observed<ExecutionRequestRef[]>;
    try {
      const r = await this.request('GET', `${base}/execution-requests`, actor);
      const list = obj(r.json)?.execution_requests;
      requests = Array.isArray(list)
        ? {
            state: 'ok',
            value: list.map(toPortalExecutionRequest).filter((x): x is ExecutionRequestRef => !!x),
            observedAt: new Date().toISOString(),
          }
        : { state: 'unknown', reason: 'unrecognised_shape' };
    } catch (err) {
      // The item itself was readable; degrade only this section.
      if (err instanceof MctlApiError && (err.status === 403 || err.status === 404 || err.status === 502)) {
        requests = { state: 'unknown', reason: 'fetch_failed' };
      } else {
        throw err;
      }
    }

    const mapped = toPortalWorkItem(view.json, requests);
    return { ...mapped, links: this.canvasLinks(mapped) };
  }

  private canvasLinks(item: PortalWorkItem): { label: string; url: string }[] {
    const tpl = this.canvasTemplate;
    const exec = item.latestExecution.state === 'ok' ? item.latestExecution.value : null;
    if (!tpl || !exec) return [];
    const url = tpl
      .replace('{executionId}', encodeURIComponent(exec.id))
      .replace('{workItemId}', encodeURIComponent(item.id));
    return safeHttpUrl(url) || url.startsWith('/') ? [{ label: 'Execution Canvas', url }] : [];
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
    await this.request('POST', '/api/v1/surface-identities/redeem', actor, { code });
  }
}
