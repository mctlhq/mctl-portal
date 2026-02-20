import { scaffolderTemplatingExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createBackendModule } from '@backstage/backend-plugin-api';

/**
 * Backend module that registers custom Nunjucks template filters
 * for use in Backstage scaffolder templates.
 */
export const scaffolderCustomFiltersModule = createBackendModule({
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
           * Example: "dmitriimashkov/my-app" → "my-app"
           */
          repoName: (value: string) => {
            if (typeof value !== 'string') return value;
            return value.split('/').pop() || value;
          },
        });
      },
    });
  },
});
