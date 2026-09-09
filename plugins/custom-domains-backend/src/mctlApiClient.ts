import fetch, { RequestInit } from 'node-fetch';

/**
 * Shape the frontend card (packages/app/src/components/catalog/EntityDomainsCard.tsx)
 * has always rendered. mctl-api's registry (mctlhq/mctl-api, internal/domains
 * + internal/api/handlers_domains.go) uses different field names for the
 * same data — see toPortalDomain below for the mapping, verified directly
 * against that repo's source at HEAD (2026-09-09), not guessed.
 */
export interface CustomDomain {
  id: string;
  team: string;
  service: string;
  domain: string;
  auto_domain: string;
  status: string;
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** TXT record name the tenant must create. Only present while pending/failed. */
  challenge_record_name?: string;
  /** TXT record value the tenant must create. Only present while pending/failed. */
  challenge_record_value?: string;
}

export interface CreateDomainParams {
  team: string;
  service: string;
  domain: string;
  /**
   * The authenticated portal caller's userId. Logged locally for audit
   * purposes only — mctl-api's AddDomain derives created_by from the
   * identity attached to this client's own bearer token (the plugin's
   * shared service credential), not from any field in the request body, so
   * this is never sent upstream. See MctlApiDomainsClient.create.
   */
  actor: string;
}

export interface VerifyResult {
  verified: boolean;
  method?: string;
  reason?: string;
  expected_record: string;
  expected_value: string;
}

export interface RemoveResult {
  status: string;
  ingress_cleanup?: string;
  workflow_name?: string;
}

export interface DomainsClient {
  list(team: string, service?: string): Promise<CustomDomain[]>;
  create(params: CreateDomainParams): Promise<CustomDomain>;
  /**
   * team is required here (unlike mctl-api's own optional ?team=) because
   * this plugin no longer owns a local table it can use to look up which
   * team a bare id belongs to before authorizing the caller against it —
   * that lookup used to be store.getById. Without it, a caller could
   * otherwise verify/delete another team's domain by guessing its id, since
   * this client's own bearer token is a platform-wide service credential
   * that clears mctl-api's admin bypass regardless of team. Requiring team
   * here lets the router's existing authorizeForTeam gate stay in place
   * ahead of the call, exactly as it did for every other route.
   */
  verify(id: string, team: string): Promise<VerifyResult>;
  remove(id: string, team: string): Promise<RemoveResult>;
}

/**
 * Typed error for a failed mctl-api call. `status` is the HTTP status the
 * caller (router.ts) should reply with: the real upstream status for a 4xx
 * (so e.g. a 409 conflict on POST /domains reaches the portal caller as
 * 409), collapsed to 502 for anything else (5xx responses or a network
 * failure/timeout) so an upstream outage never reads as success.
 */
export class MctlApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MctlApiError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Maps one mctl-api domainResponse (internal/api/handlers_domains.go) —
 * *domains.Domain embedded plus challenge_record/challenge_value/cname_target
 * — onto the shape the frontend card already expects. Tolerates missing
 * optional fields (verified_at, challenge_record/value are omitempty on the
 * wire; a verified/active row carries neither) without throwing.
 */
export function toPortalDomain(raw: unknown): CustomDomain {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const optStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  return {
    id: str(r.id),
    team: str(r.team),
    service: str(r.service),
    domain: str(r.domain),
    // mctl-api computes this on the fly (Handlers.cnameTarget) rather than
    // storing it; it is not a proof-of-ownership artifact, so it stays
    // populated regardless of status, matching mctl-api's own behavior.
    auto_domain: str(r.cname_target),
    status: str(r.status) || 'pending',
    verified_at: typeof r.verified_at === 'string' ? r.verified_at : null,
    created_by: str(r.created_by),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    challenge_record_name: optStr(r.challenge_record),
    challenge_record_value: optStr(r.challenge_value),
  };
}

export class MctlApiDomainsClient implements DomainsClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(options: { baseUrl: string; token?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let resp;
    try {
      resp = await fetch(url, {
        ...options,
        headers: {
          ...this.headers(),
          ...((options?.headers as Record<string, string> | undefined) ?? {}),
        },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Never interpolate this.token here — err messages from node-fetch
      // and AbortSignal never echo request headers, but keeping the token
      // out of every thrown message by construction (not by care) is the
      // point.
      const message = err instanceof Error ? err.message : 'network error';
      throw new MctlApiError(502, `mctl-api request failed at ${path}: ${message}`);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status >= 400 && resp.status < 500) {
        // 4xx bodies are client-actionable (a 409 "domain already
        // registered", a 400 validation message) and router.ts's
        // respondToDomainsError forwards MctlApiError.message verbatim to
        // the browser, so include the body here.
        const detail = body ? `: ${body}` : '';
        throw new MctlApiError(resp.status, `mctl-api ${resp.status} at ${path}${detail}`);
      }
      // A 5xx body can carry a stack trace, framework error HTML, or other
      // internal detail. router.ts's respondToDomainsError forwards
      // MctlApiError.message verbatim to the browser, so — unlike the 4xx
      // branch above, where the body is genuinely client-actionable —
      // deliberately drop it here rather than let an authenticated tenant
      // user read mctl-api's internals through a routine 5xx.
      throw new MctlApiError(502, `mctl-api upstream error ${resp.status} at ${path}`);
    }

    // A successful response can still have an empty or non-JSON body (e.g. a
    // 204 No Content from DELETE — resp.ok is true, resp.json() would throw
    // a raw SyntaxError, and that error is not an MctlApiError, so it used
    // to be mapped to a generic 502 by respondToDomainsError even though the
    // upstream operation actually succeeded).
    const text = await resp.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MctlApiError(502, `mctl-api returned a non-JSON body at ${path}`);
    }
  }

  async list(team: string, service?: string): Promise<CustomDomain[]> {
    const params = new URLSearchParams({ team });
    if (service) {
      params.set('service', service);
    }
    const data = await this.request<{ domains: unknown[] }>(`/api/v1/domains?${params.toString()}`);
    return (data?.domains ?? []).map(toPortalDomain);
  }

  async create(params: CreateDomainParams): Promise<CustomDomain> {
    const raw = await this.request<unknown>('/api/v1/domains', {
      method: 'POST',
      body: JSON.stringify({
        team: params.team,
        service: params.service,
        domain: params.domain,
      }),
    });
    return toPortalDomain(raw);
  }

  async verify(id: string, team: string): Promise<VerifyResult> {
    const params = new URLSearchParams({ team });
    return this.request<VerifyResult>(
      `/api/v1/domains/${encodeURIComponent(id)}/verify?${params.toString()}`,
      { method: 'POST' },
    );
  }

  async remove(id: string, team: string): Promise<RemoveResult> {
    const params = new URLSearchParams({ team });
    return this.request<RemoveResult>(
      `/api/v1/domains/${encodeURIComponent(id)}?${params.toString()}`,
      { method: 'DELETE' },
    );
  }
}
