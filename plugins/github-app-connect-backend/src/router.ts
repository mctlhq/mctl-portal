import { Request, Response, Router } from 'express';
import express from 'express';
import { Logger } from 'winston';
import crypto from 'crypto';
import fetch from 'node-fetch';
import type { NotificationService } from '@backstage/plugin-notifications-node';
import { RepoConnectionStore } from './store';

export interface RouterOptions {
  logger: Logger;
  store: RepoConnectionStore;
  appSlug: string;
  appId: string;
  privateKey: string;
  baseUrl: string;
  webhookSecret?: string;
  catalogClient?: { getEntities: (request: any) => Promise<any> };
  scaffolderClient?: { createTask: (request: any) => Promise<any> };
  notifications?: NotificationService;
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

// Create a short-lived JWT for GitHub App API calls
function makeAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
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
  const { logger, store, appSlug, appId, privateKey, baseUrl, webhookSecret, catalogClient, scaffolderClient, notifications } = options;
  // Derive the state key from the full private key (full entropy) rather than
  // a low-entropy PEM-header prefix. 64 hex chars keeps the existing shape.
  const stateSecret = crypto.createHash('sha256').update(privateKey).digest('hex');

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

  // GET /popup-done — shown inside popup after GitHub App install
  // Posts repos to parent window and closes itself
  router.get('/popup-done', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head><title>Access granted</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5">
  <div style="text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="font-size:2rem;margin-bottom:.5rem">✅</div>
    <div style="font-weight:600;margin-bottom:.25rem">Access granted!</div>
    <div style="color:#666;font-size:.875rem">This window will close automatically…</div>
    <div id="manual" style="display:none;margin-top:1rem">
      <button onclick="window.close()" style="padding:.5rem 1.25rem;border:none;border-radius:4px;background:#1976d2;color:#fff;cursor:pointer;font-size:.875rem">
        Close this window
      </button>
    </div>
  </div>
  <script>
    var msg = { type: 'github-repos-updated' };
    // 1. BroadcastChannel — works even when opener is lost after redirect chain
    try {
      var bc = new BroadcastChannel('mctl-github-repos');
      bc.postMessage(msg);
      setTimeout(function() { bc.close(); }, 2000);
    } catch(e) {}
    // 2. postMessage to opener as fallback
    try {
      if (window.opener) { window.opener.postMessage(msg, '*'); }
    } catch(e) {}
    // 3. Close the popup
    setTimeout(function() {
      window.close();
      // If still open, show manual close button
      setTimeout(function() {
        var el = document.getElementById('manual');
        if (el) el.style.display = 'block';
      }, 600);
    }, 300);
  </script>
</body>
</html>`);
  });

  // GET /callback — GitHub redirects here after App installation
  // Handles three flows:
  //   1. state=popup (from GitHubRepoPicker) — auto-discover repos, close popup
  //   2. With encrypted state param (from install-url) — binds to specific team/service/repo
  //   3. Without state (direct install from GitHub) — auto-discovers repos
  router.get('/callback', async (req: Request, res: Response) => {
    const { installation_id, state: stateParam, setup_action } = req.query;
    if (!installation_id) {
      res.status(400).json({ error: 'Missing installation_id' });
      return;
    }

    const installId = Number(installation_id);

    // Flow 1: Popup mode (from GitHubRepoPicker) — state=popup or state=popup:teamName
    if (stateParam?.toString().startsWith('popup')) {
      const popupTeam = stateParam.toString().split(':')[1] || '_auto';
      try {
        const repos = await getInstallationRepos(installId, appId, privateKey);
        logger.info(
          `Popup installation ${installId} (team=${popupTeam}) — repos: ${repos.join(', ') || 'none'}`,
        );
        for (const repoFullName of repos) {
          const owner = repoFullName.split('/')[0];
          const installation = await findInstallation(owner, appId, privateKey);
          await store.upsert({
            team_id: popupTeam,
            service_id: '_auto',
            repo_full_name: repoFullName,
            installation_id: installId,
            account_type: installation?.account_type || 'unknown',
            created_by: 'popup-install',
          });
        }
      } catch (err) {
        logger.error(`Failed to process popup installation: ${err}`);
      }
      res.redirect(`${baseUrl}/api/github-app-connect/popup-done`);
      return;
    }

    // Flow 2: With encrypted state param (from install-url)
    if (stateParam) {
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
          res.redirect(
            `${baseUrl}/create?status=error&message=${encodeURIComponent(`Installation does not have access to ${repo}. Please add the repository in GitHub App settings.`)}`,
          );
          return;
        }
      } catch (err) {
        logger.error(`Failed to verify installation repos: ${err}`);
      }

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

      res.redirect(
        `${baseUrl}/create?status=connected&repo=${encodeURIComponent(repo as string)}`,
      );
      return;
    }

    // Flow 3: Direct install from GitHub (no state) — auto-discover repos
    try {
      const repos = await getInstallationRepos(installId, appId, privateKey);
      logger.info(
        `Direct App installation ${installId} (action: ${setup_action}) — accessible repos: ${repos.join(', ') || 'none'}`,
      );

      // Store connections for all accessible repos (generic team/service)
      for (const repoFullName of repos) {
        const owner = repoFullName.split('/')[0];
        const installation = await findInstallation(owner, appId, privateKey);
        await store.upsert({
          team_id: '_auto',
          service_id: '_auto',
          repo_full_name: repoFullName,
          installation_id: installId,
          account_type: installation?.account_type || 'unknown',
          created_by: 'direct-install',
        });
      }

      res.redirect(
        `${baseUrl}/create?status=connected&message=${encodeURIComponent(`GitHub App installed successfully. ${repos.length} repo(s) connected.`)}`,
      );
    } catch (err) {
      logger.error(`Failed to process direct installation: ${err}`);
      res.redirect(
        `${baseUrl}/create?status=error&message=${encodeURIComponent('Failed to process installation. Please try again.')}`,
      );
    }
  });

  // GET /repo-access — check if a repo is accessible via App or PAT
  router.get('/repo-access', async (req: Request, res: Response) => {
    const { team, service, repo } = req.query;
    if (!team || !service || !repo) {
      res.status(400).json({ error: 'Missing required params: team, service, repo' });
      return;
    }

    // Check if we have a stored connection (exact match or any match by repo)
    let connection = await store.find(
      team as string,
      service as string,
      repo as string,
    );
    if (!connection) {
      const allConns = await store.findByRepo(repo as string);
      if (allConns.length > 0) {
        connection = allConns[0];
      }
    }

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

  // GET /repos — list repos from DB only (team-scoped, no global fallback)
  // DB is populated by /repos/sync and /callback flows
  router.get('/repos', async (req: Request, res: Response) => {
    try {
      const team = req.query.team as string | undefined;
      let installationIds: number[];
      if (team) {
        installationIds = await store.findInstallationsByTeam(team);
      } else {
        installationIds = await store.findAllInstallations();
      }

      if (installationIds.length === 0) {
        res.json({ repos: [] });
        return;
      }
      const repoSets = await Promise.all(
        installationIds.map(id => getInstallationRepos(id, appId, privateKey)),
      );
      const allRepos = [...new Set(repoSets.flat())].sort();
      res.json({ repos: allRepos });
    } catch (err) {
      logger.error(`Failed to list repos: ${err}`);
      res.status(500).json({ repos: [] });
    }
  });

  // POST /repos/sync?team=<teamId>&user=<githubLogin> — sync repos for a team
  // admins team: user's personal install + Organization installs
  // other teams: user's personal install only (org repos added explicitly via popup)
  router.post('/repos/sync', async (req: Request, res: Response) => {
    const team = req.query.team as string | undefined;
    const user = req.query.user as string | undefined;
    if (!team) {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    if (!user) {
      res.status(400).json({ error: 'Missing required param: user' });
      return;
    }
    try {
      const installMap = new Map<number, { account_type: string; login: string }>();

      // For admins: also include all Organization installations
      if (team === 'admins') {
        const jwt = makeAppJwt(appId, privateKey);
        const instResp = await fetch(
          'https://api.github.com/app/installations?per_page=100',
          { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } },
        );
        if (instResp.ok) {
          const all = (await instResp.json()) as Array<{ id: number; account: { login: string; type: string } }>;
          for (const inst of all) {
            if (inst.account.type.toLowerCase() === 'organization') {
              installMap.set(inst.id, { account_type: 'organization', login: inst.account.login });
            }
          }
        }
      }

      // Always include the user's personal installation
      const userInstallation = await findInstallation(user, appId, privateKey);
      if (userInstallation) {
        installMap.set(userInstallation.id, {
          account_type: userInstallation.account_type,
          login: user,
        });
      }

      // Also preserve existing DB entries added via popup callback (org installs for non-admins)
      const existingIds = await store.findInstallationsByTeam(team);
      // We'll merge: new sync results + existing popup-added entries
      // But first fetch repos from discovered installations

      if (installMap.size === 0 && existingIds.length === 0) {
        logger.info(`No GitHub App installations found for sync, team=${team}, user=${user}`);
        res.json({ repos: [] });
        return;
      }

      // Fetch repos from discovered installations
      const entries = Array.from(installMap.entries());
      const repoResults = await Promise.all(
        entries.map(async ([instId, meta]) => {
          try {
            const repos = await getInstallationRepos(instId, appId, privateKey);
            return repos.map(r => ({ repo: r, instId, ...meta }));
          } catch (err) {
            logger.warn(`Failed to get repos from installation ${instId} (${meta.login}): ${err}`);
            return [];
          }
        }),
      );

      // Also fetch repos from existing DB installations not in the new set
      const existingOnly = existingIds.filter(id => !installMap.has(id));
      const existingResults = await Promise.all(
        existingOnly.map(async (instId) => {
          try {
            const repos = await getInstallationRepos(instId, appId, privateKey);
            return repos.map(r => ({ repo: r, instId, account_type: 'unknown', login: 'db' }));
          } catch {
            return [];
          }
        }),
      );

      // Replace all connections for this team (clean slate per sync)
      await store.deleteByTeam(team);

      const allRepoEntries = [...repoResults.flat(), ...existingResults.flat()];
      for (const entry of allRepoEntries) {
        await store.upsert({
          team_id: team,
          service_id: '_auto',
          repo_full_name: entry.repo,
          installation_id: entry.instId,
          account_type: entry.account_type,
          created_by: 'sync',
        });
      }

      const allRepos = [...new Set(allRepoEntries.map(e => e.repo))].sort();
      const instSummary = [...entries.map(([id, m]) => `${m.login}(${id})`), ...existingOnly.map(id => `db(${id})`)].join(', ');
      logger.info(`Synced ${allRepos.length} repos for team=${team} from installations: ${instSummary}`);
      res.json({ repos: allRepos });
    } catch (err) {
      logger.error(`Failed to sync repos for team=${team}: ${err}`);
      res.status(500).json({ repos: [] });
    }
  });

  // GET /repo-tags?repo=owner/name
  // Returns semver tags from a GitHub repository (newest first)
  router.get('/repo-tags', async (req: Request, res: Response) => {
    const { repo: repoFullName } = req.query;
    if (!repoFullName || typeof repoFullName !== 'string') {
      res.status(400).json({ error: 'Missing required param: repo (owner/name)' });
      return;
    }

    try {
      const [owner] = repoFullName.split('/');
      // Try owner's installation first, then fall back to all installations
      let installation = await findInstallation(owner, appId, privateKey);
      if (!installation) {
        // Owner may not have the app installed — try all installations
        const jwt = makeAppJwt(appId, privateKey);
        const instResp = await fetch(
          'https://api.github.com/app/installations?per_page=100',
          { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } },
        );
        if (instResp.ok) {
          const installations = (await instResp.json()) as Array<{ id: number; account: { type: string } }>;
          for (const inst of installations) {
            const token = await getInstallationToken(inst.id, appId, privateKey);
            const check = await fetch(
              `https://api.github.com/repos/${repoFullName}`,
              { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
            );
            if (check.ok) {
              installation = { id: inst.id, account_type: inst.account.type };
              break;
            }
          }
        }
      }
      if (!installation) {
        res.status(404).json({ error: 'No GitHub App installation with access to this repo' });
        return;
      }
      const token = await getInstallationToken(installation.id, appId, privateKey);

      // Fetch up to 100 tags
      const resp = await fetch(
        `https://api.github.com/repos/${repoFullName}/tags?per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
        },
      );

      if (!resp.ok) {
        res.json({ tags: [] });
        return;
      }

      const data = (await resp.json()) as Array<{ name: string }>;
      const tags = data.map(t => t.name);

      res.json({ tags });
    } catch (err) {
      logger.error(`Failed to fetch repo tags: ${err}`);
      res.status(500).json({ error: 'Failed to fetch repo tags' });
    }
  });

  // GET /service-config?team=<team>&service=<service>
  // Returns current env vars and secret keys from the service's values.yaml
  router.get('/service-config', async (req: Request, res: Response) => {
    const { team, service } = req.query;
    if (!team || !service) {
      res.status(400).json({ error: 'Missing required params: team, service' });
      return;
    }

    try {
      const owner = 'mctlhq';
      const repo = 'mctl-gitops';
      const filePath = `platform-gitops/services/${team}/${service}/values.yaml`;

      const installation = await findInstallation(owner, appId, privateKey);
      if (!installation) {
        res.status(404).json({ error: 'No GitHub App installation found' });
        return;
      }
      const token = await getInstallationToken(installation.id, appId, privateKey);

      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=main`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3.raw',
          },
        },
      );

      if (!resp.ok) {
        res.json({ envVars: '', secretKeys: [] });
        return;
      }

      const yaml = await resp.text();

      // Parse env vars from "env:" block
      const envLines: string[] = [];
      const lines = yaml.split('\n');
      let inEnv = false;
      for (const line of lines) {
        if (/^env:/.test(line)) {
          inEnv = true;
          continue;
        }
        if (inEnv) {
          if (/^\S/.test(line)) break; // next top-level key
          const m = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
          if (m) envLines.push(`${m[1]}=${m[2]}`);
        }
      }

      // Parse secret keys from "externalSecret.data[].secretKey"
      const secretKeys: string[] = [];
      let inExtSecret = false;
      for (const line of lines) {
        if (/^externalSecret:/.test(line)) {
          inExtSecret = true;
          continue;
        }
        if (inExtSecret && /^\S/.test(line)) {
          inExtSecret = false;
          continue;
        }
        if (inExtSecret) {
          const m = line.match(/secretKey:\s*(\S+)/);
          if (m) secretKeys.push(m[1]);
        }
      }

      res.json({
        envVars: envLines.join('\n'),
        secretKeys,
      });
    } catch (err) {
      logger.error(`Failed to fetch service config: ${err}`);
      res.status(500).json({ error: 'Failed to fetch service config' });
    }
  });

  // POST /webhook — GitHub App webhook handler for auto-deploy on tag push
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    // Verify HMAC signature
    if (!webhookSecret) {
      logger.warn('Webhook received but GITHUB_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    const event = req.headers['x-github-event'] as string;

    // Only handle tag creation events
    if (event !== 'create' || payload.ref_type !== 'tag') {
      res.status(200).json({ ignored: true, reason: `event=${event} ref_type=${payload.ref_type}` });
      return;
    }

    const repoFullName = payload.repository?.full_name;
    const tagName = payload.ref;
    logger.info(`Webhook: tag "${tagName}" created in ${repoFullName}`);

    // Respond immediately (GitHub 10s timeout)
    res.status(200).json({ accepted: true, repo: repoFullName, tag: tagName });

    // Async: look up component and trigger deploy or notify
    try {
      if (!catalogClient) {
        logger.warn('Webhook: catalog client not available, skipping');
        return;
      }

      // Find component with matching source-repo annotation
      const entities = await catalogClient.getEntities({
        filter: {
          kind: 'Component',
          'metadata.annotations.github.com/source-repo': repoFullName,
        },
      });

      if (!entities.items || entities.items.length === 0) {
        logger.info(`Webhook: no component found for repo ${repoFullName}, skipping`);
        return;
      }

      for (const entity of entities.items) {
        const autoDeploy = entity.metadata?.annotations?.['mctl.me/auto-deploy'];
        // "true"/"auto" = deploy immediately, "confirm" = notify only, "false"/missing = skip
        const mode = autoDeploy === 'true' || autoDeploy === 'auto' ? 'auto' : autoDeploy === 'confirm' ? 'confirm' : null;
        const entityRef = `component:${entity.metadata.namespace || 'default'}/${entity.metadata.name}`;
        const ownerRef = entity.spec?.owner as string | undefined;

        // Send notification for any matched component (regardless of mode)
        if (notifications) {
          const ns = entity.metadata.namespace || 'default';
          const name = entity.metadata.name;
          // Resolve ownerRef to full entity ref (e.g. "group:admin" → "group:default/admin")
          let resolvedRecipient: string | undefined;
          if (ownerRef) {
            if (ownerRef.includes('/')) {
              resolvedRecipient = ownerRef; // already fully qualified
            } else if (ownerRef.includes(':')) {
              const [kind, n] = ownerRef.split(':');
              resolvedRecipient = `${kind}:${ns}/${n}`;
            } else {
              resolvedRecipient = `group:${ns}/${ownerRef}`;
            }
          }

          const title = mode === 'auto'
            ? `Auto-deploying ${name} → ${tagName}`
            : mode === 'confirm'
              ? `New version available: ${name} ${tagName}`
              : `New tag ${tagName} for ${name}`;
          const description = mode === 'auto'
            ? `Tag ${tagName} pushed to ${repoFullName}. Deployment started automatically (mctl.me/auto-deploy: true).`
            : mode === 'confirm'
              ? `Tag ${tagName} pushed to ${repoFullName}. Approve deployment from the catalog.`
              : `Tag ${tagName} was created in ${repoFullName}.`;

          try {
            await notifications.send({
              recipients: resolvedRecipient
                ? { type: 'entity', entityRef: resolvedRecipient }
                : { type: 'broadcast' },
              payload: {
                title,
                description,
                link: mode === 'confirm'
                  ? `/create/templates/default/deploy-version?${new URLSearchParams({ serviceName: entityRef, gitTag: tagName }).toString()}`
                  : `/catalog/${ns}/component/${name}`,
                topic: `deploy:${ns}/${name}`,
                severity: mode === 'auto' ? 'normal' : 'low',
              },
            });
            logger.info(`Webhook: notification sent for ${entityRef}@${tagName} to ${resolvedRecipient || 'broadcast'}`);
          } catch (notifyErr) {
            logger.warn(`Webhook: failed to send notification: ${notifyErr}`);
          }
        }

        if (!mode) {
          logger.info(`Webhook: ${entityRef} has auto-deploy=${autoDeploy}, skipping deploy`);
          continue;
        }

        if (mode === 'confirm') {
          logger.info(`Webhook: [CONFIRM] ${entityRef}@${tagName} ready to deploy — approve via Backstage UI`);
          continue;
        }

        // mode === 'auto': deploy immediately
        if (!scaffolderClient) {
          logger.warn('Webhook: scaffolder client not available, cannot auto-deploy');
          continue;
        }

        logger.info(`Webhook: triggering deploy-version for ${entityRef} with tag ${tagName}`);

        const task = await scaffolderClient.createTask({
          templateRef: 'template:default/deploy-version',
          values: {
            serviceName: entityRef,
            gitTag: tagName,
          },
        });

        logger.info(`Webhook: scaffolder task created: ${task.id} for ${entityRef}@${tagName}`);
      }
    } catch (err) {
      logger.error(`Webhook auto-deploy failed: ${err}`);
    }
  });

  return router;
}
