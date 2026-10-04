import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { createRouter } from './router';

// Auto-deploy (mctl.me/auto-deploy: true|auto) is disabled: a deploy needs an
// initiating user that mctl:workflow:submit authorizes, and a webhook has
// none. The webhook must refuse it where it is triggered (422 to GitHub, a
// warning, a notification), and never create a scaffolder task.

const SECRET = 'webhook-secret';

function component(name: string, autoDeploy?: string) {
  return {
    kind: 'Component',
    metadata: {
      name,
      namespace: 'default',
      annotations: {
        'github.com/source-repo': 'myorg/app',
        ...(autoDeploy ? { 'mctl.me/auto-deploy': autoDeploy } : {}),
      },
    },
    spec: { owner: 'group:labs' },
  };
}

async function deliver(items: any[] | Error) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
  const createTask = jest.fn(async () => ({ id: 'task-1' }));
  const send = jest.fn(async () => undefined);
  const router = createRouter({
    logger,
    store: {} as any,
    appSlug: 'test-app',
    appId: '1',
    privateKey: 'unused',
    baseUrl: 'https://portal.example.com',
    webhookSecret: SECRET,
    catalogClient: {
      getEntities: async () => {
        if (items instanceof Error) throw items;
        return { items };
      },
    } as any,
    scaffolderClient: { createTask },
    notifications: { send } as any,
    httpAuth: {} as any,
    userInfo: {} as any,
    db: {} as any,
    isPostgres: false,
  });
  const app = express().use(router);
  const server = app.listen(0);
  try {
    const body = JSON.stringify({ ref: 'v1.2.3', ref_type: 'tag', repository: { full_name: 'myorg/app' } });
    const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'create', 'x-hub-signature-256': signature },
      body,
    });
    const json = await res.json();
    // let the async notification loop finish
    await new Promise(r => setTimeout(r, 20));
    return { status: res.status, json, logger, createTask, send };
  } finally {
    server.close();
  }
}

describe('POST /webhook auto-deploy', () => {
  it.each(['true', 'auto'])('refuses mode %s up front and creates no task', async mode => {
    const { status, json, logger, createTask, send } = await deliver([component('app', mode)]);
    expect(status).toBe(422);
    expect(json).toMatchObject({ components: ['component:default/app'], tag: 'v1.2.3' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/auto-deploy is disabled.*component:default\/app/));
    expect(createTask).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ title: expect.stringMatching(/Auto-deploy disabled/) }) }),
    );
  });

  it('accepts confirm and unannotated components as before, without a task', async () => {
    const { status, json, createTask, send } = await deliver([component('a', 'confirm'), component('b')]);
    expect(status).toBe(200);
    expect(json).toMatchObject({ accepted: true });
    expect(createTask).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports a failed catalog lookup instead of accepting', async () => {
    const { status, createTask } = await deliver(new Error('catalog down'));
    expect(status).toBe(502);
    expect(createTask).not.toHaveBeenCalled();
  });
});
