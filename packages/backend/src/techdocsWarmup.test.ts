import { Entity } from '@backstage/catalog-model';
import { createBackendPlugin } from '@backstage/backend-plugin-api';
import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import {
  createSyncBuilder,
  runTechdocsWarmup,
  techdocsWarmupModule,
} from './techdocsWarmup';

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

  it('stops between entities once the scheduler aborts', async () => {
    const log = logger();
    const ctrl = new AbortController();
    const build = jest.fn().mockImplementation(async () => {
      ctrl.abort();
      return 'updated';
    });
    await runTechdocsWarmup({
      logger: log,
      build,
      signal: ctrl.signal,
      listEntities: async () => [ent('a'), ent('b'), ent('c')],
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('aborted'));
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

// techdocs-backend 2.2.0 always answers the sync route with an event stream
// (dist/service/router.cjs.js, createEventStream), so this is the path that
// runs in production.
describe('createSyncBuilder against the 2.2.0 event stream', () => {
  const streamBuilder = (body: string) =>
    createSyncBuilder({
      discovery: { getBaseUrl: async () => 'http://x/api/techdocs' } as any,
      auth: {
        getOwnServiceCredentials: async () => ({}),
        getPluginRequestToken: async () => ({ token: 'tok' }),
      } as any,
      fetch: jest.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ) as any,
      timeoutMs: 1000,
    });
  const ev = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  it('reads finish {updated:true} as updated, after log events', async () => {
    const body = ev('log', 'INFO building') + ev('finish', { updated: true });
    await expect(streamBuilder(body)(ent('a'))).resolves.toBe('updated');
  });

  it('reads finish {updated:false} as up to date', async () => {
    await expect(
      streamBuilder(ev('finish', { updated: false }))(ent('a')),
    ).resolves.toBe('cached');
  });

  it('throws on an error event with its message', async () => {
    const body = ev('log', 'x') + ev('error', 'mkdocs exploded');
    await expect(streamBuilder(body)(ent('a'))).rejects.toThrow(
      'mkdocs exploded',
    );
  });

  it('parses CRLF-framed events too', async () => {
    const body = (ev('log', 'x') + ev('finish', { updated: true })).replace(
      /\n/g,
      '\r\n',
    );
    await expect(streamBuilder(body)(ent('a'))).resolves.toBe('updated');
  });

  it('throws when the stream ends without finish or error', async () => {
    await expect(streamBuilder(ev('log', 'x'))(ent('a'))).rejects.toThrow(
      'without a finish event',
    );
  });
});

describe('techdocsWarmupModule', () => {
  // The module extends the techdocs plugin; a stub stands in for it.
  const techdocsStub = createBackendPlugin({
    pluginId: 'techdocs',
    register(env) {
      env.registerInit({ deps: {}, async init() {} });
    },
  });
  const start = async (config: object, entities: Entity[] = []) => {
    const scheduleTask = jest.fn().mockResolvedValue(undefined);
    await startTestBackend({
      features: [
        techdocsStub,
        techdocsWarmupModule,
        mockServices.rootConfig.factory({ data: config }),
        mockServices.scheduler.mock({ scheduleTask }).factory,
        catalogServiceMock.factory({ entities }),
      ],
    });
    return scheduleTask;
  };

  it('runs the scheduled fn end to end: lists the catalog, syncs annotated entities', async () => {
    // The builder captures fetch at init, so the spy must exist first.
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response('event: finish\ndata: {"updated":true}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    try {
      const scheduleTask = await start({ techdocs: { builder: 'local' } }, [
        ent('a'),
        ent('plain', false),
      ]);
      await scheduleTask.mock.calls[0][0].fn(new AbortController().signal);
      const urls = fetchSpy.mock.calls.map(c => String(c[0]));
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/\/api\/techdocs\/sync\/default\/Template\/a$/);
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toMatch(/^Bearer \S+/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('schedules techdocs-warmup on every replica (scope local)', async () => {
    const scheduleTask = await start({ techdocs: { builder: 'local' } });
    expect(scheduleTask).toHaveBeenCalledTimes(1);
    expect(scheduleTask.mock.calls[0][0]).toMatchObject({
      id: 'techdocs-warmup',
      scope: 'local',
      frequency: { minutes: 30 },
      initialDelay: { seconds: 60 },
    });
  });

  it('schedules nothing when disabled', async () => {
    const scheduleTask = await start({
      techdocs: { builder: 'local', warmup: { enabled: false } },
    });
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('schedules nothing when the builder is external', async () => {
    const scheduleTask = await start({ techdocs: { builder: 'external' } });
    expect(scheduleTask).not.toHaveBeenCalled();
  });
});
