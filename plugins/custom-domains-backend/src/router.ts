import { Router, json, Request, Response } from 'express';
import { LoggerService } from '@backstage/backend-plugin-api';
import { CustomDomainStore } from './store';
import * as crypto from 'crypto';
import { resolve as dnsResolve } from 'dns';
import { promisify } from 'util';

const resolveCname = promisify(dnsResolve);

interface RouterOptions {
  logger: LoggerService;
  store: CustomDomainStore;
}

// Validate domain is a proper FQDN and not a platform domain
function isValidCustomDomain(domain: string): boolean {
  const fqdnRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  if (!fqdnRegex.test(domain)) return false;
  // Reject platform domains — those are auto-generated
  if (domain.endsWith('.mctl.ai') || domain.endsWith('.mctl.me')) return false;
  return true;
}

// DNS verification: check if domain has CNAME pointing to expected target
async function verifyDns(
  domain: string,
  expectedTarget: string,
): Promise<{ ok: boolean; actual: string | null; error?: string }> {
  try {
    const addresses = await resolveCname(domain);
    if (!addresses || addresses.length === 0) {
      return { ok: false, actual: null, error: 'No DNS records found' };
    }
    // CNAME should resolve to the expected auto-domain
    const normalized = addresses.map((a: string) => a.replace(/\.$/, '').toLowerCase());
    const target = expectedTarget.toLowerCase();
    const match = normalized.some((a: string) => a === target || a.endsWith('.' + target));
    return {
      ok: match,
      actual: normalized.join(', '),
      error: match ? undefined : `CNAME points to ${normalized.join(', ')}, expected ${target}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, actual: null, error: `DNS lookup failed: ${message}` };
  }
}

export function createRouter(options: RouterOptions): Router {
  const { logger, store } = options;
  const router = Router();
  router.use(json());
  // GET /domains?team=X&service=Y (service is optional)
  router.get('/domains', async (req: Request, res: Response) => {
    const { team, service } = req.query;
    if (!team || typeof team !== 'string') {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    try {
      const domains = await store.list(team, service as string | undefined);
      res.json({ domains });
    } catch (err) {
      logger.error(`Failed to list domains: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /domains — register a new custom domain
  router.post('/domains', async (req: Request, res: Response) => {
    const { team, service, domain, created_by } = req.body;
    if (!team || !service || !domain) {
      res.status(400).json({ error: 'Missing required fields: team, service, domain' });
      return;
    }
    if (!isValidCustomDomain(domain)) {
      res.status(400).json({
        error: 'Invalid domain. Must be a valid FQDN and not a *.mctl.ai or *.mctl.me domain.',
      });
      return;
    }

    // Check uniqueness
    const existing = await store.getByDomain(domain);
    if (existing) {
      res.status(409).json({
        error: `Domain ${domain} is already registered for ${existing.team}/${existing.service}`,
      });
      return;
    }

    const id = crypto.randomUUID();
    const autoDomain = `${team}-${service}.mctl.ai`;

    try {
      await store.create({
        id,
        team,
        service,
        domain,
        auto_domain: autoDomain,
        status: 'pending',
        verified_at: null,
        created_by: created_by || 'unknown',
      });
      logger.info(`Custom domain registered: ${domain} → ${autoDomain}`);
      res.status(201).json({
        id,
        domain,
        auto_domain: autoDomain,
        status: 'pending',
        cname_target: autoDomain,
        instructions: `Create a CNAME record: ${domain} → ${autoDomain}`,
      });
    } catch (err) {
      logger.error(`Failed to register domain: ${err}`);
      res.status(500).json({ error: 'Failed to register domain' });
    }
  });

  // POST /domains/:id/verify — check DNS and update status
  router.post('/domains/:id/verify', async (req: Request, res: Response) => {
    const { id } = req.params;
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    const result = await verifyDns(entry.domain, entry.auto_domain);
    if (result.ok) {
      await store.updateStatus(id, 'verified', new Date().toISOString());
      logger.info(`Domain verified: ${entry.domain} → ${entry.auto_domain}`);
      res.json({ status: 'verified', domain: entry.domain, cname: result.actual });
    } else {
      await store.updateStatus(id, 'pending');
      res.json({
        status: 'pending',
        domain: entry.domain,
        error: result.error,
        expected_cname: entry.auto_domain,
        actual_cname: result.actual,
      });
    }
  });

  // POST /domains/:id/activate — mark as active (called by workflow after ingress update)
  router.post('/domains/:id/activate', async (req: Request, res: Response) => {
    const { id } = req.params;
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
    await store.updateStatus(id, 'active');
    logger.info(`Domain activated: ${entry.domain}`);
    res.json({ status: 'active', domain: entry.domain });
  });

  // DELETE /domains/:id — remove a custom domain
  router.delete('/domains/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
    await store.delete(id);
    logger.info(`Domain deleted: ${entry.domain}`);
    res.json({ deleted: true, domain: entry.domain });
  });

  // GET /health
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return router;
}
