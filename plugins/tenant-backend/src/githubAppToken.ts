import crypto from 'crypto';
import fetch from 'node-fetch';

/**
 * Generates a GitHub App installation token using the App's private key.
 * Uses only Node.js built-in crypto and node-fetch (no extra deps).
 */
export async function getGithubAppInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${sigInput}.${signature}`;

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!resp.ok) {
    throw new Error(
      `GitHub App token exchange failed: ${resp.status} ${await resp.text()}`,
    );
  }

  const body = (await resp.json()) as { token: string };
  return body.token;
}
