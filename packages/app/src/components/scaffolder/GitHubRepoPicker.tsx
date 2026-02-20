import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef } from '@backstage/core-plugin-api';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import CircularProgress from '@material-ui/core/CircularProgress';
import Autocomplete from '@material-ui/lab/Autocomplete';
import WarningIcon from '@material-ui/icons/Warning';
import { makeStyles } from '@material-ui/core/styles';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const useStyles = makeStyles(theme => ({
  installBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.borderRadius,
    backgroundColor:
      theme.palette.type === 'dark'
        ? 'rgba(255,152,0,0.1)'
        : 'rgba(255,152,0,0.08)',
    border: `1px solid ${theme.palette.warning.light}`,
  },
  warningIcon: {
    color: theme.palette.warning.main,
    fontSize: '1.2rem',
  },
  installButton: {
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
  },
}));

const POLL_INTERVAL = 3000;

const GitHubRepoPickerComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, schema } = props;
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);

  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRepos = useCallback(async (): Promise<string[]> => {
    try {
      const baseUrl = await discoveryApi.getBaseUrl('github-app-connect');
      const resp = await fetch(`${baseUrl}/repos`);
      if (!resp.ok) return [];
      const data = (await resp.json()) as { repos: string[] };
      return data.repos || [];
    } catch {
      return [];
    }
  }, [discoveryApi]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    fetchRepos().then(r => {
      if (!cancelled) {
        setRepos(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchRepos]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    setPolling(true);

    pollTimerRef.current = setInterval(async () => {
      // Stop if popup is closed
      if (popupRef.current && popupRef.current.closed) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setPolling(false);
        popupRef.current = null;
        return;
      }

      const freshRepos = await fetchRepos();
      if (freshRepos.length > repos.length) {
        setRepos(freshRepos);
        // Stop polling once we see new repos
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setPolling(false);
      }
    }, POLL_INTERVAL);
  }, [fetchRepos, repos.length]);

  const handleInstallClick = useCallback(() => {
    const popup = window.open(
      'https://github.com/apps/mctl-me/installations/select_target',
      'github-app-install',
      'width=1000,height=700',
    );
    popupRef.current = popup;
    startPolling();
  }, [startPolling]);

  const handleChange = useCallback(
    (_event: React.ChangeEvent<{}>, value: string | null) => {
      onChange(value || undefined);
    },
    [onChange],
  );

  const handleInputChange = useCallback(
    (_event: React.ChangeEvent<{}>, value: string) => {
      onChange(value || undefined);
    },
    [onChange],
  );

  return (
    <>
      <Autocomplete
        freeSolo
        options={repos}
        value={formData || ''}
        onChange={handleChange}
        onInputChange={handleInputChange}
        loading={loading}
        renderInput={params => (
          <TextField
            {...params}
            label={schema.title || 'GitHub Repository'}
            required={required}
            error={rawErrors && rawErrors.length > 0}
            helperText={
              schema.description || 'Select a repository or type owner/repo'
            }
            variant="outlined"
            placeholder="owner/repository"
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {loading || polling ? (
                    <CircularProgress size={18} />
                  ) : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />
      {!loading && repos.length === 0 && (
        <Box className={classes.installBanner}>
          <WarningIcon className={classes.warningIcon} />
          <Typography variant="body2">
            No repositories found via GitHub App. Install the app or type a repo
            manually.
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="primary"
            className={classes.installButton}
            onClick={handleInstallClick}
            disabled={polling}
          >
            {polling ? 'Waiting...' : 'Install GitHub App'}
          </Button>
        </Box>
      )}
    </>
  );
};

export const GitHubRepoPickerFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'GitHubRepoPicker',
    component: GitHubRepoPickerComponent,
  }),
);
