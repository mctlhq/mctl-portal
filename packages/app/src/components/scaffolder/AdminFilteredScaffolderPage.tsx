import { ScaffolderPage, scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { attachComponentData } from '@backstage/core-plugin-api';
import { useIsAdmin } from '../../hooks/useIsAdmin';
import { Entity } from '@backstage/catalog-model';
import { ComponentProps, useCallback } from 'react';

type ScaffolderPageProps = ComponentProps<typeof ScaffolderPage>;

/**
 * Wraps ScaffolderPage to hide templates annotated with
 * `mctl.me/admin-only: "true"` from non-admin users.
 */
export const AdminFilteredScaffolderPage = (props: ScaffolderPageProps) => {
  const isAdmin = useIsAdmin();

  const templateFilter = useCallback(
    (entity: Entity) => {
      const adminOnly =
        entity.metadata.annotations?.['mctl.me/admin-only'] === 'true';
      if (adminOnly && !isAdmin) return false;
      return true;
    },
    [isAdmin],
  );

  return <ScaffolderPage {...props} templateFilter={templateFilter} />;
};

// Register route ref + plugin so Backstage discovers the scaffolder mount point and its APIs
attachComponentData(
  AdminFilteredScaffolderPage,
  'core.mountPoint',
  scaffolderPlugin.routes.root,
);
attachComponentData(
  AdminFilteredScaffolderPage,
  'core.plugin',
  scaffolderPlugin,
);
