import { buildTenantCatalogEntities } from './catalogEntities';
import {
  createWorkspaceAccessReader,
  PlatformAccessObservation,
  readPlatformObservation,
  renderWorkspaceReady,
} from './workspaceAccess';
import { Tenant, TenantMember } from './types';

const links = {
  portalBaseUrl: 'https://app.mctl.ai',
  mcpUrl: 'https://api.mctl.ai/mcp',
  accountDomain: 'mctl.ai',
};
const pid = 'prn_01M39HRB7JRXZ2PHW5VVB695YZ';
const member: TenantMember = {
  tenantName: 'acme',
  principalId: pid,
  userId: pid.toLowerCase(),
  login: 'alice',
  catalogKey: 'principal',
  role: 'owner',
  invitedBy: 'system',
  invitedAt: new Date().toISOString(),
};
const tenant: Tenant = {
  name: 'acme',
  displayName: 'Acme',
  quotas: {} as Tenant['quotas'],
  networking: {} as Tenant['networking'],
  syncedAt: new Date().toISOString(),
};
function observation(): PlatformAccessObservation {
  return {
    version: 1,
    tenant: 'acme',
    principalId: pid,
    role: 'owner',
    observedAt: new Date().toISOString(),
    infrastructure: 'ready',
    environments: [
      { name: 'production', namespace: 'acme', status: 'ready' },
      { name: 'preview', namespace: 'acme-preview', status: 'ready' },
    ],
    portal: 'configured',
    mcp: 'blocked',
  };
}
function fixture() {
  const entities = buildTenantCatalogEntities([tenant], [member]);
  const platform = observation();
  const store = { getMemberByTenant: jest.fn().mockResolvedValue(member) };
  const getCatalogEntity = jest.fn(async (kind, name) =>
    entities.find(
      e => e.kind.toLowerCase() === kind && e.metadata.name === name,
    ),
  );
  const read = createWorkspaceAccessReader({
    ...links,
    store,
    observePlatform: async () => platform,
    getCatalogEntity,
  });
  return { read, store, entities, platform, getCatalogEntity };
}

it('confirms portal access from the real provider entities without promising MCP', async () => {
  const result = await fixture().read(member);
  expect(result.status).toBe('ready');
  expect(result.capabilities.map(c => c.id)).toEqual(['portal']);
  const email = renderWorkspaceReady(result, 'alice@example.com');
  expect(email.text).toContain(
    'alice@mctl.ai (account identifier, not a mailbox)',
  );
  expect(email.text).toContain('as of');
  expect(email.text).toContain('https://app.mctl.ai/workspace/access');
  expect(email.text).not.toContain('https://api.mctl.ai/mcp');
  expect(email.text).not.toContain('ops.mctl.ai');
});

it.each(['group', 'user'])(
  'waits for the %s entity instead of equating workflow success with ready',
  async kind => {
    const f = fixture();
    f.getCatalogEntity.mockImplementation(async (k, name) =>
      k === kind
        ? undefined
        : f.entities.find(
            e => e.kind.toLowerCase() === k && e.metadata.name === name,
          ),
    );
    expect((await f.read(member)).status).toBe('provisioning');
  },
);

it('never infers access from a foreign catalog owner', async () => {
  const f = fixture();
  f.entities.find(e => e.kind === 'Group')!.spec!.owner =
    'group:default/foreign';
  expect((await f.read(member)).capabilities).toEqual([]);
});

it('waits for infrastructure even when the user can sign in', async () => {
  const f = fixture();
  f.platform.infrastructure = 'pending';
  expect((await f.read(member)).status).toBe('provisioning');
});

it('propagates catalog read failures as unknown', async () => {
  const f = fixture();
  f.getCatalogEntity.mockRejectedValue(new Error('catalog offline'));
  await expect(f.read(member)).rejects.toThrow('catalog offline');
});

