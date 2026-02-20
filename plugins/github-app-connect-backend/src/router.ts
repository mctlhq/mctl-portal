import { Request, Response, Router } from 'express';
import { Logger } from 'winston';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { RepoConnectionStore } from './store';

export interface RouterOptions {
  logger: Logger;
  store: RepoConnectionStore;
  appSlug: string;
  appId: string;
  privateKey: string;
  baseUrl: string;
}

// State tokens: encrypted JSON with nonce + expiry
function encryptState(data: object, secret: string): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const payload = JSON.stringify({ ...data, exp: Date.now() + 10 * 60 * 1000 });
  let encrypted = cipher.update(payload, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptState(token: string, secret: string): Record<string, unknown> | null {
  try {
    const [ivHex, encrypted] = token.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(secret, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    const data = JSON.parse(decrypted);
    if (data.exp && data.exp < Date.now()) {
      return null; // Expired
    }
    return data;
  } catch {
    return null;
  }
}

// Generate GitHub App installation token via JWT
async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to get installation token: ${resp.status}`);
  }
  const body = (await resp.json()) as { token: string };
  return body.token;
}

// List repos accessible to an installation
async function getInstallationRepos(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string[]> {
  const token = await getInstallationToken(installationId, appId, privateKey);
  const resp = await fetch(
    'https://api.github.com/installation/repositories?per_page=100',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { repositories: Array<{ full_name: string }> };
  return data.repositories.map(r => r.full_name);
}

// Find installation for a specific owner
async function findInstallation(
  owner: string,
  appId: string,
  privateKey: string,
): Promise<{ id: number; account_type: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  // Try user installation first, then org
  for (const type of ['users', 'orgs']) {
    const resp = await fetch(
      `https://api.github.com/${type}/${owner}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as { id: number; account: { type: string } };
      return {
        id: data.id,
        account_type: data.account.type.toLowerCase(),
      };
    }
  }
  return null;
}

