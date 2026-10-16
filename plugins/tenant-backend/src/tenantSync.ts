import yaml from 'js-yaml';
import { LoggerService } from '@backstage/backend-plugin-api';
import { TenantStore } from './tenantStore';
import { Tenant, TenantValuesYaml } from './types';
import { SeedMember, seedMemberOf } from './memberKeys';

// The GitHub contents API lists at most this many entries of a directory.
const CONTENTS_LISTING_LIMIT = 1000;

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
            try {
              await this.store.seedMember(result.tenant.name, m);
            } catch (err) {
              // One bad entry, e.g. a customer's principal in a second
              // tenant (refused by the store), must not stop the others.
              this.logger.warn(
                `[TenantSync] ${result.tenant.name} member ${m.userId} (principalId=${m.principalId ?? 'none'}) not seeded: ${err}`,
              );
            }
          }
          syncedNames.push(dir);
        }
      } catch (err) {
        this.logger.warn(`[TenantSync] Failed to sync tenant '${dir}': ${err}`);
      }
    }

    // Remove tenants from DB that no longer exist in Git. Deleting a tenant
    // also deletes its repository connections, which cannot be rebuilt, so
    // only a tenant whose directory is absent from a complete listing counts
    // as gone. One whose values.yaml could not be read this cycle (a GitHub
    // error, a rate limit, a malformed file) is not gone, and neither is
    // anything when the listing may be cut short.
    if (directories.length >= CONTENTS_LISTING_LIMIT) {
      this.logger.warn(
        `[TenantSync] The tenant listing has ${directories.length} entries and may be truncated; not removing any tenant`,
      );
    } else {
      const existingNames = await this.store.listNames();
      for (const name of existingNames) {
        if (!directories.includes(name)) {
          this.logger.info(`[TenantSync] Removing stale tenant '${name}' from DB`);
          await this.store.delete(name);
        }
      }
    }

    this.logger.info(`[TenantSync] Sync complete. ${syncedNames.length} tenants synced.`);
  }

  private async fetchTenant(dirName: string, syncedAt: string, githubToken: string): Promise<{ tenant: Tenant; members: SeedMember[] } | null> {
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
        'requests.cpu': t.quotas?.['requests.cpu'] ?? '2',
        'requests.memory': t.quotas?.['requests.memory'] ?? '3Gi',
        'limits.cpu': t.quotas?.['limits.cpu'] ?? '4',
        'limits.memory': t.quotas?.['limits.memory'] ?? '6Gi',
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

    // An entry that cannot be keyed as it asks is skipped, not seeded under
    // another name (seedMemberOf).
    const members: SeedMember[] = [];
    for (const [i, raw] of (Array.isArray(t.members) ? t.members : []).entries()) {
      const parsed = seedMemberOf(raw);
      if ('error' in parsed) {
        const r = (raw ?? {}) as Record<string, unknown>;
        this.logger.warn(
          `[TenantSync] ${dirName}/values.yaml member ${i} ` +
            `(userId=${JSON.stringify(r.userId)}, principalId=${JSON.stringify(r.principalId)}) skipped: ${parsed.error}`,
        );
        continue;
      }
      members.push(parsed.member);
    }

    return { tenant, members };
  }
}
