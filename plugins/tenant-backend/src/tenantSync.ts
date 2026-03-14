import fetch from 'node-fetch';
import yaml from 'js-yaml';
import { LoggerService } from '@backstage/backend-plugin-api';
import { TenantStore } from './tenantStore';
import { Tenant, TenantValuesYaml } from './types';

export interface TenantSyncOptions {
  /** GitHub org name (e.g. mctlhq) */
  githubOrg: string;
  /** GitHub repo name (e.g. mctl-gitops) */
  repoName: string;
  /** Path prefix inside the repo (e.g. platform-gitops/tenants) */
  tenantsPath: string;
  /** Async function that returns a fresh GitHub token (handles refresh) */
  getGithubToken: () => Promise<string>;
  /** Sync interval in minutes */
  syncIntervalMinutes: number;
}

/**
 * TenantSync: Reads tenant YAML definitions from GitHub and writes them
 * into the local PostgreSQL store (TenantStore).
 *
 * Uses the GitHub Contents API to list tenant directories and read each
 * values.yaml. This avoids the need to clone the repository.
 */
export class TenantSync {
  private store: TenantStore;
  private logger: LoggerService;
  private opts: TenantSyncOptions;
  private timer?: NodeJS.Timeout;

  constructor(store: TenantStore, logger: LoggerService, opts: TenantSyncOptions) {
    this.store = store;
    this.logger = logger;
    this.opts = opts;
  }

  /** Start the sync loop */
  async start(): Promise<void> {
    this.logger.info(
      `[TenantSync] Starting sync from github.com/${this.opts.githubOrg}/${this.opts.repoName}/${this.opts.tenantsPath}`,
    );
    // Run immediately on start
    await this.sync();

    // Then schedule periodic refresh
    const intervalMs = this.opts.syncIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.sync().catch(err => this.logger.error(`[TenantSync] Sync failed: ${err}`));
    }, intervalMs);
  }

  /** Stop the sync loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a single sync cycle: GitHub → DB */
  async sync(): Promise<void> {
    const { githubOrg, repoName, tenantsPath, getGithubToken } = this.opts;

    let githubToken: string;
    try {
      githubToken = await getGithubToken();
    } catch (err) {
      this.logger.error(`[TenantSync] Failed to get GitHub token: ${err}`);
      return;
    }

    const baseUrl = `https://api.github.com/repos/${githubOrg}/${repoName}/contents/${tenantsPath}`;

    this.logger.debug(`[TenantSync] Fetching tenant list from: ${baseUrl}`);

    let directories: string[];
    try {
      const resp = await fetch(baseUrl, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!resp.ok) {
        this.logger.error(`[TenantSync] GitHub API error ${resp.status}: ${await resp.text()}`);
        return;
      }

      const entries = (await resp.json()) as Array<{ name: string; type: string }>;
      directories = entries.filter(e => e.type === 'dir').map(e => e.name);
    } catch (err) {
      this.logger.error(`[TenantSync] Failed to fetch tenant list: ${err}`);
      return;
    }

    this.logger.info(`[TenantSync] Found ${directories.length} tenant directories`);

    const syncedAt = new Date().toISOString();
    const syncedNames: string[] = [];

    for (const dir of directories) {
      try {
        const result = await this.fetchTenant(dir, syncedAt, githubToken);
        if (result) {
          await this.store.upsert(result.tenant);
          // Seed members from values.yaml (add-only, skips users in other tenants)
          for (const m of result.members) {
            await this.store.seedMember(result.tenant.name, m.userId, m.role);
          }
          syncedNames.push(dir);
        }
      } catch (err) {
        this.logger.warn(`[TenantSync] Failed to sync tenant '${dir}': ${err}`);
      }
    }

    // Remove tenants from DB that no longer exist in Git
    const existingNames = await this.store.listNames();
    for (const name of existingNames) {
      if (!syncedNames.includes(name)) {
        this.logger.info(`[TenantSync] Removing stale tenant '${name}' from DB`);
        await this.store.delete(name);
      }
    }

    this.logger.info(`[TenantSync] Sync complete. ${syncedNames.length} tenants synced.`);
  }

  private async fetchTenant(dirName: string, syncedAt: string, githubToken: string): Promise<{ tenant: Tenant; members: Array<{ userId: string; role: string }> } | null> {
    const { githubOrg, repoName, tenantsPath } = this.opts;
    const url = `https://api.github.com/repos/${githubOrg}/${repoName}/contents/${tenantsPath}/${dirName}/values.yaml`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (resp.status === 404) {
      this.logger.debug(`[TenantSync] No values.yaml in tenant dir '${dirName}', skipping`);
      return null;
    }

    if (!resp.ok) {
      throw new Error(`GitHub API error ${resp.status} for ${dirName}/values.yaml`);
    }

    const fileData = (await resp.json()) as { content?: string; encoding?: string };

    if (!fileData.content || fileData.encoding !== 'base64') {
      throw new Error(`Unexpected response format for ${dirName}/values.yaml`);
    }

    const rawYaml = Buffer.from(fileData.content, 'base64').toString('utf8');
    const parsed = yaml.load(rawYaml) as TenantValuesYaml;

    if (!parsed?.tenant?.name) {
      this.logger.warn(`[TenantSync] tenant.name missing in ${dirName}/values.yaml, skipping`);
      return null;
    }

    const t = parsed.tenant;

    const tenant: Tenant = {
      name: t.name,
      displayName: t.displayName ?? t.name,
      description: t.description,
      githubTeam: t.githubTeam,
      contactEmail: t.contactEmail,
      quotas: {
        'requests.cpu': t.quotas?.['requests.cpu'] ?? '1',
        'requests.memory': t.quotas?.['requests.memory'] ?? '2Gi',
        'limits.cpu': t.quotas?.['limits.cpu'] ?? '2',
        'limits.memory': t.quotas?.['limits.memory'] ?? '3Gi',
        pods: t.quotas?.pods ?? '10',
        persistentvolumeclaims: t.quotas?.persistentvolumeclaims,
        services: t.quotas?.services,
      },
      networking: {
        allowIntraNamespace: t.networking?.allowIntraNamespace ?? true,
        allowClusterEgress: t.networking?.allowClusterEgress ?? true,
        allowInternetEgress: t.networking?.allowInternetEgress ?? false,
      },
      syncedAt,
    };

    const members = (t.members ?? []).map(m => ({
      userId: m.userId,
      role: m.role ?? 'owner',
    }));

    return { tenant, members };
  }
}
