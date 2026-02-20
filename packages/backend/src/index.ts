/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(import('@roadiehq/scaffolder-backend-module-http-request'));
// custom scaffolder template filters (repoName, etc.)
backend.add(
  import('./scaffolder-filters').then(m => m.scaffolderCustomFiltersModule),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));
// See https://backstage.io/docs/auth/guest/provider

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// github org provider — syncs users and teams from GitHub org into catalog
backend.add(import('@backstage/plugin-catalog-backend-module-github-org'));
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

backend.start();
