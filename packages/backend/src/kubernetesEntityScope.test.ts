import { AddressInfo } from 'net';
import { Entity } from '@backstage/catalog-model';
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestBackend,
} from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import {
  KubernetesFetcher,
  kubernetesAuthStrategyExtensionPoint,
  kubernetesFetcherExtensionPoint,
  ObjectFetchParams,
} from '@backstage/plugin-kubernetes-node';
import kubernetesPlugin from '@backstage/plugin-kubernetes-backend';
import { kubernetesEntityScopeModule } from './kubernetesEntityScope';

// Drives the real kubernetes-backend router over HTTP, with a fake cluster
// behind the fetcher extension point, and shows what a crafted request body
// can read with and without kubernetesEntityScopeModule.

const ATTACKER = 'user:default/stranger'; // signed in via the GitHub fallback, owns nothing
const LABS_DEV = 'user:default/labsdev';
const ADMIN = 'user:default/root';
const OUTSIDER = 'user:default/outsider'; // member of group:other/labs, not of the labs tenant

const OWNERSHIP: Record<string, string[]> = {
  [ATTACKER]: [ATTACKER],
  [LABS_DEV]: [LABS_DEV, 'group:default/labs'],
  [ADMIN]: [ADMIN, 'group:default/admins', 'group:default/admins-owners'],
  [OUTSIDER]: [OUTSIDER, 'group:other/labs'],
};

function component(
  namespace: string,
  name: string,
  owner: string,
  annotations: Record<string, string>,
): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { namespace, name, annotations },
    spec: { type: 'service', lifecycle: 'production', owner },
  };
}

const LABS_APP = component('labs', 'portfolio', 'group:default/labs', {
  'backstage.io/kubernetes-id': 'portfolio',
  'backstage.io/kubernetes-label-selector': 'app=portfolio',
  'backstage.io/kubernetes-namespace': 'labs',
});
const ADMINS_APP = component('admins', 'openclaw', 'group:default/admins', {
  'backstage.io/kubernetes-id': 'openclaw',
  'backstage.io/kubernetes-label-selector': 'app=openclaw',
  'backstage.io/kubernetes-namespace': 'admins',
});
// A labs-owned entity whose annotations point into another tenant's namespace.
const LABS_POINTING_AT_ADMINS = component('labs', 'sneaky', 'group:default/labs', {
  'backstage.io/kubernetes-id': 'sneaky',
  'backstage.io/kubernetes-label-selector': 'app=openclaw',
  'backstage.io/kubernetes-namespace': 'admins',
});
const LABS_WITHOUT_NAMESPACE = component('labs', 'loose', 'group:default/labs', {
  'backstage.io/kubernetes-id': 'loose',
  'backstage.io/kubernetes-label-selector': 'app',
});
// Owned by a user, not by a tenant group, and owned by a group outside the
// default namespace that merely shares the tenant's name.
const USER_OWNED = component('labs', 'personal', 'user:default/labsdev', {
  'backstage.io/kubernetes-id': 'personal',
  'backstage.io/kubernetes-label-selector': 'app=portfolio',
});
const FOREIGN_NAMESPACE_GROUP = component('labs', 'lookalike', 'group:other/labs', {
  'backstage.io/kubernetes-id': 'lookalike',
  'backstage.io/kubernetes-label-selector': 'app=portfolio',
});
const ENTITIES = [
  LABS_APP,
  ADMINS_APP,
  LABS_POINTING_AT_ADMINS,
  LABS_WITHOUT_NAMESPACE,
  USER_OWNED,
  FOREIGN_NAMESPACE_GROUP,
];

// What the attacker posts: any name, plus annotations of their choosing.
const CRAFTED = component('default', 'anything', 'group:default/nobody', {
  'backstage.io/kubernetes-id': 'anything',
  'backstage.io/kubernetes-label-selector': 'app',
  'backstage.io/kubernetes-namespace': 'admins',
});

// ── Fake cluster ────────────────────────────────────────────────────────

const CLUSTER = [
  { ns: 'labs', name: 'portfolio-0', labels: { app: 'portfolio' } },
  { ns: 'admins', name: 'openclaw-0', labels: { app: 'openclaw' } },
];

function matches(labels: Record<string, string>, selector?: string): boolean {
  if (!selector) return true;
  return selector.split(',').every(term => {
    const [k, v] = term.split('=');
    return v === undefined ? k in labels : labels[k] === v;
  });
}

