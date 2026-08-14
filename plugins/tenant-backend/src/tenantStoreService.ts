import {
  createServiceFactory,
  createServiceRef,
} from '@backstage/backend-plugin-api';
import { TenantStore } from './tenantStore';

/**
 * Root-scoped handle for the tenant DB. Catalog modules cannot consume a
 * tenant-management extension point (4.11.1 crash); plugins cannot consume
 * catalogProcessingExtensionPoint either (rejected "from outside of a module").
 * A root service is the supported way to share TenantStore across plugins.
 */
export interface TenantStoreService {
  getStore(): TenantStore;
  setStore(store: TenantStore): void;
}

export const tenantStoreServiceRef = createServiceRef<TenantStoreService>({
  id: 'tenant-management.tenantStore',
  scope: 'root',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {},
      async factory() {
        let store: TenantStore | undefined;
        return {
          setStore(next) {
            store = next;
          },
          getStore() {
            if (!store) {
              throw new Error('TenantStore is not initialized yet');
            }
            return store;
          },
        };
      },
    }),
});
