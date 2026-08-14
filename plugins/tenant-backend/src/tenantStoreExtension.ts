import { createExtensionPoint } from '@backstage/backend-plugin-api';
import { TenantStore } from './tenantStore';

export interface TenantStoreExtension {
  getStore(): TenantStore;
}

export const tenantStoreExtensionPoint =
  createExtensionPoint<TenantStoreExtension>({
    id: 'tenant-management.store',
  });
