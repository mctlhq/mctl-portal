import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Config } from '@backstage/config';
import fetch from 'node-fetch';
import * as crypto from 'crypto';

interface Run {
  id: number;
  path: string;
  created_at: string;
  status: string;
  conclusion: string | null;
}

interface Job {
  id: number;
  name: string;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
  }>;
}

function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

async function getInstallationToken(
  owner: string,
  appId: string,
  privateKey: string,
): Promise<string> {
  const jwt = generateJwt(appId, privateKey);
  const ghHeaders = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Backstage-Scaffolder',
  };

  for (const kind of ['users', 'orgs']) {
    const resp = await fetch(`https://api.github.com/${kind}/${owner}/installation`, {
      headers: ghHeaders,
    });
    if (!resp.ok) continue;
    const { id } = (await resp.json()) as { id: number };
    const tokenResp = await fetch(
      `https://api.github.com/app/installations/${id}/access_tokens`,
      { method: 'POST', headers: ghHeaders },
    );
    if (!tokenResp.ok) throw new Error(`Failed to get installation token: ${tokenResp.status}`);
    const { token } = (await tokenResp.json()) as { token: string };
    return token;
  }
  throw new Error(`No GitHub App installation found for owner: ${owner}`);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export function createDispatchAndStreamAction(options: { config: Config }) {
  const { config } = options;

  return createTemplateAction({
    id: 'github:actions:dispatch-and-stream',
    schema: {
      input: {
        repoUrl: z =>
          z.string().describe('Format: github.com?repo=mctl-gitops&owner=mctlhq'),
        workflowId: z => z.string().describe('Workflow filename (e.g. release-service.yml)'),
        branchOrTagName: z => z.string().describe('Branch or tag name'),
        workflowInputs: z => z.record(z.string()).optional().describe('Workflow inputs'),
      },
      output: {
        runId: z => z.string().optional().describe('GitHub Actions run ID'),
        runUrl: z => z.string().optional().describe('URL to the GitHub Actions run'),
      },
    },
    async handler(ctx) {
      const appId = config.getString('githubAppConnect.appId');
      const privateKey = config.getString('githubAppConnect.privateKey');

      const url = new URL(`https://${ctx.input.repoUrl}`);
      const owner = url.searchParams.get('owner') ?? '';
      const repo = url.searchParams.get('repo') ?? '';
      if (!owner || !repo) throw new Error(`Invalid repoUrl: ${ctx.input.repoUrl}`);

      const token = await getInstallationToken(owner, appId, privateKey);
      const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Backstage-Scaffolder',
      };
      const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

      ctx.logger.info(
        `Dispatching ${ctx.input.workflowId} on ${owner}/${repo}@${ctx.input.branchOrTagName}`,
      );
      const dispatchedAt = new Date();

      const dispResp = await fetch(
        `${baseUrl}/actions/workflows/${ctx.input.workflowId}/dispatches`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ref: ctx.input.branchOrTagName,
            inputs: (ctx.input.workflowInputs as Record<string, string>) ?? {},
          }),
        },
      );
      if (!dispResp.ok) {
        const body = await dispResp.text();
        throw new Error(`Workflow dispatch failed: ${dispResp.status} ${body}`);
      }

      ctx.logger.info('Waiting for run to appear...');

      let runId: number | undefined;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const r = await fetch(
          `${baseUrl}/actions/runs?event=workflow_dispatch&branch=${ctx.input.branchOrTagName}&per_page=10`,
          { headers },
        );
        if (!r.ok) continue;
        const { workflow_runs } = (await r.json()) as { workflow_runs: Run[] };
        const run = workflow_runs.find(
          wr =>
            wr.path.includes(ctx.input.workflowId as string) &&
            new Date(wr.created_at) >= dispatchedAt,
        );
        if (run) {
          runId = run.id;
          const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
          ctx.output('runId', String(runId));
          ctx.output('runUrl', runUrl);
          ctx.logger.info(
            `Run #${runId}: ${runUrl}`,
          );
          break;
        }
      }
      if (!runId) throw new Error('Timed out waiting for workflow run to appear');

      const seenSteps = new Set<string>();
      let lastStatus = '';

      while (true) {
        await sleep(5000);

        const [runResp, jobsResp] = await Promise.all([
          fetch(`${baseUrl}/actions/runs/${runId}`, { headers }),
          fetch(`${baseUrl}/actions/runs/${runId}/jobs`, { headers }),
        ]);

        if (!runResp.ok) continue;
        const run = (await runResp.json()) as { status: string; conclusion: string | null };

        if (run.status !== lastStatus) {
          ctx.logger.info(`Status: ${run.status}`);
          lastStatus = run.status;
        }

        if (jobsResp.ok) {
          const { jobs } = (await jobsResp.json()) as { jobs: Job[] };
          for (const job of jobs) {
            for (const step of job.steps ?? []) {
              const key = `${job.id}-${step.number}-${step.conclusion}`;
              if (step.status === 'completed' && !seenSteps.has(key)) {
                seenSteps.add(key);
                const icon =
                  step.conclusion === 'success'
                    ? '[OK]'
                    : step.conclusion === 'skipped'
                      ? '[SKIP]'
                      : '[FAIL]';
                ctx.logger.info(`  ${icon} [${job.name}] ${step.name}`);
              }
            }
          }
        }

        if (run.status === 'completed') {
          if (run.conclusion === 'success') {
            ctx.logger.info('Workflow completed successfully!');
          } else {
            throw new Error(
              `Workflow failed with conclusion: ${run.conclusion}. Details: https://github.com/${owner}/${repo}/actions/runs/${runId}`,
            );
          }
          break;
        }
      }
    },
  });
}
