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
  discoveryApiRef,
  oauthRequestApiRef,
} from '@backstage/core-plugin-api';
import { OAuth2 } from '@backstage/core-app-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import AccountCircleIcon from '@material-ui/icons/AccountCircle';
import GitHubIcon from '@material-ui/icons/GitHub';
import {
  ZITADEL_AUTH_PROVIDER_ID,
  ZITADEL_CUSTOMER_AUTH_PROVIDER_ID,
  zitadelAuthApiRef,
  zitadelCustomerAuthApiRef,
} from './signIn';

export const apis: AnyApiFactory[] = [
  createApiFactory({
    api: scmIntegrationsApiRef,
    deps: { configApi: configApiRef },
    factory: ({ configApi }) => ScmIntegrationsApi.fromConfig(configApi),
  }),
  ScmAuth.createDefaultApiFactory(),
  // ZITADEL sign-in, auth provider `oidc` in the backend. offline_access
  // asks ZITADEL for a refresh token, which the session refresh needs.
  createApiFactory({
    api: zitadelAuthApiRef,
    deps: {
      discoveryApi: discoveryApiRef,
      oauthRequestApi: oauthRequestApiRef,
      configApi: configApiRef,
    },
    factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
      OAuth2.create({
        configApi,
        discoveryApi,
        oauthRequestApi,
        provider: {
          id: ZITADEL_AUTH_PROVIDER_ID,
          title: 'MCTL account',
          icon: AccountCircleIcon,
        },
        environment: configApi.getOptionalString('auth.environment'),
        defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
      }),
  }),
  // The customer entry, auth provider `zitadel-customer`: the same ZITADEL
  // client, with the customers organization and GitHub IdP scopes added by
  // the backend. Used only when the sign-in page offers it.
  createApiFactory({
    api: zitadelCustomerAuthApiRef,
    deps: {
      discoveryApi: discoveryApiRef,
      oauthRequestApi: oauthRequestApiRef,
      configApi: configApiRef,
    },
    factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
      OAuth2.create({
        configApi,
        discoveryApi,
        oauthRequestApi,
        provider: {
          id: ZITADEL_CUSTOMER_AUTH_PROVIDER_ID,
          title: 'GitHub',
          icon: GitHubIcon,
        },
        environment: configApi.getOptionalString('auth.environment'),
        defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
      }),
  }),
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