it('refuses a membership revoked during external reads', async () => {
  const f = fixture();
  f.store.getMemberByTenant
    .mockResolvedValueOnce(member)
    .mockResolvedValueOnce(undefined);
  await expect(f.read(member)).rejects.toThrow('membership changed');
});

it.each([
  { version: 2 },
  { principalId: 'foreign' },
  { role: 'viewer' },
  { observedAt: 'not-a-date' },
  { observedAt: new Date(Date.now() - 360_000).toISOString() },
  { environments: [] },
  {
    environments: [{ name: 'production', namespace: 'acme', status: 'ready' }],
  },
  { infrastructure: 'unknown' },
  { portal: 'unknown' },
  { mcp: 'unknown' },
])('refuses malformed or stale observations: %j', delta => {
  expect(() =>
    readPlatformObservation({ ...observation(), ...delta }, member),
  ).toThrow();
});

it('lists MCP only when the live platform observation confirms it', async () => {
  const f = fixture();
  f.platform.mcp = 'available';
  expect((await f.read(member)).capabilities.map(c => c.id)).toEqual([
    'portal',
    'mcp',
  ]);
});

it('waits for the catalog role to converge before promising the role in an email', async () => {
  const f = fixture();
  f.entities.find(e => e.kind === 'User')!.metadata.annotations![
    'mctl.me/tenant-role'
  ] = 'viewer';
  expect((await f.read(member)).status).toBe('provisioning');
});

it('keeps principal-only membership usable without inventing a login-based account name', async () => {
  const noLogin = { ...member, login: undefined };
  const entities = buildTenantCatalogEntities([tenant], [noLogin]);
  const read = createWorkspaceAccessReader({
    ...links,
    store: { getMemberByTenant: jest.fn().mockResolvedValue(noLogin) },
    observePlatform: async () => observation(),
    getCatalogEntity: async (kind, name) =>
      entities.find(
        e => e.kind.toLowerCase() === kind && e.metadata.name === name,
      ),
  });
  const result = await read(noLogin);
  expect(result.status).toBe('ready');
  expect(result.account).toBeUndefined();
  const email = renderWorkspaceReady(result, 'alice@example.com');
  expect(email.text).not.toContain('undefined@mctl.ai');
  expect(email.html).not.toContain('undefined@mctl.ai');
  expect(email.text).toContain('Use your existing MCTL sign-in');
});

it('tolerates bounded future clock skew and diagnoses excessive skew separately', () => {
  const future = {
    ...observation(),
    observedAt: new Date(Date.now() + 120_000).toISOString(),
  };
  expect(readPlatformObservation(future, member).tenant).toBe('acme');
  expect(() =>
    readPlatformObservation(future, member, 300_000, 60_000),
  ).toThrow('clock skew');
  expect(() =>
    readPlatformObservation(
      {
        ...observation(),
        observedAt: new Date(Date.now() - 360_000).toISOString(),
      },
      member,
    ),
  ).toThrow('too old');
});

it('uses the configured portal, MCP endpoint, account domain and sender', async () => {
  const f = fixture();
  f.platform.mcp = 'available';
  const read = createWorkspaceAccessReader({
    store: f.store,
    observePlatform: async () => f.platform,
    getCatalogEntity: f.getCatalogEntity,
    portalBaseUrl: 'https://portal.example.test',
    mcpUrl: 'https://api.example.test/mcp',
    accountDomain: 'example.test',
  });
  const result = await read(member);
  expect(result.accessUrl).toBe('https://portal.example.test/workspace/access');
  expect(result.account).toBe('alice@example.test');
  expect(result.capabilities.map(c => c.url)).toEqual([
    'https://portal.example.test/catalog/default/group/acme',
    'https://api.example.test/mcp',
  ]);
  expect(
    renderWorkspaceReady(
      result,
      'alice@example.test',
      'MCTL <test@example.test>',
    ).from,
  ).toBe('MCTL <test@example.test>');
});
