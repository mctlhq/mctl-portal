import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { TenantCatalogEntityProvider } from './tenantCatalogProvider';
import { tenantStoreExtensionPoint } from './tenantStoreExtension';

/**
 * Catalog module: in-process User/Group/System entities from the tenant DB.
 * Lives on pluginId `catalog` so it can consume catalogProcessingExtensionPoint
 * (backend plugins cannot declare foreign extension points as deps).
 */
export const tenantCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'tenant-entities',
  register(env) {
    env.registerInit({
      deps: {
        catalogProcessing: catalogProcessingExtensionPoint,
        tenantStore: tenantStoreExtensionPoint,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
      },
      async init({ catalogProcessing, tenantStore, scheduler, logger }) {
        const provider = new TenantCatalogEntityProvider(tenantStore, logger);
        catalogProcessing.addEntityProvider(provider);
        const runner = scheduler.createScheduledTaskRunner({
          frequency: { minutes: 1 },
          timeout: { minutes: 2 },
        });
        await runner.run({
          id: provider.getProviderName(),
          fn: async () => provider.refresh(),
        });
        logger.info('[TenantCatalog] entity provider registered');
      },
    });
  },
});
