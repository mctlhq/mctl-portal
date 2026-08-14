import fs from 'fs';
import path from 'path';
import { tenantStoreServiceRef } from './tenantStoreService';

/**
 * Mirror of @backstage/backend-app-api BackendInitializer.#getInitDeps:
 * extension points may only be consumed by a *module* of the *same* plugin.
 */
function resolveExtensionPointDep(opts: {
  extensionPointPluginId: string;
  consumerPluginId: string;
  consumerModuleId?: string;
}) {
  if (opts.extensionPointPluginId !== opts.consumerPluginId) {
    throw new Error(
      `Illegal dependency: Module '${opts.consumerModuleId}' for plugin '${opts.consumerPluginId}' attempted to depend on extension point for plugin '${opts.extensionPointPluginId}'. Extension points can only be used within their plugin's scope.`,
    );
  }
  if (!opts.consumerModuleId) {
    throw new Error(
      `Rejected dependency on extension point from outside of a module`,
    );
  }
}

describe('tenant catalog wiring (4.11.1 crash mode)', () => {
  const initializerSrc = fs.readFileSync(
    path.join(
      __dirname,
      '../../../node_modules/@backstage/backend-app-api/dist/wiring/BackendInitializer.cjs.js',
    ),
    'utf8',
  );

  it('ships the BackendInitializer checks that crashed 4.11.1', () => {
    expect(initializerSrc).toMatch(
      /Extension points can only be used within their plugin's scope/,
    );
    expect(initializerSrc).toMatch(/from outside of a module/);
  });

  it('rejects a catalog module depending on tenant-management.store EP', () => {
    expect(() =>
      resolveExtensionPointDep({
        extensionPointPluginId: 'tenant-management',
        consumerPluginId: 'catalog',
        consumerModuleId: 'tenant-entities',
      }),
    ).toThrow(/Illegal dependency/);
  });

  it('rejects the tenant-management plugin consuming catalogProcessingExtensionPoint', () => {
    expect(() =>
      resolveExtensionPointDep({
        extensionPointPluginId: 'catalog',
        consumerPluginId: 'tenant-management',
      }),
    ).toThrow(/Illegal dependency/);
  });

  it('rejects a plugin (no moduleId) consuming even its own extension point', () => {
    expect(() =>
      resolveExtensionPointDep({
        extensionPointPluginId: 'tenant-management',
        consumerPluginId: 'tenant-management',
      }),
    ).toThrow(/from outside of a module/);
  });

  it('allows a catalog module to consume catalogProcessingExtensionPoint', () => {
    expect(() =>
      resolveExtensionPointDep({
        extensionPointPluginId: 'catalog',
        consumerPluginId: 'catalog',
        consumerModuleId: 'tenant-entities',
      }),
    ).not.toThrow();
  });

  it('shares TenantStore via a root ServiceRef, not an extension point', () => {
    expect(tenantStoreServiceRef.$$type).toBe('@backstage/ServiceRef');
    expect(tenantStoreServiceRef.id).toBe('tenant-management.tenantStore');
    expect(tenantStoreServiceRef.scope).toBe('root');
  });

  it('wires tenant-entities as a catalog module that takes the store service', () => {
    const srcDir = __dirname;
    const moduleSrc = fs.readFileSync(
      path.join(srcDir, 'tenantCatalogModule.ts'),
      'utf8',
    );
    expect(moduleSrc).toMatch(/pluginId: 'catalog'/);
    expect(moduleSrc).toMatch(/moduleId: 'tenant-entities'/);
    expect(moduleSrc).toMatch(/catalogProcessingExtensionPoint/);
    expect(moduleSrc).toMatch(/tenantStoreServiceRef/);
    expect(moduleSrc).not.toMatch(/createExtensionPoint/);
    expect(moduleSrc).not.toMatch(/tenant-management\.store'/);

    const pluginSrc = fs.readFileSync(path.join(srcDir, 'plugin.ts'), 'utf8');
    expect(pluginSrc).not.toMatch(/catalogProcessingExtensionPoint/);
    expect(pluginSrc).toMatch(/tenantStoreServiceRef/);

    const backendIndex = fs.readFileSync(
      path.join(srcDir, '../../../packages/backend/src/index.ts'),
      'utf8',
    );
    expect(backendIndex).toMatch(/tenantCatalogModule/);
  });
});
