import fetch from 'node-fetch';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import { Config } from '@backstage/config';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import {
  ProposalDetail,
  ProposalDocuments,
  ProposalStatus,
  ProposalSummary,
  StatusYaml,
} from './types';

export interface GitopsClientOptions {
  org: string;
  repo: string;
  branch: string;
  basePath: string;
  integrations: ScmIntegrations;
  credentialsProvider: DefaultGithubCredentialsProvider;
  logger: LoggerService;
}

interface ContentItem {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
}

interface FileContent {
  type: 'file';
  encoding: 'base64';
  content: string;
  sha: string;
  path: string;
}

const DOC_FILES = [
  'requirements.md',
  'design.md',
  'tasks.md',
  'proposed-content.md',
] as const;

const VALID_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  'proposed',
  'accepted',
  'in-progress',
  'implemented',
  'rejected',
]);

/** Thrown when a `.status.yaml` write loses a race with a concurrent writer. */
export class GitopsConflictError extends Error {}

/**
 * Wraps GitHub REST API calls for the proposals workflow.
 *
 * Auth uses Backstage's standard ScmIntegrations + DefaultGithubCredentialsProvider,
 * so the same configuration that powers catalog discovery (static token in
 * `integrations.github[0].token` for local dev, GitHub App for production) is
 * reused — no new secret needed.
 */
export class GitopsClient {
  private readonly apiBase: string;
  private readonly repoUrl: string;

