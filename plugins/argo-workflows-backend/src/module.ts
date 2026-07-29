import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createSubmitWorkflowAction } from './scaffolderActions';
import { createRequireTeamAccessAction } from './teamAccessAction';

/**
 * Backstage backend module that registers the `mctl:workflow:submit` and
 * `mctl:auth:requireTeamAccess` scaffolder actions.
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
        database: coreServices.database,
      },
      async init({ scaffolder, config, database }) {
        scaffolder.addActions(
          createSubmitWorkflowAction({ config }),
          createRequireTeamAccessAction({ database }),
        );
      },
    });
  },
});
