// Static externalAccess uses its configured subject verbatim in the installed
// Backstage backend. Other framework versions prefix external callers. These
// are the same pinned workflow identity, never plugin-to-plugin credentials.
const WORKFLOW_SUBJECTS = new Set(['mctl-api', 'external:mctl-api']);

export function isTenantWorkflowPrincipal(principal: { type: string; subject?: string }): boolean {
  return principal.type === 'service' && WORKFLOW_SUBJECTS.has(principal.subject ?? '');
}
