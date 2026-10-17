import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Link,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { Content, Header, Page } from '@backstage/core-components';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

interface Access {
  tenant: string;
  account: string;
  role: string;
  observedAt: string;
  status: 'ready' | 'provisioning';
  environments: Array<{ name: string; namespace: string; status: string }>;
  capabilities: Array<{ id: string; label: string; url: string }>;
  mcp: 'available' | 'blocked';
}

export function WorkspaceAccessPage() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [data, setData] = useState<{
    workspaces: Access[];
    legacyMembership: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const base = await discovery.getBaseUrl('tenant-management');
        const response = await fetchApi.fetch(`${base}/me/workspace-access`, {
          signal: AbortSignal.timeout(15_000),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Access unavailable');
        const result = await response.json();
        if (
          !result ||
          !Array.isArray(result.workspaces) ||
          typeof result.legacyMembership !== 'boolean'
        )
          throw new Error('Access unavailable');
        if (active) {
          setData(result);
          setError(false);
        }
      } catch {
        if (active) {
          setData(null);
          setError(true);
        }
      } finally {
        inFlight = false;
      }
    };
    read();
    const timer = setInterval(read, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [discovery, fetchApi, refresh]);
  return (
    <Page themeId="home">
      <Header title="Workspace" subtitle="Access" />
      <Content>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          mb={3}
        >
          <Typography variant="h4" component="h1">
            Your workspace access
          </Typography>
          <Button
            onClick={() => {
              setData(null);
              setError(false);
              setRefresh(x => x + 1);
            }}
          >
            Refresh
          </Button>
        </Box>
        <Typography paragraph>
          Sign in with GitHub. Your account identifier is not a mailbox; you do
          not need a separate password or passkey.
        </Typography>
        {error && (
          <Alert severity="warning">
            We could not verify your current access. Try refreshing in a moment.
            Previously shown permissions may have changed.
          </Alert>
        )}
        {!error && !data && (
          <CircularProgress aria-label="Checking current access" />
        )}
        {data?.legacyMembership && (
          <Alert severity="info">
            This access view currently covers self-service workspaces. Your
            existing platform memberships are managed separately.
          </Alert>
        )}
        {data && data.workspaces.length === 0 && !data.legacyMembership && (
          <Typography>
            No workspaces are currently listed for your account.
          </Typography>
        )}
        {data?.workspaces.map(workspace => (
          <Box key={workspace.tenant} my={3}>
            <Card>
              <CardHeader
                title={workspace.tenant}
                action={
                  <Chip
                    label={
                      workspace.status === 'ready'
                        ? 'Ready'
                        : 'Provisioning in progress'
                    }
                  />
                }
              />
              <CardContent>
                <Typography paragraph>
                  Account: <strong>{workspace.account}</strong>
                  <br />
                  Role: <strong>{workspace.role}</strong>
                </Typography>
                <Typography variant="h6" component="h2">
                  Available access
                </Typography>
                {workspace.capabilities.map(capability => (
                  <Typography key={capability.id} paragraph>
                    <Link href={capability.url}>{capability.label}</Link>
                  </Typography>
                ))}
                {!workspace.capabilities.length && (
                  <Typography paragraph>
                    Access is still being prepared. This page will refresh
                    automatically.
                  </Typography>
                )}
                {workspace.mcp === 'blocked' && (
                  <Typography paragraph>
                    AI client connections are not enabled for this account yet.
                    Check this page for updates.
                  </Typography>
                )}
                <Typography variant="h6" component="h2">
                  Environments
                </Typography>
                {workspace.environments.map(env => (
                  <Typography key={env.namespace}>
                    {env.name}: {env.namespace} —{' '}
                    {env.status === 'ready' ? 'Ready' : 'Being prepared'}
                  </Typography>
                ))}
                <Box mt={2}>
                  <Typography variant="body2" color="textSecondary">
                    Verified as of{' '}
                    {new Date(workspace.observedAt).toLocaleString()}.
                    Permissions may change; this page checks them again every 30
                    seconds.
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Box>
        ))}
      </Content>
    </Page>
  );
}
