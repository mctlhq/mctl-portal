import { useEffect, useState, useCallback } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import CircularProgress from '@material-ui/core/CircularProgress';
import Autocomplete from '@material-ui/lab/Autocomplete';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const ServicePickerComponent = (props: FieldExtensionComponentProps<string>) => {
  const { onChange, formData } = props;
  const catalogApi = useApi(catalogApiRef);

  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Pre-fill from URL query param ?serviceName=component:default/my-service
  const urlParam = new URLSearchParams(window.location.search).get('serviceName');

  const fetchEntities = useCallback(async () => {
    setLoading(true);
    try {
      const result = await catalogApi.getEntities({
        filter: { kind: 'Component' },
        fields: ['metadata.name', 'metadata.namespace'],
      });
      const refs = result.items.map(
        e => `component:${e.metadata.namespace || 'default'}/${e.metadata.name}`,
      );
      refs.sort();
      setOptions(refs);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [catalogApi]);

  useEffect(() => {
    fetchEntities();
  }, [fetchEntities]);

  // Pre-fill from URL param once on mount (only if form field is empty)
  useEffect(() => {
    if (!initialized && urlParam && !formData) {
      onChange(urlParam);
      setInitialized(true);
    }
  }, [initialized, urlParam, formData, onChange]);

  return (
    <Autocomplete
      options={options}
      value={formData || null}
      loading={loading}
      onChange={(_e, newValue) => onChange(newValue || '')}
      renderInput={params => (
        <TextField
          {...params}
          label="Service"
          variant="outlined"
          placeholder="Select a service"
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading && <CircularProgress color="inherit" size={20} />}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
};

export const ServicePickerFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'ServicePicker',
    component: ServicePickerComponent,
  }),
);