const fetchCalls: ObjectFetchParams[] = [];
const fakeFetcher: KubernetesFetcher = {
  async fetchObjectsForService(params) {
    fetchCalls.push(params);
    const selected = CLUSTER.filter(
      o => (!params.namespace || o.ns === params.namespace) && matches(o.labels, params.labelSelector),
    );
    return {
      errors: [],
      responses: [
        {
          type: 'pods',
          resources: selected.map(o => ({ metadata: { name: o.name, namespace: o.ns, labels: o.labels } })),
        },
        {
          type: 'configmaps',
          resources: selected.map(o => ({
            metadata: { name: `${o.name}-config`, namespace: o.ns },
            data: { SECRET_LOOKING_VALUE: `value-from-${o.ns}` },
          })),
        },
      ] as any,
    };
  },
  async fetchPodMetricsByNamespaces() {
    return { errors: [], responses: [] };
  },
};

const fakeFetcherModule = createBackendModule({
  pluginId: 'kubernetes',
  moduleId: 'test-fetcher',
  register(reg) {
    reg.registerInit({
      deps: {
        fetcher: kubernetesFetcherExtensionPoint,
        authStrategy: kubernetesAuthStrategyExtensionPoint,
      },
      async init({ fetcher, authStrategy }) {
        fetcher.addFetcher(fakeFetcher);
        // The built-in serviceAccount strategy dynamically imports
        // @kubernetes/client-node, which jest cannot load; this stands in for it.
        authStrategy.addAuthStrategy('test', {
          async getCredential() {
            return { type: 'bearer token', token: 'test-service-account' };
          },
          validateCluster: () => [],
          presentAuthMetadata: () => ({}),
        });
      },
    });
  },
});

// Catalog that only returns entities the caller may read, like the
// permission-filtered catalog: admins see everything, others what their
// groups own.
const catalogMock = catalogServiceMock.mock({
  getEntityByRef: jest.fn(async (ref: any, opts: any) => {
    const wanted = typeof ref === 'string' ? ref : `${ref.kind}:${ref.namespace ?? 'default'}/${ref.name}`.toLowerCase();
    const entity = ENTITIES.find(
      e => `${e.kind}:${e.metadata.namespace}/${e.metadata.name}`.toLowerCase() === wanted,
    );
    const user = opts?.credentials?.principal?.userEntityRef as string | undefined;
    const ownership = (user && OWNERSHIP[user]) || [];
    if (!entity) return undefined;
    if (ownership.includes('group:default/admins-owners')) return entity;
    return ownership.includes((entity.spec as any).owner) ? entity : undefined;
  }) as any,
});

const userInfoMock = mockServices.userInfo.mock({
  getUserInfo: async (credentials: any) => {
    const userEntityRef = credentials.principal.userEntityRef as string;
    return { userEntityRef, ownershipEntityRefs: OWNERSHIP[userEntityRef] ?? [userEntityRef] };
  },
});

const CONFIG = {
  kubernetes: {
    serviceLocatorMethod: { type: 'multiTenant' },
    clusterLocatorMethods: [
      {
        type: 'config',
        clusters: [
          {
            name: 'production',
            url: 'https://kubernetes.example.invalid',
            authProvider: 'test',
          },
        ],
      },
    ],
  },
};

async function startBackend(withFix: boolean): Promise<TestBackend> {
  return startTestBackend({
    features: [
      kubernetesPlugin,
      fakeFetcherModule,
      ...(withFix ? [kubernetesEntityScopeModule] : []),
      mockServices.rootConfig.factory({ data: CONFIG }),
      // The team policy allows kubernetes.resources.read to every user.
      mockServices.permissions.factory({ result: AuthorizeResult.ALLOW }),
      userInfoMock.factory,
      catalogMock.factory,
    ],
  });
}

async function postServices(
  backend: TestBackend,
  user: string,
  entity: Entity,
): Promise<{
  status: number;
  error?: string;
  namespaces: string[];
  configValues: string[];
}> {
  const { port } = backend.server.address() as AddressInfo;
  const res = await fetch(
    `http://127.0.0.1:${port}/api/kubernetes/services/${entity.metadata.name}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockCredentials.user.header(user),
      },
      body: JSON.stringify({ entity }),
    },
  );
  const body = (await res.json()) as any;
  const objects = (body.items ?? []).flatMap((i: any) => i.resources ?? []);
  const namespaces = [
    ...new Set<string>(
      objects.flatMap((r: any) => (r.resources ?? []).map((o: any) => o.metadata.namespace)),
    ),
  ].sort();
  const configValues = objects
    .filter((r: any) => r.type === 'configmaps')
    .flatMap((r: any) => r.resources.map((o: any) => o.data.SECRET_LOOKING_VALUE));
  return { status: res.status, error: body.error, namespaces, configValues };
}

async function postResources(
  backend: TestBackend,
  user: string,
  path: 'workloads' | 'custom',
  body: object,
): Promise<number> {
  const { port } = backend.server.address() as AddressInfo;
  const res = await fetch(
    `http://127.0.0.1:${port}/api/kubernetes/resources/${path}/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockCredentials.user.header(user),
      },
      body: JSON.stringify(body),
    },
  );
  await res.text();
  return res.status;
}

