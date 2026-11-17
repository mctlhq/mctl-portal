import type { RequestHandler } from 'express';

/**
 * Crawler files for app.mctl.ai.
 *
 * The app backend answers every unknown path with the SPA shell and HTTP 200,
 * so /sitemap.xml came back as an HTML page (a soft 404) and crawlers could
 * not tell "no sitemap" from "a sitemap that is HTML". This portal is an
 * authenticated app with nothing to index, so:
 *
 *  - /robots.txt is a deliberate Disallow: / (it used to be an empty rule set,
 *    which means "allow everything");
 *  - /sitemap.xml is a real 404.
 *
 * Register before the default router so the SPA fallback never sees them.
 * packages/app/public/robots.txt carries the same text; crawlerFiles.test.ts
 * keeps the two equal.
 */
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export function createCrawlerFilesMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    // Exact paths only: no extension heuristic, because entity names in
    // Backstage URLs may legitimately contain dots.
    if (req.path === '/robots.txt') {
      res
        .status(200)
        .type('text/plain; charset=utf-8')
        .set('Cache-Control', 'public, max-age=3600')
        .set('X-Content-Type-Options', 'nosniff')
        .send(ROBOTS_TXT);
      return undefined;
    }
    if (req.path === '/sitemap.xml') {
      res
        .status(404)
        .type('text/plain; charset=utf-8')
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .send('Not Found\n');
      return undefined;
    }
    return next();
  };
}
