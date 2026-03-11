import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  CircularProgress,
  Container,
  TextField,
  Typography,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { useApi, identityApiRef, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { usePlatformConfig } from '../../platformConfig';
import { Page, Header, Content } from '@backstage/core-components';

// ─── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles(theme => ({
  root: {
    marginTop: theme.spacing(8),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  icon: {
    fontSize: 64,
    marginBottom: theme.spacing(2),
  },
  subtitle: {
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(4),
    maxWidth: 480,
  },
  form: {
    width: '100%',
    maxWidth: 400,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
  },
  hint: {
    fontSize: '0.75rem',
    color: theme.palette.text.secondary,
    marginTop: -theme.spacing(1),
  },
  error: {
    color: theme.palette.error.main,
    fontSize: '0.875rem',
    marginTop: theme.spacing(1),
  },
}));

// ─── Component ────────────────────────────────────────────────────────────────

export const NoTenantPage = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const identityApi = useApi(identityApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const { githubOrg } = usePlatformConfig();

  const [tenantName, setTenantName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>();

  // Load current user identity
  useEffect(() => {
    identityApi.getBackstageIdentity().then(identity => {
      const username = identity.userEntityRef.split('/').pop();
      setCurrentUserId(username);
    }).catch(() => {});
  }, [identityApi]);

  const handleCreate = async () => {
    const name = tenantName.trim().toLowerCase();
    if (!name || !currentUserId) return;
    setSubmitting(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('tenant-management');
      const resp = await fetch(`${baseUrl}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          githubOrg,
          creatorUserId: currentUserId,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      // Tenant created — redirect to catalog to see the new Resource entity
      navigate('/catalog');
    } catch (err: any) {
      setError(err.message ?? 'Failed to create tenant');
    } finally {
      setSubmitting(false);
    }
  };

  const isValidName = /^[a-z0-9-]{2,40}$/.test(tenantName.trim().toLowerCase());

  return (
    <Page themeId="home">
      <Header title="Welcome to MCTL" subtitle="You're not part of any tenant yet" />
      <Content>
        <Container maxWidth="sm">
          <Box className={classes.root}>
            <Typography variant="h4" gutterBottom>
              🚀 Create Your Workspace
            </Typography>
            <Typography variant="body1" className={classes.subtitle}>
              A workspace (tenant) is an isolated environment for your team — with its own
              services, deployments, and secrets. Create one now to get started.
            </Typography>

            <Box className={classes.form}>
              <TextField
                label="Workspace name"
                variant="outlined"
                size="small"
                placeholder="e.g. payments, infra, my-team"
                value={tenantName}
                onChange={e => setTenantName(e.target.value.toLowerCase())}
                onKeyDown={e => { if (e.key === 'Enter' && isValidName) handleCreate(); }}
                disabled={submitting}
                fullWidth
              />
              <Typography className={classes.hint}>
                Lowercase letters, numbers, and hyphens only. 2–40 characters.
                This will be your Kubernetes namespace and Argo CD application name.
              </Typography>

              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={handleCreate}
                disabled={submitting || !isValidName || !currentUserId}
                startIcon={submitting ? <CircularProgress size={18} /> : undefined}
                fullWidth
              >
                {submitting ? 'Creating…' : 'Create Workspace'}
              </Button>

              {error && (
                <Typography className={classes.error}>{error}</Typography>
              )}
            </Box>
          </Box>
        </Container>
      </Content>
    </Page>
  );
};
