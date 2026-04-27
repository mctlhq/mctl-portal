import {
  DiscoveryApi,
  FetchApi,
} from '@backstage/core-plugin-api';
import { ProposalDetail, ProposalSummary } from './types';

async function readJsonOrThrow(res: Response): Promise<any> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const msg = body?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export class ProposalsApi {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
  ) {}

  private async base(): Promise<string> {
    return this.discoveryApi.getBaseUrl('proposals');
  }

  async list(): Promise<ProposalSummary[]> {
    const url = `${await this.base()}/proposals`;
    const res = await this.fetchApi.fetch(url);
    const data = await readJsonOrThrow(res);
    return (data.proposals ?? []) as ProposalSummary[];
  }

  async get(service: string, slug: string): Promise<ProposalDetail> {
    const url = `${await this.base()}/proposals/${encodeURIComponent(
      service,
    )}/${encodeURIComponent(slug)}`;
    const res = await this.fetchApi.fetch(url);
    return (await readJsonOrThrow(res)) as ProposalDetail;
  }

  async accept(
    service: string,
    slug: string,
    notes?: string,
  ): Promise<void> {
    const url = `${await this.base()}/proposals/${encodeURIComponent(
      service,
    )}/${encodeURIComponent(slug)}/accept`;
    const res = await this.fetchApi.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes ?? '' }),
    });
    await readJsonOrThrow(res);
  }

  async reject(service: string, slug: string, notes: string): Promise<void> {
    const url = `${await this.base()}/proposals/${encodeURIComponent(
      service,
    )}/${encodeURIComponent(slug)}/reject`;
    const res = await this.fetchApi.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    await readJsonOrThrow(res);
  }
}
