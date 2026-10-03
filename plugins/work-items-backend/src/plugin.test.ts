import { ConfigReader } from '@backstage/config';
import { DEFAULT_MCTL_API_BASE_URL, readWorkItemsConfig, registerAuthPolicies } from './plugin';

describe('work-items auth policies', () => {
  it('exposes only /health as unauthenticated', () => {
    const calls: Array<{ path: string; allow: string }> = [];
    registerAuthPolicies({ addAuthPolicy: p => calls.push(p) });
    expect(calls).toEqual([{ path: '/health', allow: 'unauthenticated' }]);
  });
});

describe('readWorkItemsConfig', () => {
  it('defaults to actions disabled, no token and the public mctl-api', () => {
    expect(readWorkItemsConfig(new ConfigReader({}))).toEqual({
      baseUrl: DEFAULT_MCTL_API_BASE_URL,
      surfaceToken: undefined,
      actionsEnabled: false,
      executionCanvasUrlTemplate: undefined,
    });
  });

  it('never falls back to the admin API token', () => {
    const cfg = readWorkItemsConfig(
      new ConfigReader({
        customDomains: { token: 'admin-token' },
        mctlApi: { token: 'admin-token' },
      }),
    );
    expect(cfg.surfaceToken).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain('admin-token');
  });

  it('reads the surface token and the flag only from workItems', () => {
    const cfg = readWorkItemsConfig(
      new ConfigReader({ workItems: { baseUrl: 'http://x', surfaceToken: 'sp', actionsEnabled: true } }),
    );
    expect(cfg).toMatchObject({ baseUrl: 'http://x', surfaceToken: 'sp', actionsEnabled: true });
  });
});
