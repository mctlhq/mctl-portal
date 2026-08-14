import { TenantCatalogEntityProvider } from './tenantCatalogProvider';
import { TenantStore } from './tenantStore';

describe('TenantCatalogEntityProvider', () => {
  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };

  it('applies Group/System/User entities from TenantStore (not an extension point)', async () => {
    const store = {
      listAll: jest.fn().mockResolvedValue([
        { name: 'labs', displayName: 'Labs', contactEmail: 'owner@example.com' },
      ]),
      listAllMembers: jest.fn().mockResolvedValue([
        { tenantName: 'labs', userId: 'alice', role: 'owner' },
      ]),
    };
    const provider = new TenantCatalogEntityProvider(
      store as unknown as TenantStore,
      noopLogger as never,
    );
    const applyMutation = jest.fn().mockResolvedValue(undefined);
    await provider.connect({ applyMutation } as never);
    await provider.refresh();
    expect(applyMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'full' }),
    );
    const entities = applyMutation.mock.calls[0][0].entities;
    expect(entities.map((e: { entity: { kind: string } }) => e.entity.kind).sort()).toEqual(
      ['Group', 'System', 'User'],
    );
  });

  it('skips refresh until catalog connect() has run', async () => {
    const store = {
      listAll: jest.fn(),
      listAllMembers: jest.fn(),
    };
    const provider = new TenantCatalogEntityProvider(
      store as unknown as TenantStore,
      noopLogger as never,
    );
    await provider.refresh();
    expect(store.listAll).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalled();
  });
});
