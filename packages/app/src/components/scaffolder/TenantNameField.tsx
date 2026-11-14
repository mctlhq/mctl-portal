import React, { useCallback, useEffect, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import CircularProgress from '@material-ui/core/CircularProgress';
import InputAdornment from '@material-ui/core/InputAdornment';
import CheckCircleOutlineIcon from '@material-ui/icons/CheckCircleOutline';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';

const TENANT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export type Availability = 'taken' | 'free' | 'unknown';

/**
 * Only 200 (the tenant exists) and 404 (it does not) answer the question.
 * Anything else, a 401 above all, says nothing about the name.
 */
export function availabilityFromStatus(status: number): Availability {
  if (status === 200) return 'taken';
  if (status === 404) return 'free';
  return 'unknown';
}

export const TenantNameFieldComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, schema, formData } = props;
  const discoveryApi = useApi(discoveryApiRef);
  // fetchApi carries the Backstage identity token; a bare fetch is 401.
  const { fetch: authFetch } = useApi(fetchApiRef);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<Availability>();
  const value = formData ?? '';

  // Debounced availability check
  useEffect(() => {
    if (!value || !TENANT_NAME_RE.test(value)) {
      setAvailability(undefined);
      return undefined;
    }

    let cancelled = false;
    setChecking(true);
    setAvailability(undefined);
    const timer = setTimeout(async () => {
      let result: Availability = 'unknown';
      try {
        const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
        const resp = await authFetch(`${baseUrl}/tenants/${encodeURIComponent(value)}`);
        result = availabilityFromStatus(resp.status);
      } catch {
        result = 'unknown';
      }
      if (cancelled) return;
      setAvailability(result);
      setChecking(false);
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setChecking(false);
    };
  }, [value, discoveryApi, authFetch]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      onChange(raw);
    },
    [onChange],
  );

  const formatError = value && !TENANT_NAME_RE.test(value)
    ? 'Must start with a letter/digit, only lowercase a-z, 0-9, hyphens, 2-63 chars'
    : availability === 'taken'
      ? `Tenant "${value}" already exists`
      : undefined;
  const notice =
    availability === 'unknown'
      ? `Could not check whether "${value}" is available`
      : undefined;

  let endAdornment: React.ReactNode = null;
  if (checking) {
    endAdornment = (
      <InputAdornment position="end">
        <CircularProgress size={18} />
      </InputAdornment>
    );
  } else if (availability === 'free' && TENANT_NAME_RE.test(value)) {
    endAdornment = (
      <InputAdornment position="end">
        <CheckCircleOutlineIcon style={{ color: '#4caf50' }} />
      </InputAdornment>
    );
  }

  return (
    <TextField
      label={schema.title ?? 'Tenant Name'}
      helperText={formatError ?? notice ?? schema.description}
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
