import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import IconButton from '@material-ui/core/IconButton';
import InputAdornment from '@material-ui/core/InputAdornment';
import VisibilityIcon from '@material-ui/icons/Visibility';
import VisibilityOffIcon from '@material-ui/icons/VisibilityOff';
import LockIcon from '@material-ui/icons/Lock';
import { makeStyles } from '@material-ui/core/styles';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const useStyles = makeStyles(theme => ({
  hint: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(0.5),
    color: theme.palette.text.secondary,
    fontSize: '0.75rem',
  },
  lockIcon: {
    fontSize: '0.875rem',
  },
  errorText: {
    color: theme.palette.error.main,
    fontSize: '0.75rem',
    marginTop: theme.spacing(0.5),
  },
}));

function maskValues(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        return `${line.substring(0, eqIndex)}=****`;
      }
      return line;
    })
    .join('\n');
}

function validateLines(text: string): string[] {
  if (!text) return [];
  const errors: string[] = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.includes('=')) {
      errors.push(`Line ${i + 1}: missing '=' separator`);
    } else {
      const key = trimmed.substring(0, trimmed.indexOf('='));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        errors.push(`Line ${i + 1}: invalid key "${key}"`);
      }
    }
  });
  return errors;
}

const SecureVarsEditorFieldComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, formContext, schema } = props;
  const classes = useStyles();
  const [masked, setMasked] = useState(false);
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const autoFilled = useRef(false);

  const currentConfig = (formContext as any)?.formData?.currentConfig;

  useEffect(() => {
    if (autoFilled.current || formData) return;
    if (!currentConfig) return;

    try {
      const config = JSON.parse(currentConfig);
      const secrets: Record<string, string> = config.secrets || {};
      const keys = Object.keys(secrets);
      if (keys.length > 0) {
        const lines = keys.map(k => `${k}=${secrets[k]}`).join('\n');
        onChange(lines);
        autoFilled.current = true;
        setMasked(true);
      }
    } catch {
      // Invalid JSON — skip
    }
  }, [currentConfig, formData, onChange]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      onChange(value);
      setLocalErrors(validateLines(value));
    },
    [onChange],
  );

  const handleBlur = useCallback(() => {
    if (formData) {
      setMasked(true);
      setLocalErrors(validateLines(formData));
    }
  }, [formData]);

  const displayValue = masked && formData ? maskValues(formData) : formData || '';
  const allErrors = [...(rawErrors || []), ...localErrors];

  return (
    <>
      <TextField
        label={schema.title || 'Secure Variables'}
        multiline
        minRows={5}
        maxRows={20}
        fullWidth
        variant="outlined"
        value={displayValue}
        onChange={handleChange}
        onFocus={() => setMasked(false)}
        onBlur={handleBlur}
        required={required}
        error={allErrors.length > 0}
        helperText={schema.description}
        placeholder={
          'API_KEY=your-api-key-here\nDATABASE_PASSWORD=your-db-password\nSECRET_TOKEN=your-secret-token'
        }
        InputProps={{
          endAdornment: formData ? (
            <InputAdornment position="end">
              <IconButton
                size="small"
                onClick={() => setMasked(!masked)}
                edge="end"
                title={masked ? 'Show values' : 'Mask values'}
              >
                {masked ? <VisibilityIcon /> : <VisibilityOffIcon />}
              </IconButton>
            </InputAdornment>
          ) : undefined,
        }}
      />
      <div className={classes.hint}>
        <LockIcon className={classes.lockIcon} />
        <Typography variant="caption">
          Stored securely in Vault. Never committed to Git.
        </Typography>
      </div>
      {allErrors.map((err, i) => (
        <Typography key={i} className={classes.errorText}>
          {err}
        </Typography>
      ))}
    </>
  );
};

export const SecureVarsEditorFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'SecureVarsEditor',
    component: SecureVarsEditorFieldComponent,
  }),
);
