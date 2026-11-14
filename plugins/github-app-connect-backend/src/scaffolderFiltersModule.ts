import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderTemplatingExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';

/**
 * Converts a repo name to a K8s-safe service name (a DNS-1123 label).
 * The 63-character cut comes before the edge-hyphen trim, so a cut that
 * lands after a hyphen cannot leave the name ending in one.
 * Usage: ${{ parameters.dockerfileRepo | serviceName }}
 * Example: "mashkoffdmitry/tsvilt.ru" → "tsvilt-ru"
 */
export function serviceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repo = value.split('/').pop() || value;
  return repo
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 63)
    .replace(/^-+|-+$/g, '');
}

/**
 * Registers custom Nunjucks template filters for use in scaffolder templates.
 *
 * Filters:
 *   repoName — extracts the repo name from an "owner/repo" string.
 *   Usage: ${{ parameters.dockerfileRepo | repoName }}
 *   Example: "mctlhq/my-app" → "my-app"
 *   serviceName — see serviceName() above.
 */
export const scaffolderFiltersModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-filters',
  register(reg) {
    reg.registerInit({
      deps: {
        templating: scaffolderTemplatingExtensionPoint,
      },
      async init({ templating }) {
        templating.addTemplateFilters({
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
          serviceName,
        });
      },
    });
  },
});