  constructor(private readonly opts: GitopsClientOptions) {
    const integration = opts.integrations.github.byUrl(
      `https://github.com/${opts.org}/${opts.repo}`,
    );
    if (!integration) {
      throw new Error(
        `No GitHub integration found for ${opts.org}/${opts.repo}. ` +
          'Configure integrations.github in app-config.yaml.',
      );
    }
    this.apiBase =
      integration.config.apiBaseUrl ?? 'https://api.github.com';
    this.repoUrl = `https://github.com/${opts.org}/${opts.repo}`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const creds = await this.opts.credentialsProvider.getCredentials({
      url: this.repoUrl,
    });
    return {
      ...(creds.headers ?? {}),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async getContent(path: string): Promise<ContentItem[] | null> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/repos/${this.opts.org}/${this.opts.repo}/contents/${path}?ref=${this.opts.branch}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} on GET ${path}: ${await res.text()}`,
      );
    }
    const body = (await res.json()) as ContentItem[] | ContentItem;
    return Array.isArray(body) ? body : [body];
  }

  private async getFile(
    path: string,
  ): Promise<{ content: string; sha: string } | null> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/repos/${this.opts.org}/${this.opts.repo}/contents/${path}?ref=${this.opts.branch}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} on GET ${path}: ${await res.text()}`,
      );
    }
    const body = (await res.json()) as FileContent;
    if (body.type !== 'file' || body.encoding !== 'base64') {
      throw new Error(`Unexpected GitHub content shape for ${path}`);
    }
    const decoded = Buffer.from(body.content, 'base64').toString('utf-8');
    return { content: decoded, sha: body.sha };
  }

  private parseStatusYaml(raw: string): StatusYaml {
    const parsed = yamlLoad(raw) as Partial<StatusYaml> | undefined | null;
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'proposed' };
    }
    const status = VALID_STATUSES.has(parsed.status as ProposalStatus)
      ? (parsed.status as ProposalStatus)
      : 'proposed';
    return {
      status,
      updated_at: parsed.updated_at,
      updated_by: parsed.updated_by,
      pr: parsed.pr,
      notes: parsed.notes,
    };
  }

  /** List all `<service>/proposals/<slug>` pairs under `basePath`. */
  async listProposals(): Promise<ProposalSummary[]> {
    const services = await this.getContent(this.opts.basePath);
    if (!services) {
      this.opts.logger.warn(
        `[proposals-backend] basePath ${this.opts.basePath} not found`,
      );
      return [];
    }

    const out: ProposalSummary[] = [];

    for (const svcEntry of services) {
      if (svcEntry.type !== 'dir') continue;
      // Skip mentor / archive folders that don't follow the proposals convention.
      if (svcEntry.name.startsWith('_')) continue;

      const proposalsDir = `${this.opts.basePath}/${svcEntry.name}/proposals`;
      const slugs = await this.getContent(proposalsDir);
      if (!slugs) continue;

      for (const slugEntry of slugs) {
        if (slugEntry.type !== 'dir') continue;

        const statusPath = `${proposalsDir}/${slugEntry.name}/.status.yaml`;
        let status: StatusYaml = { status: 'proposed' };
        try {
          const file = await this.getFile(statusPath);
          if (file) status = this.parseStatusYaml(file.content);
        } catch (err) {
          this.opts.logger.warn(
            `[proposals-backend] Could not read ${statusPath}: ${err}`,
          );
        }

        out.push({
          service: svcEntry.name,
          slug: slugEntry.name,
          status: status.status,
          updated_at: status.updated_at,
          updated_by: status.updated_by,
          pr: status.pr,
          notes: status.notes,
        });
      }
    }

    return out;
  }

  /** Fetch a single proposal with all four markdown files + status. */
  async getProposal(
    service: string,
    slug: string,
  ): Promise<ProposalDetail | null> {
    const dir = `${this.opts.basePath}/${service}/proposals/${slug}`;
    const docs: ProposalDocuments = {};
    let foundAny = false;

    for (const filename of DOC_FILES) {
      const file = await this.getFile(`${dir}/${filename}`);
      if (!file) continue;
      foundAny = true;
      switch (filename) {
        case 'requirements.md':
          docs.requirements = file.content;
          break;
        case 'design.md':
          docs.design = file.content;
          break;
        case 'tasks.md':
          docs.tasks = file.content;
          break;
        case 'proposed-content.md':
          docs.proposedContent = file.content;
          break;
        default:
          break;
      }
    }

    if (!foundAny) return null;

    let status: StatusYaml = { status: 'proposed' };
    const statusFile = await this.getFile(`${dir}/.status.yaml`);
    if (statusFile) status = this.parseStatusYaml(statusFile.content);

    return {
      service,
      slug,
      status: status.status,
      updated_at: status.updated_at,
      updated_by: status.updated_by,
      pr: status.pr,
      notes: status.notes,
      documents: docs,
    };
  }

  /**
   * Write `.status.yaml` for a proposal. Reads current sha first (if any) so the
   * Contents API call updates rather than 422s.
   */
  async writeStatus(
    service: string,
    slug: string,
    payload: StatusYaml,
    commitMessage: string,
  ): Promise<void> {
    const path = `${this.opts.basePath}/${service}/proposals/${slug}/.status.yaml`;
    const existing = await this.getFile(path);

    // Stable key order so diffs are readable.
    const ordered: StatusYaml = {
      status: payload.status,
      updated_at: payload.updated_at,
      updated_by: payload.updated_by,
      ...(payload.pr ? { pr: payload.pr } : {}),
      ...(payload.notes ? { notes: payload.notes } : {}),
    };
    const yaml = yamlDump(ordered, { lineWidth: 100, noRefs: true });

    const headers = await this.authHeaders();
    const url = `${this.apiBase}/repos/${this.opts.org}/${this.opts.repo}/contents/${path}`;
    const body: Record<string, unknown> = {
      message: commitMessage,
      content: Buffer.from(yaml, 'utf-8').toString('base64'),
      branch: this.opts.branch,
    };
    if (existing) body.sha = existing.sha;

    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) {
      throw new GitopsConflictError(
        `${service}/${slug} was modified concurrently; reload and retry`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} on PUT ${path}: ${await res.text()}`,
      );
    }
    this.opts.logger.info(
      `[proposals-backend] wrote ${path} status=${payload.status} by=${payload.updated_by}`,
    );
  }
}

export function buildGitopsClient(
  config: Config,
  logger: LoggerService,
): GitopsClient {
  const repoFull = config.getString('mctl.proposals.gitopsRepo');
  const [org, repo] = repoFull.split('/');
  if (!org || !repo) {
    throw new Error(
      `mctl.proposals.gitopsRepo must be 'owner/repo', got '${repoFull}'`,
    );
  }
  const branch = config.getOptionalString('mctl.proposals.branch') ?? 'main';
  const basePath =
    config.getOptionalString('mctl.proposals.basePath') ??
    'platform-gitops/agents-state';

  const integrations = ScmIntegrations.fromConfig(config);
  const credentialsProvider =
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);

  return new GitopsClient({
    org,
    repo,
    branch,
    basePath,
    integrations,
    credentialsProvider,
    logger,
  });
}
