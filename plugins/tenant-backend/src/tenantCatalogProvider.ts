import { LoggerService } from '@backstage/backend-plugin-api';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { buildTenantCatalogEntities } from './catalogEntities';
import { TenantStoreService } from './tenantStoreService';

/**
 * Pushes tenant User/Group/System entities into the catalog from the DB.
 * Replaces the HTTP catalog.yaml location that put BACKSTAGE_LANDING_TOKEN
 * in the query string because UrlReader cannot send headers.
 */
export class TenantCatalogEntityProvider implements EntityProvider {
  private connection: EntityProviderConnection | undefined;

  constructor(
    private readonly storeApi: TenantStoreService,
    private readonly logger: LoggerService,
  ) {}

  getProviderName() {
    return 'tenant-management-catalog';
  }

  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
  }

  async refresh() {
    if (!this.connection) {
      this.logger.warn(`${this.getProviderName()}: no connection, skipping refresh`);
      return;
    }
    let store;
    try {
      store = this.storeApi.getStore();
    } catch {
      this.logger.warn(
        `${this.getProviderName()}: tenant store not ready yet, skipping refresh`,
      );
      return;
    }
    const [tenants, allMembers] = await Promise.all([
      store.listAll(),
      store.listAllMembers(),
    ]);
    const entities = buildTenantCatalogEntities(tenants, allMembers).map(entity => ({
      entity,
      locationKey: this.getProviderName(),
    }));
    this.logger.info(
      `${this.getProviderName()}: applying ${entities.length} entities ` +
        `(${tenants.length} tenants, ${allMembers.length} members)`,
    );
    await this.connection.applyMutation({ type: 'full', entities });
  }
}
