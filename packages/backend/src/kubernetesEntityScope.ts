import {
  AuthService,
  BackstageCredentials,
  coreServices,
  createBackendModule,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  Entity,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { NotAllowedError } from '@backstage/errors';
import { CatalogService, catalogServiceRef } from '@backstage/plugin-catalog-node';
import {
  CustomResourcesByEntity,
  KubernetesObjectsByEntity,
  KubernetesObjectsProvider,
  kubernetesObjectsProviderExtensionPoint,
} from '@backstage/plugin-kubernetes-node';

const NAMESPACE_ANNOTATION = 'backstage.io/kubernetes-namespace';

// Owners of the platform-wide admins tenant see every entity unchanged.
// Same marker group the team permission policy uses for its admin bypass.
const ADMIN_OWNERSHIP_REF = 'group:default/admins-owners';

type CustomResourceMatcher = CustomResourcesByEntity['customResources'][number];

/**
 * Wraps the default Kubernetes objects provider so that a request can never
 * choose what is fetched with the backend's service account.
 *
 * The kubernetes-backend routes hand over an entity that, for
 * POST /services/:serviceId, comes straight from the request body: its label
 * selector and namespace annotations would otherwise be used as sent. Here
 * the body entity only names an entity. The entity itself is read from the
 * catalog with the caller's credentials, so the permission policy decides
 * whether the caller may see it at all, and only the catalog copy's
 * annotations are used.
 *
 * For anyone but platform admins the query is also pinned to the namespace
 * of the tenant that owns the entity (spec.owner group:default/<tenant>),
 * and custom resources are limited to those configured under
 * kubernetes.customResources.
 */
export function createEntityScopedObjectsProvider(options: {
  inner: KubernetesObjectsProvider;
  catalog: Pick<CatalogService, 'getEntityByRef'>;
  auth: Pick<AuthService, 'isPrincipal'>;
  userInfo: Pick<UserInfoService, 'getUserInfo'>;
  allowedCustomResources: CustomResourceMatcher[];
}): KubernetesObjectsProvider {
  const { inner, catalog, auth, userInfo, allowedCustomResources } = options;

  async function isPlatformAdmin(credentials: BackstageCredentials): Promise<boolean> {
    if (!auth.isPrincipal(credentials, 'user')) {
      return false;
    }
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    return ownershipEntityRefs.includes(ADMIN_OWNERSHIP_REF);
  }

  async function resolveEntity(
    requested: Entity | undefined,
    credentials: BackstageCredentials,
  ): Promise<Entity> {
    const kind = requested?.kind;
    const name = requested?.metadata?.name;
    if (typeof kind !== 'string' || typeof name !== 'string' || !kind || !name) {
      throw new NotAllowedError('Kubernetes lookup requires a catalog entity reference');
    }
    const ref = {
      kind,
      namespace: requested?.metadata?.namespace ?? 'default',
      name,
    };
    const entity = await catalog.getEntityByRef(ref, { credentials });
    if (!entity) {
      throw new NotAllowedError(`Entity ${stringifyEntityRef(ref)} is not visible to the caller`);
    }
    if (await isPlatformAdmin(credentials)) {
      return entity;
    }

    const tenant = owningTenant(entity);
    if (!tenant) {
      throw new NotAllowedError(
        `Entity ${stringifyEntityRef(entity)} is not owned by a tenant group`,
      );
    }
    const annotations = entity.metadata.annotations ?? {};
    const declared = annotations[NAMESPACE_ANNOTATION];
    if (declared !== undefined && declared !== tenant) {
      throw new NotAllowedError(
        `Entity ${stringifyEntityRef(entity)} points at namespace '${declared}', outside tenant '${tenant}'`,
      );
    }
    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: { ...annotations, [NAMESPACE_ANNOTATION]: tenant },
      },
    };
  }

  async function checkCustomResources(
    requested: CustomResourceMatcher[] | undefined,
    credentials: BackstageCredentials,
  ): Promise<void> {
    if (await isPlatformAdmin(credentials)) {
      return;
    }
    for (const resource of requested ?? []) {
      const allowed = allowedCustomResources.some(
        a =>
          a.group === resource?.group &&
          a.apiVersion === resource?.apiVersion &&
          a.plural === resource?.plural,
      );
      if (!allowed) {
        throw new NotAllowedError(
          `Custom resource ${resource?.group}/${resource?.apiVersion}/${resource?.plural} is not configured`,
        );
      }
    }
  }

  return {
    async getKubernetesObjectsByEntity(request: KubernetesObjectsByEntity, opts) {
      const entity = await resolveEntity(request.entity, opts.credentials);
      return inner.getKubernetesObjectsByEntity({ ...request, entity }, opts);
    },
    async getCustomResourcesByEntity(request: CustomResourcesByEntity, opts) {
      await checkCustomResources(request.customResources, opts.credentials);
      const entity = await resolveEntity(request.entity, opts.credentials);
      return inner.getCustomResourcesByEntity({ ...request, entity }, opts);
    },
  };
}

// The tenant owning an entity: spec.owner must resolve to group:default/<name>.
function owningTenant(entity: Entity): string | undefined {
  const owner = (entity.spec as { owner?: unknown } | undefined)?.owner;
  if (typeof owner !== 'string' || !owner) {
    return undefined;
  }
  try {
    const ref = parseEntityRef(owner, {
      defaultKind: 'group',
      defaultNamespace: entity.metadata.namespace ?? 'default',
    });
    if (ref.kind.toLowerCase() !== 'group' || ref.namespace !== 'default') {
      return undefined;
    }
    return ref.name;
  } catch {
    return undefined;
  }
}

function readCustomResources(config: Config): CustomResourceMatcher[] {
  return (config.getOptionalConfigArray('kubernetes.customResources') ?? []).map(c => ({
    group: c.getString('group'),
    apiVersion: c.getString('apiVersion'),
    plural: c.getString('plural'),
  }));
}

/** Installs createEntityScopedObjectsProvider around the default provider. */
export const kubernetesEntityScopeModule = createBackendModule({
  pluginId: 'kubernetes',
  moduleId: 'entity-scope',
  register(reg) {
    reg.registerInit({
      deps: {
        objectsProvider: kubernetesObjectsProviderExtensionPoint,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
        userInfo: coreServices.userInfo,
        config: coreServices.rootConfig,
      },
      async init({ objectsProvider, catalog, auth, userInfo, config }) {
        const allowedCustomResources = readCustomResources(config);
        objectsProvider.addObjectsProvider(async ({ getDefault }) =>
          createEntityScopedObjectsProvider({
            inner: await getDefault(),
            catalog,
            auth,
            userInfo,
            allowedCustomResources,
          }),
        );
      },
    });
  },
});
