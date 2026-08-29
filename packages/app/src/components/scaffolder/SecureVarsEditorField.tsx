import React, { useCallback, useState } from 'react';
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

  const currentConfig = (formContext as any)?.formData?.currentConfig;

  // Existing secret values are never fetched into this form — /secrets now
  // returns only key names (see CurrentConfigField.tsx). Show those names as
  // a read-only hint so the user knows what's already set, without
  // pre-filling the editable field with plaintext (or anything at all).
  let existingSecretKeys: string[] = [];
  try {
    existingSecretKeys = currentConfig ? JSON.parse(currentConfig).secretKeys || [] : [];
  } catch {
    // Invalid JSON — no hint to show
  }

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
      {/*
        The "leave blank to keep them unchanged" promise below is enforced by
        the deploy pipeline in mctlhq/mctl-gitops (pinned at 48d200b), not by
        this component:

        - platform-gitops/argo-workflows/cluster-templates/wft-deploy-service.yaml:157
          gates the whole `write-secrets` step behind
          `when: secret_env_vars != "" || telegram_bot_token != ""`, so an empty
          submission never reaches Vault at all — it is a genuine no-op.
        - platform-gitops/argo-workflows/cluster-templates/tpl-vault-write.yaml:74-95
          GETs the existing KV v2 payload and merges it with the submitted keys
          (`e.update(n)`), so a non-empty submission only adds or overwrites the
          keys it names; omitted keys survive.
        - wft-deploy-service.yaml:58 exposes a separate explicit `clear_secrets`
          flag — wiping secrets is an opt-in parameter, never a side effect of
          leaving this field blank.

        If those workflow templates ever change, this copy must change with them.
      */}
      {existingSecretKeys.length > 0 && (
        <Typography variant="caption" color="textSecondary" component="div">
          Existing keys (values hidden): {existingSecretKeys.join(', ')}. Leave
          blank to keep them unchanged; add a KEY=value line only for a key
          you want to set or change.
        </Typography>
      )}
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
