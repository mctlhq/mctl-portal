import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createCrawlerFilesMiddleware, ROBOTS_TXT } from './crawlerFiles';

describe('crawler files', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(createCrawlerFilesMiddleware());
    // Stand-in for the app backend's SPA fallback: 200 HTML for anything.
    app.use((_req, res) => {
      res.status(200).type('html').send('<!doctype html><title>spa</title>');
    });
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('serves robots.txt as text/plain that disallows everything', async () => {
    const res = await fetch(`${base}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('answers /sitemap.xml with a real 404, not the SPA shell', async () => {
    const res = await fetch(`${base}/sitemap.xml`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).not.toContain('<title>');
  });

  it('answers HEAD the same way', async () => {
    expect((await fetch(`${base}/sitemap.xml`, { method: 'HEAD' })).status).toBe(404);
    expect((await fetch(`${base}/robots.txt`, { method: 'HEAD' })).status).toBe(200);
  });

  it('leaves the root and other paths to the app', async () => {
    for (const p of ['/', '/catalog', '/catalog/default/component/a.b', '/robots.txt.bak']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>spa</title>');
    }
  });

  it('keeps the packaged robots.txt equal to the served one', () => {
    const file = path.resolve(__dirname, '../../app/public/robots.txt');
    expect(fs.readFileSync(file, 'utf8')).toBe(ROBOTS_TXT);
  });

  it('is wired into the root router before the defaults', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');
    const use = src.indexOf('app.use(createCrawlerFilesMiddleware())');
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(src.indexOf('applyDefaults();'));
  });
});
