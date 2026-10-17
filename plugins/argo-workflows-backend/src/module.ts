import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createSubmitWorkflowAction } from './scaffolderActions';
import { createRequireTeamAccessAction } from './teamAccessAction';

/**
 * Backstage backend module that registers the `mctl:workflow:submit` and
 * `mctl:auth:requireTeamAccess` scaffolder actions.
 *
 * Required config:
 *   argoWorkflows:
 *     baseUrl: https://workflows.mctl.ai
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
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({ scaffolder, config, database, catalog, auth }) {
        scaffolder.addActions(
          createSubmitWorkflowAction({ config, database, catalog, auth }),
          createRequireTeamAccessAction({ database }),
        );
      },
    });
  },
});
