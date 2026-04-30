import { Navigate, Route } from 'react-router-dom';
import {
  CatalogEntityPage,
  CatalogIndexPage,
  catalogPlugin,
} from '@backstage/plugin-catalog';
import {
  scaffolderPlugin,
  ScaffolderFieldExtensions,
  EntityPickerFieldExtension,
  EntityNamePickerFieldExtension,
  EntityTagsPickerFieldExtension,
  OwnedEntityPickerFieldExtension,
  OwnerPickerFieldExtension,
  RepoUrlPickerFieldExtension,
  MyGroupsPickerFieldExtension,
} from '@backstage/plugin-scaffolder';
import { orgPlugin } from '@backstage/plugin-org';
import { SearchPage } from '@backstage/plugin-search';
import {
  TechDocsIndexPage,
  techdocsPlugin,
  TechDocsReaderPage,
} from '@backstage/plugin-techdocs';
import { TechDocsAddons } from '@backstage/plugin-techdocs-react';
import { ReportIssue } from '@backstage/plugin-techdocs-module-addons-contrib';
import { UserSettingsPage } from '@backstage/plugin-user-settings';
import { apis } from './apis';
import { entityPage } from './components/catalog/EntityPage';
import { searchPage } from './components/search/SearchPage';
import { Root } from './components/Root';
import { NoTenantPage } from './components/tenant/NoTenantPage';

import {
  AlertDisplay,
  OAuthRequestDialog,
  SignInPage,
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';
import { CatalogGraphPage } from '@backstage/plugin-catalog-graph';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { catalogTranslationRef } from '@backstage/plugin-catalog/alpha';
import { coreComponentsTranslationRef } from '@backstage/core-components/alpha';
import { createTranslationMessages } from '@backstage/core-plugin-api/alpha';
import { NotificationsPage } from '@backstage/plugin-notifications';
import { SignalsDisplay } from '@backstage/plugin-signals';
import {
  createTheme as createBackstageTheme,
  darkTheme as backstageDarkTheme,
  lightTheme as backstageLightTheme,
} from '@backstage/theme';
import { ThemeProvider } from '@material-ui/core/styles';
import { CssBaseline } from '@material-ui/core';
import { mctlTheme } from './theme/mctlTheme';

const THEME_STORAGE_KEY = 'theme';
const DEFAULT_THEME_ID = 'mctl-theme';

// Backstage 1.50 introduced @backstage/ui (CSS-vars design system) for
// catalog/notifications components. Its tokens key off
// [data-theme-mode] on a parent. Without it, every BUI component falls
// back to :root (light) tokens — entity cards render white over our
// dark mctl chrome. Keep the attribute in sync with the active theme.
const setBuiThemeMode = (mode: 'dark' | 'light') => {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.themeMode = mode;
  }
};

if (typeof window !== 'undefined' && window.localStorage) {
  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (!savedTheme) {
    window.localStorage.setItem(THEME_STORAGE_KEY, DEFAULT_THEME_ID);
  }
}

const catalogMessages = createTranslationMessages({
  ref: catalogTranslationRef,
  full: false,
  messages: {
    'indexPage.createButtonTitle': 'Run Action',
  },
});

const coreComponentsMessages = createTranslationMessages({
  ref: coreComponentsTranslationRef,
  full: false,
  messages: {
    'oauthRequestDialog.title': 'Sign In',
    'oauthRequestDialog.message':
      'Continue with {{provider}} to access the platform.',
    'oauthRequestDialog.login': 'Sign In',
    'oauthRequestDialog.rejectAll': 'Cancel',
  },
});
import {
  SecureVariablesInputFieldExtension,
  NetworkPreviewFieldExtension,
  GitHubRepoPickerFieldExtension,
  CurrentConfigFieldExtension,
  GitTagPickerFieldExtension,
  ServicePickerFieldExtension,
  ReleaseReviewStep,
  ReleaseOutputs,
  EnvVarsEditorFieldExtension,
  SecureVarsEditorFieldExtension,
  TenantNameFieldExtension,
  TeamPickerFieldExtension,
  AdminFilteredScaffolderPage,
} from './components/scaffolder';

const backstageDefaultDark = createBackstageTheme({
  palette: backstageDarkTheme.palette,
  defaultPageTheme: 'home',
});

const backstageDefaultLight = createBackstageTheme({
  palette: backstageLightTheme.palette,
  defaultPageTheme: 'home',
});