const SECRETS = { group: '', apiVersion: 'v1', plural: 'secrets' };

beforeEach(() => {
  fetchCalls.length = 0;
});

describe('POST /api/kubernetes/services/:id without the fix (proof of the bug)', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await startBackend(false);
  });
  afterAll(async () => {
    await backend?.stop();
  });

  it('lets a user who owns nothing read pods and ConfigMaps of another namespace', async () => {
    const result = await postServices(backend, ATTACKER, CRAFTED);
    expect(result.status).toBe(200);
    expect(result.namespaces).toEqual(['admins']);
    expect(result.configValues).toEqual(['value-from-admins']);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'admins', labelSelector: 'app' });
  });

  it('lets a tenant member query arbitrary resource types through /resources/custom/query', async () => {
    const status = await postResources(backend, LABS_DEV, 'custom', {
      entityRef: 'component:labs/portfolio',
      customResources: [SECRETS],
    });
    expect(status).toBe(200);
    expect(fetchCalls[0].customResources).toEqual([
      expect.objectContaining({ plural: 'secrets' }),
    ]);
  });

  it("follows a tenant entity's annotation into another namespace via /resources/workloads/query", async () => {
    const status = await postResources(backend, LABS_DEV, 'workloads', {
      entityRef: 'component:labs/sneaky',
    });
    expect(status).toBe(200);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'admins' });
  });
});

describe('POST /api/kubernetes/services/:id with kubernetesEntityScopeModule', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await startBackend(true);
  });
  afterAll(async () => {
    await backend?.stop();
  });

  it('refuses a crafted entity the caller cannot see in the catalog', async () => {
    const result = await postServices(backend, ATTACKER, CRAFTED);
    // The legacy route reports every provider error as a 500 with its message.
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/is not visible to the caller/);
    expect(result.namespaces).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses another tenant's real entity", async () => {
    const result = await postServices(backend, LABS_DEV, ADMINS_APP);
    // The legacy route reports every provider error as a 500 with its message.
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/is not visible to the caller/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('ignores annotations sent in the body and uses the catalog copy', async () => {
    const forged: Entity = {
      ...LABS_APP,
      metadata: {
        ...LABS_APP.metadata,
        annotations: {
          'backstage.io/kubernetes-label-selector': 'app',
          'backstage.io/kubernetes-namespace': 'admins',
        },
      },
    };
    const result = await postServices(backend, LABS_DEV, forged);
    expect(result.status).toBe(200);
    expect(result.namespaces).toEqual(['labs']);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'labs', labelSelector: 'app=portfolio' });
  });

  it("serves a tenant member their own entity's objects", async () => {
    const result = await postServices(backend, LABS_DEV, LABS_APP);
    expect(result.status).toBe(200);
    expect(result.namespaces).toEqual(['labs']);
    expect(result.configValues).toEqual(['value-from-labs']);
  });

  it("refuses an owned entity whose namespace annotation leaves the tenant", async () => {
    const result = await postServices(backend, LABS_DEV, LABS_POINTING_AT_ADMINS);
    // The legacy route reports every provider error as a 500 with its message.
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/outside tenant 'labs'/);
    expect(fetchCalls).toHaveLength(0);
  });

  it.each([
    ['an entity owned by a user', LABS_DEV, USER_OWNED],
    ['an entity owned by a group outside the default namespace', OUTSIDER, FOREIGN_NAMESPACE_GROUP],
  ])('refuses %s', async (_label, user, entity) => {
    const result = await postServices(backend, user, entity);
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/is not owned by a tenant group/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('pins an owned entity without a namespace annotation to the tenant namespace', async () => {
    const result = await postServices(backend, LABS_DEV, LABS_WITHOUT_NAMESPACE);
    expect(result.status).toBe(200);
    expect(result.namespaces).toEqual(['labs']);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'labs' });
  });

  it('refuses custom resource types that are not configured', async () => {
    const status = await postResources(backend, LABS_DEV, 'custom', {
      entityRef: 'component:labs/portfolio',
      customResources: [SECRETS],
    });
    expect(status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it('refuses /resources/workloads/query for an annotation outside the tenant', async () => {
    const status = await postResources(backend, LABS_DEV, 'workloads', {
      entityRef: 'component:labs/sneaky',
    });
    expect(status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it('serves /resources/workloads/query for an entity inside the tenant', async () => {
    const status = await postResources(backend, LABS_DEV, 'workloads', {
      entityRef: 'component:labs/portfolio',
    });
    expect(status).toBe(200);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'labs', labelSelector: 'app=portfolio' });
  });

  it('leaves platform admins on the catalog copy without pinning', async () => {
    const result = await postServices(backend, ADMIN, LABS_POINTING_AT_ADMINS);
    expect(result.status).toBe(200);
    expect(fetchCalls[0]).toMatchObject({ namespace: 'admins', labelSelector: 'app=openclaw' });
  });
});
