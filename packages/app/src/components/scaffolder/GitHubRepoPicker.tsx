import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { useApi, discoveryApiRef, identityApiRef } from '@backstage/core-plugin-api';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import Box from '@material-ui/core/Box';
import Link from '@material-ui/core/Link';
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
  grantLink: {
    display: 'block',
    marginTop: theme.spacing(0.5),
    fontSize: '0.85rem',
    fontWeight: 600,
    color: theme.palette.primary.main,
  },
}));

const GITHUB_APP_INSTALL_BASE =
  'https://github.com/apps/mctl-app/installations/new';
const POLL_INTERVAL = 3000;

const GitHubRepoPickerComponent = (
  props: FieldExtensionComponentProps<string>,
) => {
  const { onChange, rawErrors, required, formData, schema, formContext } = props;
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const identityApi = useApi(identityApiRef);

  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reposRef = useRef<string[]>([]);
  const githubLoginRef = useRef<string | undefined>(undefined);

  // Read teamName from sibling field (onboard template step 1)
  // Parse entity ref: "group:default/mctl-internals" → "mctl-internals"
  const rawTeamValue = (formContext as any)?.formData?.teamName as string | undefined;
  const teamName = rawTeamValue?.includes('/')
    ? rawTeamValue.split('/').pop()
    : rawTeamValue;

  // Resolve GitHub login from identity (user:default/mashkoffdmitry → mashkoffdmitry)
  useEffect(() => {
    identityApi.getBackstageIdentity().then(identity => {
      const ref = identity.userEntityRef; // "user:default/login"
      githubLoginRef.current = ref.includes('/') ? ref.split('/').pop() : ref;
    }).catch(() => {});
  }, [identityApi]);

  const fetchRepos = useCallback(async (): Promise<string[]> => {
    if (!teamName) return []; // Don't fetch until team is selected
    try {
      const baseUrl = await discoveryApi.getBaseUrl('github-app-connect');
      const url = `${baseUrl}/repos?team=${encodeURIComponent(teamName)}`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = (await resp.json()) as { repos: string[] };
      return data.repos || [];
    } catch {
      return [];
    }
  }, [discoveryApi, teamName]);

  // Sync repos after popup closes — discovers user's installation and associates with team
  const syncAndFetch = useCallback(async (): Promise<string[]> => {
    if (!teamName) return [];
    const login = githubLoginRef.current;
    if (!login) return fetchRepos();
    try {
      const baseUrl = await discoveryApi.getBaseUrl('github-app-connect');
      const resp = await fetch(
        `${baseUrl}/repos/sync?team=${encodeURIComponent(teamName)}&user=${encodeURIComponent(login)}`,
        { method: 'POST' },
      );
      if (!resp.ok) return fetchRepos();
      const data = (await resp.json()) as { repos: string[] };
      return data.repos || [];
    } catch {
      return fetchRepos();
    }
  }, [discoveryApi, teamName, fetchRepos]);

  // Keep reposRef in sync for use inside event listeners
  useEffect(() => {
    reposRef.current = repos;
  }, [repos]);

  // Initial load + re-fetch whenever teamName changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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

  // Listen for postMessage and BroadcastChannel from popup-done page.
  // BroadcastChannel is needed when window.opener is lost after GitHub's redirect chain.
  useEffect(() => {
    const handleUpdate = async () => {
      setWaiting(false);
      popupRef.current = null;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // Sync installations for team, then auto-select if one new repo
      const freshRepos = await syncAndFetch();
      const prev = reposRef.current;
      const newRepos = freshRepos.filter(r => !prev.includes(r));
      setRepos(freshRepos);
      if (newRepos.length === 1) {
        onChange(newRepos[0]);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'github-repos-updated') handleUpdate();
    };
    window.addEventListener('message', handleMessage);

    // BroadcastChannel: survives opener loss during GitHub redirect
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('mctl-github-repos');
      bc.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'github-repos-updated') handleUpdate();
      };
    } catch {
      // BroadcastChannel not supported (rare)
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      bc?.close();
    };
  }, [syncAndFetch, onChange]);

  // Fallback polling (in case postMessage doesn't arrive — e.g. user manually closed popup)
  const startFallbackPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(async () => {
      if (popupRef.current && popupRef.current.closed) {
        clearInterval(pollTimerRef.current!);
        pollTimerRef.current = null;
        setWaiting(false);
        const freshRepos = await syncAndFetch();
        const prev = reposRef.current;
        const newRepos = freshRepos.filter(r => !prev.includes(r));
        setRepos(freshRepos);
        if (newRepos.length === 1) onChange(newRepos[0]);
      }
    }, POLL_INTERVAL);
  }, [syncAndFetch, onChange]);

  const handleGrantAccessClick = useCallback(() => {
    const state = teamName ? `popup:${teamName}` : 'popup';
    const installUrl = `${GITHUB_APP_INSTALL_BASE}?state=${encodeURIComponent(state)}`;
    const popup = window.open(
      installUrl,
      'github-app-install',
      'width=1000,height=700',
    );
    popupRef.current = popup;
    setWaiting(true);
    startFallbackPolling();
  }, [startFallbackPolling, teamName]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

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
                  {loading || waiting ? (
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
            No repositories found. Grant access to your repos via the GitHub App.
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="primary"
            className={classes.installButton}
            onClick={handleGrantAccessClick}
            disabled={waiting}
          >
            {waiting ? 'Waiting…' : 'Grant access'}
          </Button>
        </Box>
      )}
      {!loading && repos.length > 0 && (
        <Link
          component="button"
          className={classes.grantLink}
          onClick={handleGrantAccessClick}
          underline="hover"
        >
          {waiting ? 'Waiting for new repos…' : 'Repository not in the list? Grant access →'}
        </Link>
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
