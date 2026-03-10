import { useEffect, useState } from 'react';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import CircularProgress from '@material-ui/core/CircularProgress';
import { makeStyles } from '@material-ui/core/styles';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import type { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

// Module-level cache: avoids re-fetching every time the form mounts or steps change
const configCache = new Map<string, { data: ServiceConfig; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255,255,255,0.05)'
      : 'rgba(0,0,0,0.03)',
    border: `1px solid ${theme.palette.divider}`,
  },
  section: {
    marginBottom: theme.spacing(1.5),
    '&:last-child': { marginBottom: 0 },
  },
  label: {
    fontWeight: 600,
    fontSize: '0.8rem',
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  mono: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.85rem',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  chip: {
    margin: theme.spacing(0.25),
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.8rem',
  },
  empty: {
    color: theme.palette.text.disabled,
    fontStyle: 'italic',
    fontSize: '0.85rem',
  },
}));

interface ServiceConfig {
  envVars: string;
  secretKeys: string[];
  secrets: Record<string, string>;
}

function CurrentConfigFieldComponent(
  props: FieldExtensionComponentProps<string>,
) {
  const { formContext, onChange } = props;
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formData = (formContext as any)?.formData ?? {};
  const serviceName = formData.serviceName as string | undefined;

  useEffect(() => {
    if (!serviceName) {
      setConfig(null);
      return;
    }

    // Parse entity ref: component:default/kuptsi → kuptsi
    const name = serviceName.replace(/^component:default\//, '').replace(/^[^/]+\//, '');

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('github-app-connect');

        // First fetch the entity to get the team label
        const catalogBase = await discoveryApi.getBaseUrl('catalog');
        const entityRef = serviceName.startsWith('component:')
          ? serviceName
          : `component:default/${serviceName}`;
        const entityResp = await fetchApi.fetch(
          `${catalogBase}/entities/by-name/${entityRef.replace(':', '/')}`,
        );

        let team = '';
        if (entityResp.ok) {
          const entity = await entityResp.json();
          team = entity?.metadata?.labels?.team
            || (entity?.spec?.owner || '').replace('group:', '');
        }

        if (!team) {
          setError('Could not determine team from entity');
          setLoading(false);
          return;
        }

        const cacheKey = `${team}/${name}`;
        const cached = configCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          if (!cancelled) {
            setConfig(cached.data);
            onChange(JSON.stringify(cached.data));
            setLoading(false);
          }
          return;
        }

        const resp = await fetchApi.fetch(
          `${baseUrl}/service-config?team=${encodeURIComponent(team)}&service=${encodeURIComponent(name)}`,
        );

        let envVars = '';
        let secretKeys: string[] = [];
        if (!cancelled && resp.ok) {
          const data = await resp.json();
          envVars = data.envVars || '';
          secretKeys = data.secretKeys || [];
        }

        // Fetch actual secret values from Vault
        let secrets: Record<string, string> = {};
        try {
          const vaultBase = await discoveryApi.getBaseUrl('vault-secrets');
          const vaultResp = await fetchApi.fetch(
            `${vaultBase}/teams/${encodeURIComponent(team)}/${encodeURIComponent(name)}/secrets`,
          );
          if (vaultResp.ok) {
            const vaultData = await vaultResp.json();
            secrets = (vaultData as any).secrets || {};
          }
        } catch {
          // Vault fetch failed — continue without secrets
        }

        if (!cancelled) {
          const combined: ServiceConfig = { envVars, secretKeys, secrets };
          configCache.set(`${team}/${name}`, { data: combined, fetchedAt: Date.now() });
          setConfig(combined);
          onChange(JSON.stringify(combined));
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [serviceName, discoveryApi, fetchApi, onChange]);

  if (!serviceName) return null;

  if (loading) {
    return (
      <Box display="flex" alignItems="center" py={1} style={{ gap: 8 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="textSecondary">
          Loading current configuration…
        </Typography>
      </Box>
    );
  }

  if (error) return null;
  if (!config) return null;

  const envLines = config.envVars ? config.envVars.split('\n').filter(Boolean) : [];

  return (
    <Box className={classes.root}>
      <Typography variant="subtitle2" gutterBottom style={{ fontWeight: 600 }}>
        Current Configuration
      </Typography>

      <div className={classes.section}>
        <Typography className={classes.label}>Environment Variables</Typography>
        {envLines.length > 0 ? (
          <Typography className={classes.mono}>
            {envLines.join('\n')}
          </Typography>
        ) : (
          <Typography className={classes.empty}>None configured</Typography>
        )}
      </div>

      <div className={classes.section}>
        <Typography className={classes.label}>Secure Variables (in Vault)</Typography>
        {Object.keys(config.secrets).length > 0 ? (
          <Box display="flex" flexWrap="wrap">
            {Object.keys(config.secrets).map(key => (
              <Chip
                key={key}
                label={`${key}=****`}
                size="small"
                variant="outlined"
                className={classes.chip}
              />
            ))}
          </Box>
        ) : config.secretKeys.length > 0 ? (
          <Box display="flex" flexWrap="wrap">
            {config.secretKeys.map(key => (
              <Chip
                key={key}
                label={`${key}=****`}
                size="small"
                variant="outlined"
                className={classes.chip}
              />
            ))}
          </Box>
        ) : (
          <Typography className={classes.empty}>None configured</Typography>
        )}
      </div>

      <Typography variant="caption" color="textSecondary">
        Add new variables below or override existing ones. Omitted variables remain unchanged.
      </Typography>
    </Box>
  );
}

export const CurrentConfigFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    name: 'CurrentConfig',
    component: CurrentConfigFieldComponent,
  }),
);
