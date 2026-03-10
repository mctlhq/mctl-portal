import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createSubmitWorkflowAction } from './scaffolderActions';

/**
 * Backstage backend module that registers the `mctl:workflow:submit` scaffolder action.
 *
 * Required config:
 *   argoWorkflows:
 *     baseUrl: https://workflows.mctl.me
 *     namespace: argo-workflows       # optional, default: argo-workflows
 *     token: <bearer-token>           # optional, for auth-mode=client
 */
export const scaffolderModuleArgoWorkflows = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'argo-workflows',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createSubmitWorkflowAction({ config }));
      },
    });
  },
});
