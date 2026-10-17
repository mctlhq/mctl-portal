import { Entity } from '@backstage/catalog-model';
import { PRINCIPAL_ID } from './creatorPrincipal';
import { TenantStore } from './tenantStore';
import { TenantMember } from './types';

export interface PlatformAccessObservation {
  version: 1;
  tenant: string;
  principalId: string;
  role: string;
  observedAt: string;
  infrastructure: 'ready' | 'pending';
  environments: Array<{
    name: string;
    namespace: string;
    status: 'ready' | 'pending';
  }>;
  portal: 'configured' | 'blocked';
  mcp: 'available' | 'blocked';
}

export interface WorkspaceAccess {
  tenant: string;
  principalId: string;
  account: string;
  role: string;
  observedAt: string;
  status: 'ready' | 'provisioning';
  environments: PlatformAccessObservation['environments'];
  capabilities: Array<{ id: 'portal' | 'mcp'; label: string; url: string }>;
  mcp: 'available' | 'blocked';
  accessUrl: string;
}

export type WorkspaceAccessReader = (
  member: TenantMember,
) => Promise<WorkspaceAccess>;

// A malformed or partial platform response is never an empty capability list.
export function readPlatformObservation(
  value: unknown,
  member: TenantMember,
): PlatformAccessObservation {
  const x = value as PlatformAccessObservation | null;
  const envs = x?.environments;
  if (
    !x ||
    x.version !== 1 ||
    x.tenant !== member.tenantName ||
    x.principalId !== member.principalId ||
    x.role !== member.role ||
    !Number.isFinite(Date.parse(x.observedAt)) ||
    Math.abs(Date.now() - Date.parse(x.observedAt)) > 60_000 ||
    !['ready', 'pending'].includes(x.infrastructure) ||
    !['configured', 'blocked'].includes(x.portal) ||
    !['available', 'blocked'].includes(x.mcp) ||
    !Array.isArray(envs) ||
    envs.length !== 2 ||
    !envs.some(
      e => e.name === 'production' && e.namespace === member.tenantName,
    ) ||
    !envs.some(
      e =>
        e.name === 'preview' && e.namespace === `${member.tenantName}-preview`,
    ) ||
    envs.some(e => !['ready', 'pending'].includes(e.status)) ||
    (x.infrastructure === 'ready' && envs.some(e => e.status !== 'ready'))
  ) {
    throw new Error(
      'Platform access observation is incomplete or inconsistent',
    );
  }
  return x;
}

export function createWorkspaceAccessReader(options: {
  store: Pick<TenantStore, 'getMemberByTenant'>;
  observePlatform: (member: TenantMember) => Promise<unknown>;
  getCatalogEntity: (
    kind: 'group' | 'user',
    name: string,
  ) => Promise<Entity | undefined>;
}): WorkspaceAccessReader {
  return async member => {
    if (
      member.catalogKey !== 'principal' ||
      !member.principalId ||
      !PRINCIPAL_ID.test(member.principalId) ||
      member.userId !== member.principalId.toLowerCase() ||
      !member.login
    ) {
      throw new Error(
        'Verified workspace access requires principal-keyed membership',
      );
    }
    const current = await options.store.getMemberByTenant(
      member.tenantName,
      member.userId,
    );
    if (
      !current ||
      current.principalId !== member.principalId ||
      current.role !== member.role
    ) {
      throw new Error('Workspace membership changed or was revoked');
    }
    const platform = readPlatformObservation(
      await options.observePlatform(current),
      current,
    );
    const group = await options.getCatalogEntity('group', member.tenantName);
    const user = await options.getCatalogEntity('user', member.userId);
    const owner = `group:default/${member.tenantName}`;
    const catalogReady =
      group?.kind === 'Group' &&
      group.metadata.name === member.tenantName &&
      group.spec?.owner === owner &&
      Array.isArray(group.spec?.members) &&
      group.spec.members.includes(member.userId) &&
      user?.kind === 'User' &&
      user.metadata.name === member.userId &&
      user.spec?.owner === owner &&
      Array.isArray(user.spec?.memberOf) &&
      user.spec.memberOf.includes(member.tenantName) &&
      user.metadata.annotations?.['mctl.me/principal-id'] ===
        member.principalId;
    const capabilities: WorkspaceAccess['capabilities'] = [];
    if (platform.portal === 'configured' && catalogReady) {
      capabilities.push({
        id: 'portal',
        label: 'Workspace portal',
        url: `https://app.mctl.ai/catalog/default/group/${member.tenantName}`,
      });
    }
    if (platform.mcp === 'available')
      capabilities.push({
        id: 'mcp',
        label: 'MCP',
        url: 'https://api.mctl.ai/mcp',
      });
    // Check again after external reads, rather than publishing an observation
    // for a membership removed while catalog/infrastructure was being read.
    const after = await options.store.getMemberByTenant(
      member.tenantName,
      member.userId,
    );
    if (
      !after ||
      after.principalId !== member.principalId ||
      after.role !== member.role
    )
      throw new Error('Workspace membership changed');
    return {
      tenant: member.tenantName,
      principalId: member.principalId,
      account: `${member.login}@mctl.ai`,
      role: member.role,
      observedAt: platform.observedAt,
      status:
        platform.infrastructure === 'ready' &&
        capabilities.some(c => c.id === 'portal')
          ? 'ready'
          : 'provisioning',
      environments: platform.environments,
      capabilities,
      mcp: platform.mcp,
      accessUrl: 'https://app.mctl.ai/workspace/access',
    };
  };
}

