import React, { useCallback } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import Chip from '@material-ui/core/Chip';
import LanguageIcon from '@material-ui/icons/Language';
import CloudOffIcon from '@material-ui/icons/CloudOff';
import { makeStyles } from '@material-ui/core/styles';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const useStyles = makeStyles(theme => ({
  preview: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.background.default,
  },
  urlText: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.875rem',
    fontWeight: 500,
  },
  workerText: {
    fontSize: '0.8rem',
    color: theme.palette.text.secondary,
  },
}));

const NetworkPreviewFieldComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, schema } = props;
  const classes = useStyles();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value || undefined);
    },
    [onChange],
  );

  const hasHost = formData && formData.trim().length > 0;

  return (
    <>
      <TextField
        label={schema.title || 'Ingress Host'}
        fullWidth
        variant="outlined"
        value={formData || ''}
        onChange={handleChange}
        required={required}
        error={rawErrors && rawErrors.length > 0}
        helperText={
          schema.description ||
          'Public hostname (e.g. myteam-myapp.mctl.me). Leave empty for a background worker.'
        }
        placeholder="myteam-myapp.mctl.me"
      />
      <div className={classes.preview}>
        {hasHost ? (
          <>
            <LanguageIcon fontSize="small" color="primary" />
            <Typography className={classes.urlText} color="primary">
              https://{formData}
            </Typography>
            <Chip label="Web Service" size="small" color="primary" variant="outlined" />
          </>
        ) : (
          <>
            <CloudOffIcon fontSize="small" color="disabled" />
            <Typography className={classes.workerText}>
              No public endpoint — will be deployed as a background worker
            </Typography>
          </>
        )}
      </div>
    </>
  );
};

export const NetworkPreviewFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'NetworkPreview',
    component: NetworkPreviewFieldComponent,
  }),
);
