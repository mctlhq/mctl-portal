import React, { useCallback, useEffect, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import CircularProgress from '@material-ui/core/CircularProgress';
import InputAdornment from '@material-ui/core/InputAdornment';
import CheckCircleOutlineIcon from '@material-ui/icons/CheckCircleOutline';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef } from '@backstage/core-plugin-api';

const TENANT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const TenantNameFieldComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, schema, formData } = props;
  const discoveryApi = useApi(discoveryApiRef);
  const [checking, setChecking] = useState(false);
  const [exists, setExists] = useState(false);
  const [checked, setChecked] = useState(false);
  const value = formData ?? '';

  // Debounced availability check
  useEffect(() => {
    if (!value || !TENANT_NAME_RE.test(value)) {
      setExists(false);
      setChecked(false);
      return;
    }

    setChecking(true);
    setChecked(false);
    const timer = setTimeout(async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
        const resp = await fetch(`${baseUrl}/tenants/${encodeURIComponent(value)}`);
        setExists(resp.ok); // 200 = exists, 404 = available
      } catch {
        setExists(false);
      } finally {
        setChecking(false);
        setChecked(true);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      setChecking(false);
    };
  }, [value, discoveryApi]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      onChange(raw);
    },
    [onChange],
  );

  const formatError = value && !TENANT_NAME_RE.test(value)
    ? 'Must start with a letter/digit, only lowercase a-z, 0-9, hyphens, 2-63 chars'
    : exists
      ? `Tenant "${value}" already exists`
      : undefined;

  let endAdornment: React.ReactNode = null;
  if (checking) {
    endAdornment = (
      <InputAdornment position="end">
        <CircularProgress size={18} />
      </InputAdornment>
    );
  } else if (checked && !exists && TENANT_NAME_RE.test(value)) {
    endAdornment = (
      <InputAdornment position="end">
        <CheckCircleOutlineIcon style={{ color: '#4caf50' }} />
      </InputAdornment>
    );
  }

  return (
    <TextField
      label={schema.title ?? 'Tenant Name'}
      helperText={formatError ?? schema.description}
      required={required}
      value={value}
      onChange={handleChange}
      error={!!formatError || (rawErrors?.length ?? 0) > 0}
      fullWidth
      autoFocus
      variant="outlined"
      InputProps={{ endAdornment }}
      inputProps={{ spellCheck: false, autoComplete: 'off' }}
    />
  );
};

export const TenantNameFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'TenantNameField',
    component: TenantNameFieldComponent,
  }),
);
