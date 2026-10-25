/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';
import { rootHttpRouterServiceFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { DatabaseManager } from '@backstage/backend-defaults/database';
import { githubAuthModule } from './githubAuthModule';
import { kubernetesEntityScopeModule } from './kubernetesEntityScope';
import { zitadelAuthModule } from './zitadelAuthModule';
import { techdocsWarmupModule } from './techdocsWarmup';
import {
  authModuleGithubInstallRedirect,
  scaffolderFiltersModule,
  githubDiscoveryProcessorModule,
} from '@internal/plugin-github-app-connect-backend';
import { tenantCatalogModule, createCustomerRevocationMiddleware, ensureCustomerDeletionSchema } from '@internal/plugin-tenant-backend';

const backend = createBackend();

backend.add(rootHttpRouterServiceFactory({
  configure({ app, config, logger, lifecycle, applyDefaults }) {
    const database = DatabaseManager.fromConfig(config).forPlugin('tenant-management', { logger, lifecycle });
    let ready: ReturnType<typeof database.getClient> | undefined;
    const getReady = () => {
      ready ??= database.getClient().then(async db => {
        await ensureCustomerDeletionSchema(db);
        return db;
      }).catch(error => { ready = undefined; throw error; });
      return ready;
    };
    // Register before the default plugin router, so no plugin can accidentally
    // accept an old customer user JWT after its account has been deleted.
    app.use(createCustomerRevocationMiddleware({
      logger,
      appOrigin: new URL(config.getString('app.baseUrl')).origin,
      isRevoked: async principalId => {
        const db = await getReady();
        return Boolean(await db('customer_deletions').where({ principal_id: principalId })
          .whereIn('status', ['active', 'complete']).first().timeout(3000, { cancel: true }));
      },
    }));
    applyDefaults();
  },
}));

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(import('@roadiehq/scaffolder-backend-module-http-request'));

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));
backend.add(techdocsWarmupModule);

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// GitHub sign-in, only for catalog Users (tenant members); off under
// auth.signIn: zitadel, where the provider only serves ScmAuth tokens
backend.add(githubAuthModule);
// ZITADEL sign-in (provider `oidc`), same catalog-only rule through the
// mctl:github_login claim; inert until auth.providers.oidc is configured
backend.add(zitadelAuthModule);

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
// Resolves Kubernetes lookups from the catalog with the caller's credentials
// instead of trusting the entity in the request body.
backend.add(kubernetesEntityScopeModule);

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// github app connect — self-service repo access via GitHub App installation
backend.add(import('@internal/plugin-github-app-connect-backend'));
// intercept GitHub App install callbacks at /api/auth/github/handler/frame
backend.add(authModuleGithubInstallRedirect);
// custom Nunjucks template filters (repoName: "owner/repo" → "repo")
backend.add(scaffolderFiltersModule);
// GithubDiscoveryProcessor: expands GitHub glob location URLs into individual
// entity locations so that services/workers catalog-info.yaml files are found
backend.add(githubDiscoveryProcessorModule);

// vault secrets — serve DB credentials to authorized team members
backend.add(import('@internal/plugin-vault-secrets-backend'));

// resource usage — serve K8s namespace quota + live metrics to frontend cards
backend.add(import('@internal/plugin-resource-usage-backend'));

// tenant management — syncs tenant YAMLs from Git, serves REST API, creates tenants via Argo
backend.add(import('@internal/plugin-tenant-backend'));
backend.add(tenantCatalogModule);

// argo workflows — submit WorkflowTemplates from scaffolder (replaces GitHub Actions dispatch)
backend.add(import('@internal/plugin-argo-workflows-backend'));

// OIDC Provider — Backstage as identity provider for ArgoCD/Dex/Argo Workflows
backend.add(import('@internal/plugin-oidc-provider-backend'));

// custom domains — manage custom domain mappings for services
backend.add(import('@internal/plugin-custom-domains-backend'));

// proposals — review mctl-agents proposals from mctl-gitops
backend.add(
  import('@internal/plugin-proposals-backend').then(m => ({
    default: m.proposalsPlugin,
  })),
);

// work items — read-only canonical WorkItem view via mctl-api (surface:portal relay)
backend.add(import('@internal/plugin-work-items-backend'));

backend.start();
