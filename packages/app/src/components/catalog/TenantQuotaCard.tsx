import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  CircularProgress,
  Divider,
  LinearProgress,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import { makeStyles } from '@material-ui/core/styles';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Entity } from '@backstage/catalog-model';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { usePlatformConfig } from '../../platformConfig';

const TENANT_NAME_ANNOTATION = 'mctl.me/tenant-name';

export const isTenantResource = (entity: Entity): boolean =>
  entity?.kind === 'Resource' &&
  Boolean(entity?.metadata?.annotations?.[TENANT_NAME_ANNOTATION]);

export const isTenantGroup = (_entity: Entity): boolean =>
  _entity?.kind === 'Group';

// ── Types (mirrored from resource-usage-backend) ──────────────────────────────

interface QuotaMetric {
  used: string;
  limit: string;
  usedRaw: number;
  limitRaw: number;
  usedPct: number;
}

interface NamespaceUsage {
  namespace: string;
  quota: {
    'requests.cpu'?: QuotaMetric;
    'limits.cpu'?: QuotaMetric;
    'requests.memory'?: QuotaMetric;
    'limits.memory'?: QuotaMetric;
    pods?: QuotaMetric;
  };
  liveUsage: {
    cpu: string;
    memory: string;
    podCount: number;
    cpuRaw: number;
    memoryRaw: number;
  } | null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles(theme => ({
  tableHead: {
    '& th': {
      fontWeight: 700,
      backgroundColor: theme.palette.background.default,
    },
  },
  barCell: {
    width: 120,
    paddingTop: 4,
    paddingBottom: 4,
  },
  bar: {
    height: 6,
    borderRadius: 3,
  },
  headerAction: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    paddingTop: theme.spacing(1),
    paddingRight: theme.spacing(1),
  },
  errorText: {
    color: theme.palette.error.main,
  },
  highUsage: {
    color: theme.palette.error.main,
    fontWeight: 600,
  },
  monoCell: {
    fontFamily: '"JetBrains Mono", "Roboto Mono", monospace',
    fontSize: '0.8rem',
  },
  liveSection: {
    padding: theme.spacing(1.5, 2),
    backgroundColor: theme.palette.background.default,
    borderTop: `1px solid ${theme.palette.divider}`,
  },
  liveLabel: {
    color: theme.palette.text.secondary,
    fontSize: '0.75rem',
  },
}));

// ── Quota row definitions ─────────────────────────────────────────────────────

const QUOTA_ROWS: Array<{ key: keyof NamespaceUsage['quota']; label: string }> = [
  { key: 'requests.cpu',    label: 'requests.cpu' },
  { key: 'limits.cpu',      label: 'limits.cpu' },
  { key: 'requests.memory', label: 'requests.memory' },
  { key: 'limits.memory',   label: 'limits.memory' },
  { key: 'pods',            label: 'pods' },
];

// ── Main card component ───────────────────────────────────────────────────────

export function TenantQuotaCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const { argocdBaseUrl } = usePlatformConfig();

  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<NamespaceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const namespace = entity.metadata.annotations?.[TENANT_NAME_ANNOTATION];

  const fetchUsage = useCallback(async () => {
    if (!namespace) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('resource-usage');
      const resp = await fetchApi.fetch(`${baseUrl}/namespaces/${namespace}/usage`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as any;
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setUsage(await resp.json() as NamespaceUsage);
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [namespace, discoveryApi, fetchApi]);

  useEffect(() => { fetchUsage(); }, [fetchUsage]);

  if (!namespace) {
    return (
      <Card>
        <CardHeader title="Quota Usage" />
        <Divider />
        <CardContent>
          <Typography color="textSecondary" variant="body2">
            No <code>{TENANT_NAME_ANNOTATION}</code> annotation set on this entity.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Quota Usage"
        subheader={`Namespace: ${namespace}`}
        action={
          <Box className={classes.headerAction}>
            <Link
              href={`${argocdBaseUrl}/${namespace}`}
              target="_blank"
              rel="noopener noreferrer"
              variant="body2"
            >
              ArgoCD ↗
            </Link>
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              onClick={fetchUsage}
              disabled={loading}
            >
              Refresh
            </Button>
          </Box>
        }
      />
      <Divider />
      <CardContent style={{ padding: 0 }}>

        {loading && (
          <Box display="flex" alignItems="center" padding={2}>
            <CircularProgress size={20} />
            <Typography variant="body2" style={{ marginLeft: 8 }}>Loading…</Typography>
          </Box>
        )}

        {error && !loading && (
          <Box padding={2}>
            <Typography className={classes.errorText} variant="body2">{error}</Typography>
          </Box>
        )}

        {usage && !loading && (
          <>
            <Table size="small">
              <TableHead className={classes.tableHead}>
                <TableRow>
                  <TableCell>Resource</TableCell>
                  <TableCell>Used</TableCell>
                  <TableCell>Limit</TableCell>
                  <TableCell align="right">%</TableCell>
                  <TableCell className={classes.barCell} />
                </TableRow>
              </TableHead>
              <TableBody>
                {QUOTA_ROWS.map(({ key, label }) => {
                  const metric = usage.quota[key];
                  if (!metric) return null;
                  const isHigh = metric.usedPct > 80;
                  return (
                    <TableRow key={key}>
                      <TableCell className={classes.monoCell}>{label}</TableCell>
                      <TableCell className={isHigh ? classes.highUsage : classes.monoCell}>
                        {metric.used}
                      </TableCell>
                      <TableCell className={classes.monoCell}>{metric.limit}</TableCell>
                      <TableCell align="right" className={isHigh ? classes.highUsage : undefined}>
                        {metric.usedPct}%
                      </TableCell>
                      <TableCell className={classes.barCell}>
                        <LinearProgress
                          variant="determinate"
                          value={metric.usedPct}
                          color={isHigh ? 'secondary' : 'primary'}
                          className={classes.bar}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {/* Live metrics footer */}
            {usage.liveUsage && (
              <Box className={classes.liveSection}>
                <Typography className={classes.liveLabel}>
                  Live (metrics-server) — CPU: <strong>{usage.liveUsage.cpu}</strong>
                  &nbsp;· Memory: <strong>{usage.liveUsage.memory}</strong>
                  &nbsp;· Pods: <strong>{usage.liveUsage.podCount}</strong>
                </Typography>
              </Box>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
