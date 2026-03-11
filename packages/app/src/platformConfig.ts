import { configApiRef, useApi } from '@backstage/core-plugin-api';

export function usePlatformConfig() {
  const config = useApi(configApiRef);
  return {
    domain: config.getOptionalString('platform.domain') ?? 'mctl.ai',
    domainAlt: config.getOptionalString('platform.domainAlt') ?? 'mctl.me',
    githubOrg: config.getOptionalString('platform.githubOrg') ?? 'mctlhq',
    argocdBaseUrl: config.getOptionalString('platform.argocdBaseUrl') ?? 'https://ops.mctl.me/applications/argocd',
    argoWorkflowsBaseUrl: config.getOptionalString('platform.argoWorkflowsBaseUrl') ?? 'https://workflows.mctl.me',
    gitopsRepo: config.getOptionalString('platform.gitopsRepo') ?? 'mctl-gitops',
    containerRegistry: config.getOptionalString('platform.containerRegistry') ?? 'ghcr.io/mctlhq',
  };
}
