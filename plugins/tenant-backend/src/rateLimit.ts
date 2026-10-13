import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

/**
 * Per-client request budgets for the tenant and resource-usage routes.
 *
 * The backend does not set `trust proxy`, so `req.ip` is the Traefik pod for
 * every request and keying on it would put all callers in one bucket. Traefik
 * appends the address it accepted the connection from as the last
 * `X-Forwarded-For` entry; that entry is the one hop we trust. Anything a
 * client wrote earlier in the header is ignored. A caller that reaches the
 * pod without Traefik can only choose its own bucket, which is no worse than
 * no limit at all.
 *
 * Counters live in process memory: the portal runs one replica, and a restart
 * resetting them is acceptable for flood protection.
 */

const WINDOW_MS = 60_000;

/** Budgets per client per minute. */
export const DEFAULT_LIMITS = {
  /** Reads of the caller's own tenants, members and usage. */
  read: 300,
  /**
   * Mutations, plus reads that spend a shared upstream quota (the GitHub user
   * lookup behind /check-user runs on the portal's own token).
   */
  write: 30,
};

export type RateLimits = typeof DEFAULT_LIMITS;

export function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = header?.split(',').pop()?.trim();
  const ip = last || req.ip || req.socket.remoteAddress || 'unknown';
  // Masks IPv6 to its /56, so rotating addresses inside one allocation does
  // not buy a fresh budget.
  return ipKeyGenerator(ip);
}

function limiter(limit: number): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientKey,
    // clientKey reads X-Forwarded-For on purpose, without `trust proxy`.
    validate: { xForwardedForHeader: false },
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many requests' });
    },
  });
}

/** Fresh limiters with their own counters; call once per router. */
export function createRateLimiters(limits: RateLimits = DEFAULT_LIMITS): {
  read: RequestHandler;
  write: RequestHandler;
} {
  return { read: limiter(limits.read), write: limiter(limits.write) };
}
