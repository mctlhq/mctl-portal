import { ConfigReader } from '@backstage/config';
import {
  ScmIntegrations,
  DefaultGithubCredentialsProvider,
} from '@backstage/integration';
import { mockServices } from '@backstage/backend-test-utils';
import { GithubFileEntityProvider } from './githubDiscoveryProcessorModule';

const API = 'https://api.github.com';
const GLOB = 'platform-gitops/services/*/*/catalog-info.yaml';
const A = 'platform-gitops/services/labs/a/catalog-info.yaml';
const B = 'platform-gitops/services/labs/b/catalog-info.yaml';

const component = (name: string) =>
  `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${name}\nspec:\n  type: service\n  lifecycle: production\n  owner: labs\n`;

type Reply = { status?: number; body: unknown };

function setup(routes: Record<string, Reply>) {
  const integrations = ScmIntegrations.fromConfig(
    new ConfigReader({
      integrations: { github: [{ host: 'github.com', token: 't' }] },
    }),
  );
  const credentialsProvider = {
    getCredentials: async () => ({ headers: { Authorization: 'Bearer t' } }),
  } as unknown as DefaultGithubCredentialsProvider;
  const logger = mockServices.logger.mock();
  const provider = new GithubFileEntityProvider(
    'services',
    { owner: 'mctlhq', repo: 'mctl-gitops', branch: 'main', pathGlob: GLOB },
    integrations,
    credentialsProvider,
    logger,
  );
  const applyMutation = jest.fn();
  provider.connect({ applyMutation, refresh: jest.fn() });

  jest.spyOn(global, 'fetch').mockImplementation(async input => {
    const url = String(input).replace(API, '').replace(/\?.*$/, '');
    const reply = routes[url];
    if (!reply) return new Response('not found', { status: 404 });
    const body =
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  });
  return { provider, applyMutation, logger };
}

const base = (
  tree: unknown,
  files: Record<string, Reply>,
): Record<string, Reply> => ({
  '/repos/mctlhq/mctl-gitops/git/refs/heads/main': {
    body: { object: { sha: 'abc' } },
  },
  '/repos/mctlhq/mctl-gitops/git/trees/abc': { body: tree },
  ...Object.fromEntries(
    Object.entries(files).map(([p, r]) => [
      `/repos/mctlhq/mctl-gitops/contents/${p}`,
      r,
    ]),
  ),
});

const tree = {
  tree: [
    { path: A, type: 'blob' },
    { path: B, type: 'blob' },
    { path: 'platform-gitops/services/labs/a/values.yaml', type: 'blob' },
  ],
};

describe('GithubFileEntityProvider.refresh', () => {
  afterEach(() => jest.restoreAllMocks());

  it('applies every matching file as one full mutation', async () => {
    const { provider, applyMutation } = setup(
      base(tree, {
        [A]: { body: component('a') },
        [B]: { body: component('b') },
      }),
    );
    await provider.refresh();
    expect(applyMutation).toHaveBeenCalledTimes(1);
    const m = applyMutation.mock.calls[0][0];
    expect(m.type).toBe('full');
    expect(m.entities.map((e: any) => e.entity.metadata.name).sort()).toEqual([
      'a',
      'b',
    ]);
    expect(m.entities[0].locationKey).toBe('GithubFileEntityProvider:services');
  });

  it('applies nothing when a file cannot be read', async () => {
    const { provider, applyMutation, logger } = setup(
      base(tree, {
        [A]: { body: component('a') },
        [B]: { status: 502, body: 'bad gateway' },
      }),
    );
    await provider.refresh();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'failed to read platform-gitops/services/labs/b/catalog-info.yaml: 502',
      ),
    );
  });

  it('applies nothing when the tree is truncated', async () => {
    const { provider, applyMutation, logger } = setup(
      base(
        { ...tree, truncated: true },
        { [A]: { body: component('a') }, [B]: { body: component('b') } },
      ),
    );
    await provider.refresh();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('truncated or malformed'),
    );
  });

  it('applies nothing when a file does not parse', async () => {
    const { provider, applyMutation, logger } = setup(
      base(tree, {
        [A]: { body: component('a') },
        [B]: { body: 'kind: [unclosed' },
      }),
    );
    await provider.refresh();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('does not parse'),
    );
  });

  it('applies nothing when the tree body is malformed', async () => {
    const { provider, applyMutation, logger } = setup(base({ sha: 'abc' }, {}));
    await provider.refresh();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('truncated or malformed'),
    );
  });

  it('applies an empty full mutation when the glob genuinely matches nothing', async () => {
    const { provider, applyMutation } = setup(base({ tree: [] }, {}));
    await provider.refresh();
    expect(applyMutation).toHaveBeenCalledWith({ type: 'full', entities: [] });
  });
});
