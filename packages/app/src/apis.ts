import {
  ScmIntegrationsApi,
  scmIntegrationsApiRef,
  ScmAuth,
} from '@backstage/integration-react';
import {
  AnyApiFactory,
  alertApiRef,
  configApiRef,
  createApiFactory,
} from '@backstage/core-plugin-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';

export const apis: AnyApiFactory[] = [
  createApiFactory({
    api: scmIntegrationsApiRef,
    deps: { configApi: configApiRef },
    factory: ({ configApi }) => ScmIntegrationsApi.fromConfig(configApi),
  }),
  ScmAuth.createDefaultApiFactory(),
  // Backstage 1.50 introduced toastApiRef but app-defaults 1.7.7 still
  // registers only alertApiRef. plugin-notifications components call
  // useApi(toastApiRef) and crash with NotImplementedError, blanking the
  // app. Bridge toast posts to AlertApi so AlertDisplay keeps surfacing
  // them until app-defaults ships a real ToastApiForwarder.
  createApiFactory({
    api: toastApiRef,
    deps: { alertApi: alertApiRef },
    factory: ({ alertApi }) => ({
      post(toast) {
        const message =
          typeof toast.title === 'string' ? toast.title : 'Notification';
        const severity =
          toast.status === 'danger'
            ? 'error'
            : toast.status === 'warning'
              ? 'warning'
              : toast.status === 'info'
                ? 'info'
                : 'success';
        alertApi.post({
          message,
          severity,
          display: toast.timeout ? 'transient' : 'permanent',
        });
        return { close() {} };
      },
    }),
  }),
];
