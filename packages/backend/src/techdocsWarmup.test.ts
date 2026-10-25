import { Entity } from '@backstage/catalog-model';
import { createSyncBuilder, runTechdocsWarmup } from './techdocsWarmup';

const ent = (name: string, annotated = true): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Template',
  metadata: {
    name,
    namespace: 'default',
    annotations: annotated ? { 'backstage.io/techdocs-ref': 'dir:.' } : {},
  },
});
const logger = () => ({ info: jest.fn(), error: jest.fn() });

describe('runTechdocsWarmup', () => {
  it('builds only annotated entities, in order', async () => {
    const build = jest.fn().mockResolvedValue('updated');
    await runTechdocsWarmup({
      logger: logger(),
      build,
      listEntities: async () => [ent('a'), ent('x', false), ent('b'), ent('c')],
    });
    expect(build.mock.calls.map(c => c[0].metadata.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('continues after a failure and counts it', async () => {
    const log = logger();
    const build = jest
      .fn()
      .mockResolvedValueOnce('updated')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('cached');
    const res = await runTechdocsWarmup({
      logger: log,
      build,
      listEntities: async () => [ent('a'), ent('b'), ent('c')],
    });
    expect(build).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('template:default/b'),
    );
    expect(res).toMatchObject({ updated: 1, cached: 1, failed: 1 });
  });

  it('builds sequentially', async () => {
    let release: () => void = () => {};
    const build = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise(r => (release = () => r('updated'))),
      )
      .mockResolvedValue('updated');
    const p = runTechdocsWarmup({
      logger: logger(),
      build,
      listEntities: async () => [ent('a'), ent('b')],
    });
    await new Promise(r => setTimeout(r, 10));
    expect(build).toHaveBeenCalledTimes(1);
    release();
    await p;
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('resolves when listing fails', async () => {
    const log = logger();
    const build = jest.fn();
    const res = await runTechdocsWarmup({
      logger: log,
      build,
      listEntities: async () => {
        throw new Error('down');
      },
    });
    expect(res.listFailed).toBe(true);
    expect(build).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});

describe('createSyncBuilder', () => {
  const make = (status: number) => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(status === 200 ? '{}' : 'err', {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const build = createSyncBuilder({
      discovery: { getBaseUrl: async () => 'http://x/api/techdocs' } as any,
      auth: {
        getOwnServiceCredentials: async () => ({}),
        getPluginRequestToken: async () => ({ token: 'tok' }),
      } as any,
      fetch: fetchMock as any,
      timeoutMs: 1000,
    });
    return { build, fetchMock };
  };

  it('maps 200 and 304', async () => {
    const a = make(200);
    await expect(a.build(ent('a'))).resolves.toBe('updated');
    expect(a.fetchMock.mock.calls[0][0]).toBe(
      'http://x/api/techdocs/sync/default/Template/a',
    );
    expect(a.fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer tok',
    );
    const b = { status: 304, headers: new Headers(), text: async () => '' };
    const fetch304 = jest.fn().mockResolvedValue(b);
    const build = createSyncBuilder({
      discovery: { getBaseUrl: async () => 'http://x' } as any,
      auth: {
        getOwnServiceCredentials: async () => ({}),
        getPluginRequestToken: async () => ({ token: 't' }),
      } as any,
      fetch: fetch304 as any,
      timeoutMs: 1000,
    });
    await expect(build(ent('a'))).resolves.toBe('cached');
  });

  it('throws on 500 with the status', async () => {
    await expect(make(500).build(ent('a'))).rejects.toThrow('500');
  });
});