export function createPlatformAccessObserver(
  baseUrl: string,
  surfaceToken: string,
) {
  return async (member: TenantMember): Promise<unknown> => {
    const response = await fetch(
      `${baseUrl.replace(
        /\/$/,
        '',
      )}/api/v1/surface-principals/workspace-access/${encodeURIComponent(
        member.tenantName,
      )}`,
      {
        headers: {
          Authorization: `Bearer ${surfaceToken}`,
          'X-MCTL-Surface-Actor': `principal:${member.principalId}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Platform access observation unavailable (${response.status})`,
      );
    return response.json();
  };
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
        c
      ]!),
  );

export function renderWorkspaceReady(access: WorkspaceAccess, email: string) {
  if (access.status !== 'ready') throw new Error('Workspace is not ready');
  const subject = `Your MCTL workspace "${access.tenant}" is ready`;
  const lines = [
    `Your workspace "${access.tenant}" is ready.`,
    '',
    `Account: ${access.account} (account identifier, not a mailbox)`,
    `Role: ${access.role}`,
    'Sign in with GitHub. You do not need a separate password or passkey.',
    '',
    `Access verified as of ${access.observedAt}:`,
    ...access.capabilities.map(c => `${c.label}: ${c.url}`),
    '',
    'Environments:',
    ...access.environments
      .filter(e => e.status === 'ready')
      .map(e => `${e.name}: ${e.namespace}`),
    '',
    'This email is a snapshot. Permissions may change; see your current access:',
    access.accessUrl,
    ...(access.mcp === 'blocked'
      ? [
          '',
          'AI client connections are not enabled for this account yet. Check the Access page for updates.',
        ]
      : []),
    '',
    'Questions? https://mctl.ai/#contact',
  ];
  const text = lines.join('\n');
  return {
    from: 'MCTL <noreply@mctl.ai>',
    to: [email],
    subject,
    text,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
      subject,
    )}</title></head>
<body style="margin:0;padding:0;background:#f5f3ef;font-family:Arial,sans-serif;color:#252422">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #ddd;border-radius:12px"><tr><td style="padding:32px">
<p style="font-size:20px;font-weight:bold"><span style="color:#b83d28">M</span>CTL</p>
<h1 style="font-size:22px;line-height:1.3">${escapeHtml(subject)}</h1>
<p style="line-height:1.6">Account: <strong>${escapeHtml(
      access.account,
    )}</strong> (account identifier, not a mailbox)<br>Role: <strong>${escapeHtml(
      access.role,
    )}</strong></p>
<p style="line-height:1.6">Sign in with GitHub. You do not need a separate password or passkey.</p>
<p>Access verified as of ${escapeHtml(access.observedAt)}:</p>
<ul>${access.capabilities
      .map(
        c =>
          `<li style="margin-bottom:8px"><a href="${escapeHtml(
            c.url,
          )}">${escapeHtml(c.label)}</a></li>`,
      )
      .join('')}</ul>
<h2 style="font-size:18px">Environments provisioned</h2>
<ul>${access.environments
      .filter(e => e.status === 'ready')
      .map(e => `<li>${escapeHtml(e.name)}: ${escapeHtml(e.namespace)}</li>`)
      .join('')}</ul>
<p style="line-height:1.6">This email is a snapshot. Permissions may change; the Access page shows the current list.</p>
<p><a href="${escapeHtml(
      access.accessUrl,
    )}" style="display:inline-block;background:#b83d28;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px">View current workspace access</a></p>
${
  access.mcp === 'blocked'
    ? '<p style="line-height:1.6">AI client connections are not enabled for this account yet. Check the Access page for updates.</p>'
    : ''
}
<p style="font-size:13px">Questions? <a href="https://mctl.ai/#contact">Contact MCTL</a></p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
