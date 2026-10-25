import {
  createBackendModule,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import {
  EntityProvider,
  EntityProviderConnection,
  parseEntityYaml,
  catalogProcessingExtensionPoint,
} from '@backstage/plugin-catalog-node';
import { minimatch } from 'minimatch';

/**
 * Discovers catalog-info.yaml files inside a single GitHub repository by
 * walking the git tree.  Uses only contents:read — no statuses:read needed.
 *
 * It is the only provider for these paths, and a full mutation deletes
 * whatever it leaves out, so "could not read" must never look like "the file
 * is gone":
 *   - a ref or tree that cannot be read (failed, truncated, malformed)
 *     applies nothing and keeps the last good state;
 *   - a single file that cannot be fetched or does not parse keeps its own
 *     last good entities, and the rest of the refresh applies. One broken
 *     file must not freeze discovery and deletion for every other one. A
 *     file that was not in the last good state (new since then) is left out:
 *     there is nothing of it to delete;
 *   - with no last good state yet (the first refresh since start), a failed
 *     file's previous entities are unknown, so only the files that were read
 *     are upserted (a delta with no removals) and deletions wait for a
 *     complete read.
 */
export class GithubFileEntityProvider implements EntityProvider {
  private connection: EntityProviderConnection | undefined;
  // Entities per file path from the last complete (full) mutation, updated
  // on every full mutation. Undefined until the first one since start.
  private lastGood: Map<string, any[]> | undefined;

  constructor(
    private readonly name: string,
    private readonly providerConfig: {
      owner: string;
      repo: string;
      branch: string;
      pathGlob: string;
    },
    private readonly integrations: ScmIntegrations,
    private readonly credentialsProvider: DefaultGithubCredentialsProvider,
    private readonly logger: LoggerService,
  ) {}

  getProviderName() {
    return `GithubFileEntityProvider:${this.name}`;
  }

  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
  }

  async refresh() {
    if (!this.connection) {
      this.logger.warn(`${this.getProviderName()}: no connection, skipping refresh`);
      return;
    }
    const { owner, repo, branch, pathGlob } = this.providerConfig;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const integration = this.integrations.github.byUrl(repoUrl);
    if (!integration) {
      this.logger.warn(`${this.getProviderName()}: no GitHub integration for ${repoUrl}`);
      return;
    }

    const apiBase = integration.config.apiBaseUrl;
    const { headers } = await this.credentialsProvider.getCredentials({ url: repoUrl });

    this.logger.info(`${this.getProviderName()}: refreshing ${owner}/${repo} branch=${branch} glob=${pathGlob}`);

    // HEAD SHA via git refs — only needs contents:read
    const refResp = await fetch(
      `${apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { headers },
    );
    if (!refResp.ok) {
      this.logger.error(`${this.getProviderName()}: failed to get HEAD ref: ${refResp.status} ${refResp.statusText}`);
      return;
    }
    const refRaw = await refResp.json() as
      | { object: { sha: string } }
      | Array<{ object: { sha: string } }>;
    const sha = Array.isArray(refRaw) ? refRaw[0]?.object?.sha : (refRaw as any).object?.sha;
    if (!sha) {
      this.logger.error(`${this.getProviderName()}: HEAD ref for ${branch} carries no sha; keeping the last good state`);
      return;
    }

    // Full recursive tree — only needs contents:read
    const treeResp = await fetch(
      `${apiBase}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      { headers },
    );
    if (!treeResp.ok) {
      this.logger.error(`${this.getProviderName()}: failed to get tree: ${treeResp.status} ${treeResp.statusText}`);
      return;
    }
    const treeData = await treeResp.json() as {
      tree?: Array<{ path: string; type: string }>;
      truncated?: boolean;
    };
    if (treeData.truncated || !Array.isArray(treeData.tree)) {
      this.logger.error(`${this.getProviderName()}: tree for ${sha} is truncated or malformed; keeping the last good state`);
      return;
    }

    const matchingPaths = treeData.tree
      .filter(f => f.type === 'blob' && minimatch(f.path, pathGlob))
      .map(f => f.path);

    this.logger.info(`${this.getProviderName()}: found ${matchingPaths.length} matching files for glob ${pathGlob}`);

    const read = new Map<string, any[]>();
    const failed: string[] = [];
    for (const filePath of matchingPaths) {
      const fileEntities = await this.readFile(apiBase, headers, sha, filePath);
      if (fileEntities) {
        read.set(filePath, fileEntities);
      } else {
        failed.push(filePath);
      }
    }

    if (failed.length > 0 && !this.lastGood) {
      const added = Array.from(read.values()).flat();
      this.logger.error(`${this.getProviderName()}: ${failed.length} file(s) unreadable and no last good state since start (${failed.join(', ')}); upserting ${added.length} entities from the files that were read, deletions wait for a complete read`);
      await this.connection.applyMutation({ type: 'delta', added, removed: [] });
      return;
    }

    const next = new Map(read);
    for (const filePath of failed) {
      const previous = this.lastGood!.get(filePath);
      if (previous) {
        next.set(filePath, previous);
      }
    }
    if (failed.length > 0) {
      this.logger.error(`${this.getProviderName()}: ${failed.length} file(s) unreadable (${failed.join(', ')}); keeping their last good entities, applying the rest`);
    }
    const entities = Array.from(next.values()).flat();
    this.logger.info(`${this.getProviderName()}: applying mutation with ${entities.length} entities`);
    await this.connection.applyMutation({ type: 'full', entities });
    this.lastGood = next;
  }

  // The entities of one file, or undefined when it cannot be fetched or any
  // document in it does not parse (a file is taken whole or not at all).
  private async readFile(
    apiBase: string | undefined,
    headers: Record<string, string> | undefined,
    sha: string,
    filePath: string,
  ): Promise<any[] | undefined> {
    const { owner, repo, branch } = this.providerConfig;
    let yaml: string;
    try {
      const contentResp = await fetch(
        `${apiBase}/repos/${owner}/${repo}/contents/${filePath}?ref=${sha}`,
        { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } },
      );
      if (!contentResp.ok) {
        this.logger.error(`${this.getProviderName()}: failed to read ${filePath}: ${contentResp.status}`);
        return undefined;
      }
      yaml = await contentResp.text();
    } catch (e) {
      // A network failure or an aborted body is this file's failure, not
      // the whole refresh's.
      this.logger.error(`${this.getProviderName()}: failed to read ${filePath}: ${e}`);
      return undefined;
    }
    const fileUrl = `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;
    const locationRef = `url:${fileUrl}`;
    const entities: any[] = [];
    for (const result of Array.from(parseEntityYaml(yaml, { type: 'url', target: fileUrl }))) {
      if (result.type === 'entity') {
        const entity = result.entity;
        entity.metadata = entity.metadata ?? {};
        entity.metadata.annotations = entity.metadata.annotations ?? {};
        entity.metadata.annotations['backstage.io/managed-by-location'] = locationRef;
        entity.metadata.annotations['backstage.io/managed-by-origin-location'] = locationRef;
        entities.push({ locationKey: this.getProviderName(), entity });
      } else if (result.type === 'error') {
        this.logger.error(`${this.getProviderName()}: ${filePath} does not parse: ${result.error.message}`);
        return undefined;
      }
    }
    return entities;
  }
}

function buildProviders(
  config: Config,
  integrations: ScmIntegrations,
  credentialsProvider: DefaultGithubCredentialsProvider,
  logger: LoggerService,
): GithubFileEntityProvider[] {
  const pc = config.getOptionalConfig('catalog.providers.github');
  if (!pc) {
    logger.warn('GithubFileEntityProvider: no catalog.providers.github config found');
    return [];
  }

  const providers = pc.keys().flatMap(name => {
    const c = pc.getConfig(name);
    const organization = c.getString('organization');
    const catalogPath = c.getString('catalogPath');
    const branch = c.getOptionalString('filters.branch') ?? 'main';
    const repoFilter = c.getOptionalString('filters.repository');
    if (!repoFilter) {
      logger.info(`GithubFileEntityProvider: skipping provider '${name}' (no filters.repository)`);
      return [];
    }
    const pathGlob = catalogPath.startsWith('/') ? catalogPath.slice(1) : catalogPath;
    logger.info(`GithubFileEntityProvider: creating provider '${name}' for ${organization}/${repoFilter} glob=${pathGlob}`);
    return [new GithubFileEntityProvider(
      name,
      { owner: organization, repo: repoFilter, branch, pathGlob },
      integrations,
      credentialsProvider,
      logger,
    )];
  });

  logger.info(`GithubFileEntityProvider: created ${providers.length} providers`);
  return providers;
}

export const githubDiscoveryProcessorModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'github-discovery-processor',
  register(env) {
    env.registerInit({
      deps: {
        catalogProcessing: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
      },
      async init({ catalogProcessing, config, scheduler, logger }) {
        logger.info('GithubFileEntityProvider module initializing');
        const integrations = ScmIntegrations.fromConfig(config);
        const credentialsProvider = DefaultGithubCredentialsProvider.fromIntegrations(integrations);
        const providers = buildProviders(config, integrations, credentialsProvider, logger);

        for (const provider of providers) {
          catalogProcessing.addEntityProvider(provider);
          const runner = scheduler.createScheduledTaskRunner({
            frequency: { minutes: 1 },
            timeout: { minutes: 5 },
          });
          await runner.run({
            id: provider.getProviderName(),
            fn: async () => provider.refresh(),
          });
        }
      },
    });
  },
});