const app = createApp({
  apis,
  __experimentalTranslations: {
    resources: [catalogMessages, coreComponentsMessages],
  },
  themes: [
    {
      id: 'mctl-theme',
      title: 'MCTL Theme',
      variant: 'dark',
      Provider: ({ children }) => {
        setBuiThemeMode('dark');
        return (
          <ThemeProvider theme={mctlTheme}>
            <CssBaseline />
            {children}
          </ThemeProvider>
        );
      },
    },
    {
      id: 'backstage-dark',
      title: 'Backstage Dark',
      variant: 'dark',
      Provider: ({ children }) => {
        setBuiThemeMode('dark');
        return (
          <ThemeProvider theme={backstageDefaultDark}>
            <CssBaseline />
            {children}
          </ThemeProvider>
        );
      },
    },
    {
      id: 'backstage-light',
      title: 'Backstage Light',
      variant: 'light',
      Provider: ({ children }) => {
        setBuiThemeMode('light');
        return (
          <ThemeProvider theme={backstageDefaultLight}>
            <CssBaseline />
            {children}
          </ThemeProvider>
        );
      },
    },
  ],
  bindRoutes({ bind }) {
    bind(catalogPlugin.externalRoutes, {
      createComponent: scaffolderPlugin.routes.root,
      viewTechDoc: techdocsPlugin.routes.docRoot,
      createFromTemplate: scaffolderPlugin.routes.selectedTemplate,
    });
    bind(scaffolderPlugin.externalRoutes, {
      viewTechDoc: techdocsPlugin.routes.docRoot,
    });
    bind(orgPlugin.externalRoutes, {
      catalogIndex: catalogPlugin.routes.catalogIndex,
    });
  },
  components: {
    SignInPage: props => (
      <SignInPage
        {...props}
        auto
        provider={{
          id: 'github-auth-provider',
          title: 'GitHub',
          message: 'Sign in using GitHub',
          apiRef: githubAuthApiRef,
        }}
      />
    ),
  },
});

const routes = (
  <FlatRoutes>
    <Route path="/" element={<Navigate to="catalog" />} />
    <Route path="/catalog" element={<CatalogIndexPage initiallySelectedFilter="owned" />} />
    <Route
      path="/catalog/:namespace/:kind/:name"
      element={<CatalogEntityPage />}
    >
      {entityPage}
    </Route>
    <Route path="/docs" element={<TechDocsIndexPage />} />
    <Route
      path="/docs/:namespace/:kind/:name/*"
      element={<TechDocsReaderPage />}
    >
      <TechDocsAddons>
        <ReportIssue />
      </TechDocsAddons>
    </Route>
    <Route
      path="/create"
      element={
        <AdminFilteredScaffolderPage
          headerOptions={{
            pageTitleOverride: 'Platform',
            title: 'Platform',
            subtitle: 'Deploy, manage, and operate your services',
          }}
          components={{
            ReviewStepComponent: ReleaseReviewStep,
            EXPERIMENTAL_TemplateOutputsComponent: ReleaseOutputs,
          }}
          contextMenu={{ editor: true, actions: true, tasks: true }}
        />
      }
    >
      <ScaffolderFieldExtensions>
        <EntityPickerFieldExtension />
        <EntityNamePickerFieldExtension />
        <EntityTagsPickerFieldExtension />
        <OwnedEntityPickerFieldExtension />
        <OwnerPickerFieldExtension />
        <RepoUrlPickerFieldExtension />
        <MyGroupsPickerFieldExtension />
        <SecureVariablesInputFieldExtension />
        <NetworkPreviewFieldExtension />
        <GitHubRepoPickerFieldExtension />
        <CurrentConfigFieldExtension />
        <GitTagPickerFieldExtension />
        <ServicePickerFieldExtension />
        <EnvVarsEditorFieldExtension />
        <SecureVarsEditorFieldExtension />
        <TenantNameFieldExtension />
        <TeamPickerFieldExtension />
      </ScaffolderFieldExtensions>
    </Route>
    <Route path="/search" element={<SearchPage />}>
      {searchPage}
    </Route>
    <Route path="/settings" element={<UserSettingsPage />} />
    <Route path="/catalog-graph" element={<CatalogGraphPage />} />
    <Route path="/notifications" element={<NotificationsPage />} />
    <Route path="/no-tenant" element={<NoTenantPage />} />
  </FlatRoutes>
);

export default app.createRoot(
  <>
    <AlertDisplay />
    <OAuthRequestDialog />
    <SignalsDisplay />
    <AppRouter>
      <Root>{routes}</Root>
    </AppRouter>
  </>,
);
