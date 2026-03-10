import React, { useCallback, useEffect, useRef } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const EnvVarsEditorFieldComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, formContext, schema } = props;
  const autoFilled = useRef(false);

  const currentConfig = (formContext as any)?.formData?.currentConfig;

  useEffect(() => {
    if (autoFilled.current || formData) return;
    if (!currentConfig) return;

    try {
      const config = JSON.parse(currentConfig);
      if (config.envVars) {
        onChange(config.envVars);
        autoFilled.current = true;
      }
    } catch {
      // Invalid JSON — skip
    }
  }, [currentConfig, formData, onChange]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  return (
    <TextField
      label={schema.title || 'Environment Variables'}
      multiline
      minRows={5}
      maxRows={20}
      fullWidth
      variant="outlined"
      value={formData || ''}
      onChange={handleChange}
      required={required}
      error={rawErrors && rawErrors.length > 0}
      helperText={schema.description}
      placeholder={
        'LOG_LEVEL=info\nTIMEOUT_SECONDS=30\nFEATURE_FLAG=true'
      }
    />
  );
};

export const EnvVarsEditorFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'EnvVarsEditor',
    component: EnvVarsEditorFieldComponent,
  }),
);
