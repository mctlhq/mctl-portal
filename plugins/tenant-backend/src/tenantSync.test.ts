import { TenantSync } from './tenantSync';

// Deleting a tenant also deletes its repository connections, so a tenant may
// only be removed when it is absent from a complete listing of the tenants
// directory. A tenant whose values.yaml could not be read this cycle is not
// absent.

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
}

function valuesYaml(name: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      encoding: 'base64',
      content: Buffer.from(`tenant:\n  name: ${name}\n`).toString('base64'),
    }),
    text: async () => '',
  };
}

function setup(listing: string[] | { status: number }, files: Record<string, 'ok' | number>) {
  const fetchMock = jest.fn(async (url: string) => {
    if (/\/contents\/tenants$/.test(url)) {
      if (!Array.isArray(listing)) return { ok: false, status: listing.status, text: async () => '' };
      return { ok: true, status: 200, json: async () => listing.map(name => ({ name, type: 'dir' })) };
    }
    const m = url.match(/\/tenants\/([^/]+)\/values\.yaml$/);
    const answer = m ? files[m[1]] : undefined;
    if (answer === 'ok') return valuesYaml(m![1]);
    return { ok: false, status: answer ?? 404, text: async () => '' };
  });
  (global as any).fetch = fetchMock;
  const store = {
    upsert: jest.fn().mockResolvedValue(undefined),
    seedMember: jest.fn().mockResolvedValue(undefined),
    listNames: jest.fn().mockResolvedValue(['alpha', 'beta', 'gone']),
    delete: jest.fn().mockResolvedValue(undefined),
  } as any;
  const sync = new TenantSync(store, logger(), {
    githubOrg: 'o',
    repoName: 'r',
    tenantsPath: 'tenants',
    getGithubToken: async () => 't',
    syncIntervalMinutes: 5,
  });
  return { sync, store };
}

describe('TenantSync stale removal', () => {
  const realFetch = (global as any).fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('removes a tenant whose directory is gone from the listing', async () => {
    const { sync, store } = setup(['alpha', 'beta'], { alpha: 'ok', beta: 'ok' });
    await sync.sync();
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith('gone');
  });

  it('keeps a tenant whose values.yaml could not be read this cycle (old code deleted it and its repo connections)', async () => {
    const { sync, store } = setup(['alpha', 'beta', 'gone'], { alpha: 'ok', beta: 502, gone: 429 });
    await sync.sync();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('removes nothing when the listing cannot be read', async () => {
    const { sync, store } = setup({ status: 502 }, {});
    await sync.sync();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('removes nothing when the listing may be truncated', async () => {
    const dirs = Array.from({ length: 1000 }, (_v, i) => `t${i}`);
    const { sync, store } = setup(dirs, {});
    await sync.sync();
    expect(store.delete).not.toHaveBeenCalled();
  });
});

describe('TenantSync member keys', () => {
  const realFetch = (global as any).fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('seeds principal-keyed entries by principal and skips one it cannot key', async () => {
    const pid = 'prn_01M45DR1GWC87109EH88VBJX25';
    const body = [
      'tenant:',
      '  name: bobs',
      '  members:',
      `    - userId: alice`,
      `      principalId: ${pid}`,
      '      role: owner',
      '      catalogKey: principal',
      '    - userId: mallory',
      '      role: developer',
      '      catalogKey: principal',
      '    - userId: carol',
      '      role: viewer',
    ].join('\n');
    (global as any).fetch = jest.fn(async (url: string) =>
      /\/contents\/tenants$/.test(url)
        ? { ok: true, status: 200, json: async () => [{ name: 'bobs', type: 'dir' }] }
        : {
            ok: true,
            status: 200,
            json: async () => ({ encoding: 'base64', content: Buffer.from(body).toString('base64') }),
          },
    );
    const store = {
      upsert: jest.fn().mockResolvedValue(undefined),
      // The store refuses the first entry (e.g. a customer already seeded
      // into another tenant); the rest are still seeded.
      seedMember: jest.fn().mockRejectedValueOnce(new Error('UNIQUE constraint failed')).mockResolvedValue(undefined),
      listNames: jest.fn().mockResolvedValue(['bobs']),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;
    const log = logger();
    await new TenantSync(store, log, {
      githubOrg: 'o', repoName: 'r', tenantsPath: 'tenants', getGithubToken: async () => 't', syncIntervalMinutes: 5,
    }).sync();
    expect(store.seedMember.mock.calls).toEqual([
      ['bobs', { userId: pid.toLowerCase(), role: 'owner', catalogKey: 'principal', principalId: pid, login: 'alice' }],
      ['bobs', { userId: 'carol', role: 'viewer', catalogKey: 'login' }],
    ]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('member 1 (userId="mallory", principalId=undefined) skipped'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`bobs member ${pid.toLowerCase()} (principalId=${pid}) not seeded`));
  });
});