export function createRouter(options: RouterOptions): Router {
  const { logger, store, appSlug, appId, privateKey, baseUrl } = options;
  const stateSecret = privateKey.slice(0, 64); // derive state encryption key from private key

  const router = Router();

  // GET /install-url — returns GitHub App install URL with encrypted state
  router.get('/install-url', (req: Request, res: Response) => {
    const { team, service, repo } = req.query;
    if (!team || !service || !repo) {
      res.status(400).json({ error: 'Missing required params: team, service, repo' });
      return;
    }

    const state = encryptState(
      { team, service, repo, nonce: crypto.randomBytes(8).toString('hex') },
      stateSecret,
    );

    const installUrl = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
    res.json({ url: installUrl, state });
  });

  // GET /callback — GitHub redirects here after App installation
  router.get('/callback', async (req: Request, res: Response) => {
    const { installation_id, state: stateParam } = req.query;
    if (!stateParam || !installation_id) {
      res.status(400).json({ error: 'Missing installation_id or state' });
      return;
    }

    const stateData = decryptState(stateParam as string, stateSecret);
    if (!stateData) {
      res.status(400).json({ error: 'Invalid or expired state parameter' });
      return;
    }

    const { team, service, repo } = stateData as {
      team: string;
      service: string;
      repo: string;
    };
    const installId = Number(installation_id);

    // Verify the installation has access to the requested repo
    try {
      const repos = await getInstallationRepos(installId, appId, privateKey);
      const hasAccess = repos.some(
        r => r.toLowerCase() === (repo as string).toLowerCase(),
      );

      if (!hasAccess) {
        logger.warn(
          `Installation ${installId} does not have access to ${repo}`,
        );
        res.status(403).json({
          error: `Installation does not have access to ${repo}. Please add the repository in GitHub App settings.`,
        });
        return;
      }
    } catch (err) {
      logger.error(`Failed to verify installation repos: ${err}`);
    }

    // Determine account type
    const owner = (repo as string).split('/')[0];
    const installation = await findInstallation(owner, appId, privateKey);
    const accountType = installation?.account_type || 'unknown';

    await store.upsert({
      team_id: team as string,
      service_id: service as string,
      repo_full_name: repo as string,
      installation_id: installId,
      account_type: accountType,
      created_by: 'github-callback',
    });

    logger.info(
      `Repo connection saved: ${team}/${service} → ${repo} (installation ${installId})`,
    );

    // Redirect back to Backstage
    res.redirect(
      `${baseUrl}/create?status=connected&repo=${encodeURIComponent(repo as string)}`,
    );
  });

  // GET /repo-access — check if a repo is accessible via App or PAT
  router.get('/repo-access', async (req: Request, res: Response) => {
    const { team, service, repo } = req.query;
    if (!team || !service || !repo) {
      res.status(400).json({ error: 'Missing required params: team, service, repo' });
      return;
    }

    // Check if we have a stored connection
    const connection = await store.find(
      team as string,
      service as string,
      repo as string,
    );

    if (connection) {
      // Verify the installation still has access
      try {
        const repos = await getInstallationRepos(
          connection.installation_id,
          appId,
          privateKey,
        );
        const hasAccess = repos.some(
          r => r.toLowerCase() === (repo as string).toLowerCase(),
        );
        if (hasAccess) {
          res.json({
            status: 'connected',
            method: 'github_app',
            installation_id: connection.installation_id,
          });
          return;
        }
        // Installation lost access — clean up
        logger.warn(
          `Installation ${connection.installation_id} lost access to ${repo}`,
        );
      } catch (err) {
        logger.warn(`Failed to verify installation: ${err}`);
      }
    }

    // Check if App is installed on the repo owner
    const owner = (repo as string).split('/')[0];
    const installation = await findInstallation(owner, appId, privateKey);
    if (installation) {
      const repos = await getInstallationRepos(installation.id, appId, privateKey);
      const hasAccess = repos.some(
        r => r.toLowerCase() === (repo as string).toLowerCase(),
      );
      if (hasAccess) {
        // Auto-save connection
        await store.upsert({
          team_id: team as string,
          service_id: service as string,
          repo_full_name: repo as string,
          installation_id: installation.id,
          account_type: installation.account_type,
          created_by: 'auto-discovery',
        });
        res.json({
          status: 'connected',
          method: 'github_app',
          installation_id: installation.id,
        });
        return;
      }
    }

    // Check if repo is public
    try {
      const publicCheck = await fetch(
        `https://api.github.com/repos/${repo}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (publicCheck.ok) {
        const repoData = (await publicCheck.json()) as { private: boolean };
        if (!repoData.private) {
          res.json({ status: 'accessible', method: 'public' });
          return;
        }
      }
    } catch {
      // ignore
    }

    res.json({
      status: 'needs_install',
      method: 'none',
      install_url: `https://github.com/apps/${appSlug}/installations/new`,
    });
  });

  // GET /install-status — for CLI polling
  router.get('/install-status', async (req: Request, res: Response) => {
    const { team, service, repo, state: stateParam } = req.query;

    // If state is provided, decrypt it for params
    let teamId = team as string;
    let serviceId = service as string;
    let repoName = repo as string;

    if (stateParam) {
      const stateData = decryptState(stateParam as string, stateSecret);
      if (stateData) {
        teamId = teamId || (stateData.team as string);
        serviceId = serviceId || (stateData.service as string);
        repoName = repoName || (stateData.repo as string);
      }
    }

    if (!teamId || !serviceId || !repoName) {
      res.status(400).json({ error: 'Missing params: team, service, repo' });
      return;
    }

    const connection = await store.find(teamId, serviceId, repoName);
    if (connection) {
      res.json({ status: 'connected', connection });
    } else {
      res.json({ status: 'pending' });
    }
  });

  return router;
}
