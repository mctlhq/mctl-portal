import { useEffect, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import TextField from '@material-ui/core/TextField';
import MenuItem from '@material-ui/core/MenuItem';
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
 *
 * For multi-tenant users (e.g. platform admins who are also product tenant
 * owners) the picker renders a dropdown so they can choose the target tenant.
 * Single-tenant users see a disabled read-only field as before.
 */
const TeamPickerComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, schema } = props;
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const { value: data, loading } = useAsync(async () => {
    const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
    const resp = await fetchApi.fetch(`${baseUrl}/me/tenant`);
    if (!resp.ok) return null;
    return (await resp.json()) as {
      tenant: { name: string; displayName: string } | null;
      role?: string;
      tenants?: Array<{ tenantName: string; role: string }>;
    };
  }, [discoveryApi, fetchApi]);

  const primaryTenant = data?.tenant;
  const allTenants = data?.tenants ?? (primaryTenant ? [{ tenantName: primaryTenant.name, role: data?.role ?? 'owner' }] : []);
  const isMulti = allTenants.length > 1;

  // Selected value: default to primary
  const defaultRef = primaryTenant ? `group:default/${primaryTenant.name}` : '';
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    if (defaultRef && !selected) {
      setSelected(defaultRef);
      if (defaultRef !== formData) onChange(defaultRef);
    }
  }, [defaultRef, selected, formData, onChange]);

  if (isMulti) {
    return (
      <TextField
        select
        label={schema.title || 'Team'}
        required={required}
        error={rawErrors && rawErrors.length > 0}
        helperText={schema.description || 'Select your target team'}
        variant="outlined"
        margin="dense"
        fullWidth
        value={selected}
        onChange={e => {
          setSelected(e.target.value);
          onChange(e.target.value);
        }}
        InputProps={{
          endAdornment: loading ? <CircularProgress size={18} /> : undefined,
        }}
      >
        {allTenants.map(t => (
          <MenuItem key={t.tenantName} value={`group:default/${t.tenantName}`}>
            {t.tenantName} ({t.role})
          </MenuItem>
        ))}
      </TextField>
    );
  }

  return (
    <TextField
      label={schema.title || 'Team'}
      required={required}
      error={rawErrors && rawErrors.length > 0}
      helperText={schema.description || 'Your team'}
      variant="outlined"
      margin="dense"
      fullWidth
      value={primaryTenant?.displayName ?? (loading ? 'Loading…' : 'No team found')}
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
