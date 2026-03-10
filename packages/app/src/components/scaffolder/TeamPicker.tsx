import { useEffect } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import TextField from '@material-ui/core/TextField';
import CircularProgress from '@material-ui/core/CircularProgress';
import useAsync from 'react-use/esm/useAsync';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

/**
 * Custom TeamPicker that queries the tenant-backend API directly.
 * Unlike MyGroupsPicker (which depends on catalog sync), this reads
 * from the tenant DB and works immediately after tenant creation.
 *
 * Returns entity ref format: "group:default/{tenantName}" — compatible
 * with existing template expressions like `parseEntityRef | pick('name')`.
 */
const TeamPickerComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, schema } = props;
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const { value: team, loading } = useAsync(async () => {
    const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
    const resp = await fetchApi.fetch(`${baseUrl}/me/tenant`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      tenant: { name: string; displayName: string } | null;
      role?: string;
    };
    return data.tenant;
  }, [discoveryApi, fetchApi]);

  const entityRef = team ? `group:default/${team.name}` : '';

  // Auto-select when team loads
  useEffect(() => {
    if (entityRef && entityRef !== formData) {
      onChange(entityRef);
    }
  }, [entityRef, formData, onChange]);

  return (
    <TextField
      label={schema.title || 'Team'}
      required={required}
      error={rawErrors && rawErrors.length > 0}
      helperText={schema.description || 'Your team'}
      variant="outlined"
      margin="dense"
      fullWidth
      value={team?.displayName ?? (loading ? 'Loading…' : 'No team found')}
      disabled
      InputProps={{
        endAdornment: loading ? <CircularProgress size={18} /> : undefined,
      }}
    />
  );
};

export const TeamPickerFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'TeamPicker',
    component: TeamPickerComponent,
  }),
);
