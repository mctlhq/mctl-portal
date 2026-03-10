/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';
import { githubAuthModuleWithFallback } from './githubAuthModule';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(import('@roadiehq/scaffolder-backend-module-http-request'));

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// Custom GitHub auth with fallback — allows login even before catalog entity exists
backend.add(githubAuthModuleWithFallback);

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// github entity provider — auto-discovers catalog-info.yaml files in repos
backend.add(import('@backstage/plugin-catalog-backend-module-github'));

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// Team-based permission policy — filters catalog entities by team ownership
backend.add(
  import('@internal/plugin-permission-backend-module-team-policy'),
);

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// github app connect — self-service repo access via GitHub App installation
backend.add(import('@internal/plugin-github-app-connect-backend'));
// intercept GitHub App install callbacks at /api/auth/github/handler/frame
backend.add(
  import('@internal/plugin-github-app-connect-backend').then(m => ({
    default: m.authModuleGithubInstallRedirect,
  })),
);
// dispatch GitHub Actions workflows and stream logs into scaffolder console
backend.add(
  import('@internal/plugin-github-app-connect-backend').then(m => ({
    default: m.scaffolderModuleGithubActionsStream,
  })),
);
// custom Nunjucks template filters (repoName: "owner/repo" → "repo")
backend.add(
  import('@internal/plugin-github-app-connect-backend').then(m => ({
    default: m.scaffolderFiltersModule,
  })),
);
// GithubDiscoveryProcessor: expands GitHub glob location URLs into individual
// entity locations so that services/workers catalog-info.yaml files are found
backend.add(
  import('@internal/plugin-github-app-connect-backend').then(m => ({
    default: m.githubDiscoveryProcessorModule,
  })),
);

// vault secrets — serve DB credentials to authorized team members
backend.add(import('@internal/plugin-vault-secrets-backend'));

// resource usage — serve K8s namespace quota + live metrics to frontend cards
backend.add(import('@internal/plugin-resource-usage-backend'));

// tenant management — syncs tenant YAMLs from Git, serves REST API, creates tenants via Argo
backend.add(
  import('@internal/plugin-tenant-backend').then(m => ({
    default: m.tenantPlugin,
  })),
);

// argo workflows — submit WorkflowTemplates from scaffolder (replaces GitHub Actions dispatch)
backend.add(
  import('@internal/plugin-argo-workflows-backend').then(m => ({
    default: m.scaffolderModuleArgoWorkflows,
  })),
);

// OIDC Provider — Backstage as identity provider for ArgoCD/Dex/Argo Workflows
backend.add(
  import('@internal/plugin-oidc-provider-backend').then(m => ({
    default: m.oidcProviderPlugin,
  })),
);

// custom domains — manage custom domain mappings for services
backend.add(import('@internal/plugin-custom-domains-backend'));

backend.start();
