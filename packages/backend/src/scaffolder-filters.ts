import { scaffolderTemplatingExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createBackendModule } from '@backstage/backend-plugin-api';

/**
 * Backend module that registers custom Nunjucks template filters
 * for use in Backstage scaffolder templates.
 */
export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-filters',
  register(env) {
    env.registerInit({
      deps: { templating: scaffolderTemplatingExtensionPoint },
      async init({ templating }) {
        templating.addTemplateFilters({
          /**
           * Extracts the repository name from an "owner/repo" string.
           * Usage in template: ${{ parameters.dockerfileRepo | repoName }}
           * Example: "mctlhq/my-app" → "my-app"
           */
          repoName: (value: unknown): string | undefined => {
            if (typeof value !== 'string') return undefined;
            return value.split('/').pop() || value;
          },

          /**
           * Converts a repo name to a K8s-safe service name.
           * Lowercases, replaces dots/underscores with hyphens, strips invalid chars.
           * Usage: ${{ parameters.dockerfileRepo | serviceName }}
           * Example: "mashkoffdmitry/tsvilt.ru" → "tsvilt-ru"
           */
          serviceName: (value: unknown): string | undefined => {
            if (typeof value !== 'string') return undefined;
            const repo = value.split('/').pop() || value;
            return repo
              .toLowerCase()
              .replace(/[._]/g, '-')
              .replace(/[^a-z0-9-]/g, '')
              .replace(/^-+|-+$/g, '')
              .substring(0, 63);
          },
        });
      },
    });
  },
});
