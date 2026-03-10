import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createDispatchAndStreamAction } from './scaffolderActions';

export const scaffolderModuleGithubActionsStream = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'github-actions-stream',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createDispatchAndStreamAction({ config }));
      },
    });
  },
});
