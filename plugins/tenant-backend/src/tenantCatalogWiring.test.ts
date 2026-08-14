import fs from 'fs';
import path from 'path';

/**
 * Mirrors backend-app-api: modules may only consume extension points of their
 * own plugin. Plugins (no moduleId) may consume a foreign plugin's EP.
 * 4.11.1 crashed because tenant-entities (catalog module) took tenant-management.store.
 */
export function isIllegalExtensionPointDependency(opts: {
  consumerPluginId: string;
  consumerModuleId?: string;
  extensionPointPluginId: string;
}): boolean {
  if (!opts.consumerModuleId) {
    return false;
  }
  return opts.consumerPluginId !== opts.extensionPointPluginId;
}

describe('tenant catalog wiring (4.11.1 crash mode)', () => {
  it('rejects a catalog module depending on tenant-management.store', () => {
    expect(
      isIllegalExtensionPointDependency({
        consumerPluginId: 'catalog',
        consumerModuleId: 'tenant-entities',
        extensionPointPluginId: 'tenant-management',
      }),
    ).toBe(true);
  });

  it('allows the tenant-management plugin to consume catalogProcessingExtensionPoint', () => {
    expect(
      isIllegalExtensionPointDependency({
        consumerPluginId: 'tenant-management',
        extensionPointPluginId: 'catalog',
      }),
    ).toBe(false);
  });

  it('does not wire tenant-entities as a catalog module', () => {
    const srcDir = __dirname;
    expect(fs.existsSync(path.join(srcDir, 'tenantCatalogModule.ts'))).toBe(
      false,
    );
    const pluginSrc = fs.readFileSync(path.join(srcDir, 'plugin.ts'), 'utf8');
    expect(pluginSrc).toMatch(/catalogProcessingExtensionPoint/);
    expect(pluginSrc).not.toMatch(/createBackendModule/);
    expect(pluginSrc).not.toMatch(/tenantStoreExtensionPoint/);
    expect(pluginSrc).not.toMatch(/id: 'tenant-management\.store'/);
    const backendIndex = fs.readFileSync(
      path.join(srcDir, '../../../packages/backend/src/index.ts'),
      'utf8',
    );
    expect(backendIndex).not.toMatch(/tenantCatalogModule/);
  });
});
