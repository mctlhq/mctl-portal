import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { WorkItem } from './types';

/** Error carrying the HTTP status and mctl-api's typed code, shown as returned. */
export class WorkItemsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkItemsApiError';
  }
}

async function readJsonOrThrow(res: Response): Promise<any> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    throw new WorkItemsApiError(res.status, body?.error || `HTTP ${res.status}`, body?.code);
  }
  return body;
}

export class WorkItemsApi {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
  ) {}

  private async base(): Promise<string> {
    return this.discoveryApi.getBaseUrl('work-items');
  }

  async get(id: string): Promise<WorkItem> {
    const res = await this.fetchApi.fetch(`${await this.base()}/work-items/${encodeURIComponent(id)}`);
    return (await readJsonOrThrow(res)) as WorkItem;
  }

  async redeem(code: string): Promise<void> {
    const res = await this.fetchApi.fetch(`${await this.base()}/surface-identities/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    await readJsonOrThrow(res);
  }

  async requestExecution(
    id: string,
    params: {
      kind: 'start' | 'resume';
      expectedStateVersion: number;
      resumedFromExecutionId?: string;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    const res = await this.fetchApi.fetch(
      `${await this.base()}/work-items/${encodeURIComponent(id)}/execution-requests`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
    );
    await readJsonOrThrow(res);
  }
}
