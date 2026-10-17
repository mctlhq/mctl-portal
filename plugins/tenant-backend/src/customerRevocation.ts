import { RequestHandler } from 'express';

function principalFromToken(token: string | undefined): string | undefined {
  if (!token || token.length > 32768) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    // Plugin-to-plugin calls can carry a limited user token on behalf of a
    // human. The normal auth service still verifies both signatures afterwards.
    const user = typeof payload.obo === 'string'
      ? JSON.parse(Buffer.from(payload.obo.split('.')[1], 'base64url').toString('utf8'))
      : payload;
    const match = typeof user.sub === 'string'
      ? user.sub.match(/^user:default\/(prn_[0-9a-hjkmnp-tv-z]{26})$/i)
      : undefined;
    return match ? `prn_${match[1].slice(4).toUpperCase()}` : undefined;
  } catch { return undefined; }
}

/**
 * Deny-only root middleware, before every plugin route. A decoded claim may
 * trigger refusal but NEVER establishes authentication or grants access. The
 * regular Backstage auth service must still validate all forwarded requests.
 * This keeps already-issued user JWTs and OBO/cookie tokens from outliving an
 * account deletion, without rotating signing keys for unrelated users.
 */
export function createCustomerRevocationMiddleware(options: {
  isRevoked: (principalId: string) => Promise<boolean>;
  appOrigin: string;
}): RequestHandler {
  return async (req, res, next) => {
    let token = req.header('Authorization')?.match(/^Bearer[ ]+(\S+)$/i)?.[1];
    if (!token) {
      const raw = req.header('Cookie')?.split(';').map(part => part.trim())
        .find(part => part.startsWith('backstage-auth='))?.slice('backstage-auth='.length);
      try { token = raw ? decodeURIComponent(raw) : undefined; } catch { /* Normal auth rejects malformed cookies. */ }
    }
    const principal = principalFromToken(token);
    if (!principal) { next(); return; }
    const refuse = (status: number, error: string) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.header('Origin') === options.appOrigin) {
        res.set('Access-Control-Allow-Origin', options.appOrigin);
        res.set('Access-Control-Allow-Credentials', 'true');
        res.vary('Origin');
      }
      res.status(status).json({ error });
    };
    try {
      if (await options.isRevoked(principal)) {
        refuse(401, 'This account has been deleted. Sign in again.'); return;
      }
      next();
    } catch { refuse(503, 'Account status could not be verified. Try again later.'); }
  };
}
