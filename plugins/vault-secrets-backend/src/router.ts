import { Router, Request, Response } from 'express';
import fetch from 'node-fetch';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  vaultAddr: string;
  vaultToken: string;
}

export function createRouter(options: RouterOptions): Router {
  const { logger, httpAuth, userInfo, vaultAddr, vaultToken } = options;
  const router = Router();

  // GET /teams/:team/:app/database — returns DB credentials for the given team/app
  // Requires: caller must be a member of the team group
  router.get('/teams/:team/:app/database', async (req: Request, res: Response) => {
    const { team, app } = req.params;

    try {
      // Authenticate and get user identity
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);

      // Check team membership via ownershipEntityRefs (e.g. "group:default/payments")
      const isTeamMember = ownershipEntityRefs.some(ref => {
        const name = ref.split('/').pop()?.toLowerCase();
        return name === team.toLowerCase();
      });

      if (!isTeamMember) {
        res.status(403).json({ error: `Access denied: not a member of team '${team}'` });
        return;
      }

      // Read credentials from Vault (KV v2)
      const vaultPath = `platform/teams/${team}/${app}/database`;
      const vaultResp = await fetch(`${vaultAddr}/v1/secret/data/${vaultPath}`, {
        headers: { 'X-Vault-Token': vaultToken },
      });

      if (vaultResp.status === 404) {
        res.status(404).json({ error: `No database found for ${team}/${app}` });
        return;
      }

      if (!vaultResp.ok) {
        logger.error(`Vault read failed for ${vaultPath}: HTTP ${vaultResp.status}`);
        res.status(502).json({ error: 'Failed to read credentials from Vault' });
        return;
      }

      const vaultData = (await vaultResp.json()) as any;
      const creds = vaultData?.data?.data;

      if (!creds) {
        res.status(404).json({ error: 'Credentials not found in Vault' });
        return;
      }

      res.json({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        username: creds.username,
        password: creds.password,
      });
    } catch (err: any) {
      if (err?.name === 'AuthenticationError' || err?.message?.includes('auth')) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /teams/:team/:app/secrets — returns all secret key-value pairs for the service
  // Requires: caller must be a member of the team group
  router.get('/teams/:team/:app/secrets', async (req: Request, res: Response) => {
    const { team, app } = req.params;

    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);

      const isTeamMember = ownershipEntityRefs.some(ref => {
        const name = ref.split('/').pop()?.toLowerCase();
        return name === team.toLowerCase();
      });

      if (!isTeamMember) {
        res.status(403).json({ error: `Access denied: not a member of team '${team}'` });
        return;
      }

      const vaultPath = `teams/${team}/${app}`;
      const vaultResp = await fetch(`${vaultAddr}/v1/secret/data/${vaultPath}`, {
        headers: { 'X-Vault-Token': vaultToken },
      });

      if (vaultResp.status === 404) {
        res.json({ secrets: {} });
        return;
      }

      if (!vaultResp.ok) {
        logger.error(`Vault read failed for ${vaultPath}: HTTP ${vaultResp.status}`);
        res.status(502).json({ error: 'Failed to read secrets from Vault' });
        return;
      }

      const vaultData = (await vaultResp.json()) as any;
      const secrets = vaultData?.data?.data ?? {};

      res.json({ secrets });
    } catch (err: any) {
      if (err?.name === 'AuthenticationError' || err?.message?.includes('auth')) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
