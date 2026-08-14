import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { TenantCatalogEntityProvider } from './tenantCatalogProvider';
import { tenantStoreServiceRef } from './tenantStoreService';

/**
 * Catalog module: in-process User/Group/System entities from the tenant DB.
 * Lives on pluginId `catalog` so it can consume catalogProcessingExtensionPoint.
 * TenantStore is a root service, not tenant-management.store (extension points
 * are plugin-scoped; that illegal dep is the 4.11.1 crash).
 */
export const tenantCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'tenant-entities',
  register(env) {
    env.registerInit({
      deps: {
        catalogProcessing: catalogProcessingExtensionPoint,
        tenantStoreApi: tenantStoreServiceRef,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
      },
      async init({ catalogProcessing, tenantStoreApi, scheduler, logger }) {
        const provider = new TenantCatalogEntityProvider(tenantStoreApi, logger);
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
