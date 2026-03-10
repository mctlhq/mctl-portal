import { useEffect, useState, useCallback } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import TextField from '@material-ui/core/TextField';
import CircularProgress from '@material-ui/core/CircularProgress';
import Chip from '@material-ui/core/Chip';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import Autocomplete from '@material-ui/lab/Autocomplete';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const useStyles = makeStyles(theme => ({
  hint: {
    marginTop: theme.spacing(0.5),
    fontSize: '0.75rem',
    color: theme.palette.text.secondary,
  },
}));

const LATEST_OPTION = '(latest — auto-increment)';

const GitTagPickerComponent = (props: FieldExtensionComponentProps<string>) => {
  const { onChange, formData, formContext } = props;
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [sourceRepo, setSourceRepo] = useState<string>('');
  const [urlPrefilledTag] = useState<string>(
    () => new URLSearchParams(window.location.search).get('gitTag') || '',
  );

  // Source 1: dockerfileRepo from form (onboard template)
  const dockerfileRepo = (formContext as any)?.formData?.dockerfileRepo;
  // Source 2: serviceName entity with annotation (deploy-version template)
  const serviceName = (formContext as any)?.formData?.serviceName;

  // Use dockerfileRepo directly if available, otherwise fetch from entity
  useEffect(() => {
    if (dockerfileRepo) {
      setSourceRepo(dockerfileRepo);
    }
  }, [dockerfileRepo]);

  const fetchEntity = useCallback(async () => {
    if (dockerfileRepo || !serviceName) return;
    try {
      const catalogBase = await discoveryApi.getBaseUrl('catalog');
      const kind = serviceName.includes(':') ? serviceName.split(':')[0] : 'component';
      const name = serviceName.includes('/') 
        ? serviceName.split('/').pop() 
        : serviceName.replace(/^[^:]*:/, '').replace(/^[^/]*\//, '');
      const namespace = serviceName.includes('/') 
        ? serviceName.split('/')[0].replace(/^[^:]*:/, '') 
        : 'default';

      const resp = await fetchApi.fetch(
        `${catalogBase}/entities/by-name/${kind}/${namespace}/${name}`,
      );
      if (!resp.ok) return;
      const entity = await resp.json();
      const repo = entity?.metadata?.annotations?.['github.com/source-repo'];
      if (repo) setSourceRepo(repo);
    } catch {
      // ignore
    }
  }, [serviceName, dockerfileRepo, discoveryApi, fetchApi]);

  const fetchTags = useCallback(async () => {
    if (!sourceRepo) return;
    setLoading(true);
    try {
      const base = await discoveryApi.getBaseUrl('github-app-connect');
      const resp = await fetch(
        `${base}/repo-tags?repo=${encodeURIComponent(sourceRepo)}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        setTags(data.tags || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sourceRepo, discoveryApi]);

  useEffect(() => { fetchEntity(); }, [fetchEntity]);
  useEffect(() => { fetchTags(); }, [fetchTags]);

  // Pre-fill gitTag from URL param once on mount
  useEffect(() => {
    if (urlPrefilledTag && !formData) {
      onChange(urlPrefilledTag);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = [LATEST_OPTION, ...tags];
  const currentValue = formData || '';

  return (
    <Box>
      <Autocomplete
        freeSolo
        options={options}
        value={currentValue || LATEST_OPTION}
        loading={loading}
        onChange={(_e, newValue) => {
          if (!newValue || newValue === LATEST_OPTION) {
            onChange('');
          } else {
            onChange(newValue);
          }
        }}
        onInputChange={(_e, newInput, reason) => {
          if (reason === 'input') {
            if (newInput === LATEST_OPTION) {
              onChange('');
            } else {
              onChange(newInput);
            }
          }
        }}
        renderOption={(option) => {
          if (option === LATEST_OPTION) {
            return (
              <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Chip label="latest" size="small" color="primary" variant="outlined" />
                <Typography variant="body2">Build from HEAD, auto-increment version</Typography>
              </Box>
            );
          }
          return <Typography variant="body2">{option}</Typography>;
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Tag"
            variant="outlined"
            placeholder="Select a tag or type manually"
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
      {sourceRepo && (
        <Typography className={classes.hint}>
          Tags from <strong>{sourceRepo}</strong>
          {tags.length > 0 ? ` · ${tags.length} version(s) found` : ''}
        </Typography>
      )}
      {!sourceRepo && serviceName && (
        <Typography className={classes.hint}>
          No source repo annotation found on this service. Type a tag manually.
        </Typography>
      )}
    </Box>
  );
};

export const GitTagPickerFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'GitTagPicker',
    component: GitTagPickerComponent,
  }),
);
