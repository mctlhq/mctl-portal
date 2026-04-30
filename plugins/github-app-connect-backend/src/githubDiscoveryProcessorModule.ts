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
 */
class GithubFileEntityProvider implements EntityProvider {
  private connection: EntityProviderConnection | undefined;

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
    if (!sha) return;

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
      tree: Array<{ path: string; type: string }>;
    };

    const matchingPaths = treeData.tree
      .filter(f => f.type === 'blob' && minimatch(f.path, pathGlob))
      .map(f => f.path);

    this.logger.info(`${this.getProviderName()}: found ${matchingPaths.length} matching files for glob ${pathGlob}`);

    const entities: any[] = [];
    for (const filePath of matchingPaths) {
      const contentResp = await fetch(
        `${apiBase}/repos/${owner}/${repo}/contents/${filePath}?ref=${sha}`,
        { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } },
      );
      if (!contentResp.ok) {
        this.logger.warn(`${this.getProviderName()}: failed to read ${filePath}: ${contentResp.status}`);
        continue;
      }
      const yaml = await contentResp.text();
      const fileUrl = `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;
      const locationRef = `url:${fileUrl}`;
      for (const result of Array.from(parseEntityYaml(yaml, { type: 'url', target: fileUrl }))) {
        if (result.type === 'entity') {
          const entity = result.entity;
          entity.metadata = entity.metadata ?? {};
          entity.metadata.annotations = entity.metadata.annotations ?? {};
          entity.metadata.annotations['backstage.io/managed-by-location'] = locationRef;
          entity.metadata.annotations['backstage.io/managed-by-origin-location'] = locationRef;
          entities.push({ locationKey: this.getProviderName(), entity });
        }
      }
    }

    this.logger.info(`${this.getProviderName()}: applying mutation with ${entities.length} entities`);
    await this.connection.applyMutation({ type: 'full', entities });
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
