import { LoggerService } from '@backstage/backend-plugin-api';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { buildTenantCatalogEntities } from './catalogEntities';
import { TenantStore } from './tenantStore';

/**
 * Pushes tenant User/Group/System entities into the catalog from the DB.
 * Replaces the HTTP catalog.yaml location that put BACKSTAGE_LANDING_TOKEN
 * in the query string because UrlReader cannot send headers.
 *
 * Registered from the tenant-management plugin (not a catalog module).
 */
export class TenantCatalogEntityProvider implements EntityProvider {
  private connection: EntityProviderConnection | undefined;

  constructor(
    private readonly store: TenantStore,
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
    const [tenants, allMembers] = await Promise.all([
      this.store.listAll(),
      this.store.listAllMembers(),
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
