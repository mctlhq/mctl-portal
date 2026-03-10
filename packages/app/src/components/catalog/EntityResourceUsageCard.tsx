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
  Table,
  TableBody,
  TableCell,
  TableContainer,
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

const K8S_NAMESPACE_ANNOTATION = 'backstage.io/kubernetes-namespace';

export const hasKubernetesNamespace = (entity: Entity): boolean =>
  Boolean(entity?.metadata?.annotations?.[K8S_NAMESPACE_ANNOTATION]);

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

interface PodUsage {
  name: string;
  cpu: string;
  memory: string;
  cpuRaw: number;
  memoryRaw: number;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles(theme => ({
  metricRow: {
    marginBottom: theme.spacing(2),
  },
  labelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(0.5),
  },
  subtext: {
    color: theme.palette.text.secondary,
    fontSize: '0.75rem',
    marginTop: theme.spacing(0.5),
  },
  barRoot: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.palette.action.selected,
  },
  barColorPrimary: {
    borderRadius: 4,
  },
  headerAction: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: theme.spacing(1),
    paddingRight: theme.spacing(1),
  },
  errorText: {
    color: theme.palette.error.main,
  },
  liveChip: {
    display: 'inline-block',
    fontSize: '0.65rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: theme.palette.success.main,
    border: `1px solid ${theme.palette.success.main}`,
    borderRadius: 4,
    padding: '1px 5px',
    marginLeft: theme.spacing(1),
    verticalAlign: 'middle',
  },
  podTable: {
    marginTop: theme.spacing(1),
  },
  podTableCell: {
    fontSize: '0.8rem',
    padding: theme.spacing(0.75, 1),
  },
  podTableHeader: {
    fontSize: '0.75rem',
    fontWeight: 600,
    padding: theme.spacing(0.75, 1),
    color: theme.palette.text.secondary,
  },
}));

// ── MetricBar component ───────────────────────────────────────────────────────

interface MetricBarProps {
  label: string;
  /** e.g. "500m" (actual usage from metrics-server) */
  liveValue: string | undefined;
  /** e.g. "2000m" (ResourceQuota used) */
  quotaUsed: string | undefined;
  /** e.g. "8000m" (ResourceQuota limit) */
  limit: string | undefined;
  usedRaw: number;
  limitRaw: number;
  isLive: boolean;
}

function MetricBar({ label, liveValue, quotaUsed, limit, usedRaw, limitRaw, isLive }: MetricBarProps) {
  const classes = useStyles();
  const pct = limitRaw > 0 ? Math.min(100, Math.round((usedRaw / limitRaw) * 100)) : 0;
  const isHigh = pct > 80;

  return (
    <Box className={classes.metricRow}>
      <Box className={classes.labelRow}>
        <Typography variant="subtitle2">
          {label}
          {isLive && <span className={classes.liveChip}>LIVE</span>}
        </Typography>
        <Typography variant="subtitle2">{pct}%</Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={isHigh ? 'secondary' : 'primary'}
        classes={{ root: classes.barRoot, colorPrimary: classes.barColorPrimary }}
      />
      <Typography className={classes.subtext}>
        {isLive && liveValue ? (
          <>{liveValue} live · {quotaUsed ?? '—'} quota used · {limit ?? '—'} limit</>
        ) : (
          <>{quotaUsed ?? '—'} used · {limit ?? '—'} limit</>
        )}
      </Typography>
    </Box>
  );
}

// ── Main card component ───────────────────────────────────────────────────────

export function EntityResourceUsageCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<NamespaceUsage | null>(null);
  const [pods, setPods] = useState<PodUsage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const namespace = entity.metadata.annotations?.[K8S_NAMESPACE_ANNOTATION];

  const fetchUsage = useCallback(async () => {
    if (!namespace) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('resource-usage');
      const [usageResp, podsResp] = await Promise.all([
        fetchApi.fetch(`${baseUrl}/namespaces/${namespace}/usage`),
        fetchApi.fetch(`${baseUrl}/namespaces/${namespace}/pods`),
      ]);
      if (!usageResp.ok) {
        const body = await usageResp.json().catch(() => ({})) as any;
        setError(body.error ?? `HTTP ${usageResp.status}`);
        return;
      }
      setUsage(await usageResp.json() as NamespaceUsage);
      if (podsResp.ok) {
        const podsData = await podsResp.json() as { pods: PodUsage[] };
        setPods(podsData.pods ?? []);
      }
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
        <CardHeader title="Resource Usage" />
        <Divider />
        <CardContent>
          <Typography color="textSecondary" variant="body2">
            Set the <code>{K8S_NAMESPACE_ANNOTATION}</code> annotation on this entity to enable resource usage tracking.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const q = usage?.quota;
  const live = usage?.liveUsage;
  const hasLive = Boolean(live);

  // For CPU bar: prefer live usage over quota used
  const cpuUsedRaw = live?.cpuRaw ?? q?.['limits.cpu']?.usedRaw ?? 0;
  const cpuLimitRaw = q?.['limits.cpu']?.limitRaw ?? q?.['requests.cpu']?.limitRaw ?? 0;

  // For memory bar: prefer live usage over quota used
  const memUsedRaw = live?.memoryRaw ?? q?.['limits.memory']?.usedRaw ?? 0;
  const memLimitRaw = q?.['limits.memory']?.limitRaw ?? q?.['requests.memory']?.limitRaw ?? 0;

  return (
    <Card>
      <CardHeader
        title="Resource Usage"
        subheader={`Namespace: ${namespace}`}
        action={
          <Box className={classes.headerAction}>
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
      <CardContent>
        {loading && (
          <Box display="flex" alignItems="center">
            <CircularProgress size={20} />
            <Typography variant="body2" style={{ marginLeft: 8 }}>Loading…</Typography>
          </Box>
        )}

        {error && !loading && (
          <Typography className={classes.errorText} variant="body2">{error}</Typography>
        )}

        {usage && !loading && (
          <>
            <MetricBar
              label="CPU"
              liveValue={live?.cpu}
              quotaUsed={q?.['limits.cpu']?.used}
              limit={q?.['limits.cpu']?.limit}
              usedRaw={cpuUsedRaw}
              limitRaw={cpuLimitRaw}
              isLive={hasLive}
            />
            <MetricBar
              label="Memory"
              liveValue={live?.memory}
              quotaUsed={q?.['limits.memory']?.used}
              limit={q?.['limits.memory']?.limit}
              usedRaw={memUsedRaw}
              limitRaw={memLimitRaw}
              isLive={hasLive}
            />
            <Box className={classes.metricRow}>
              <Box className={classes.labelRow}>
                <Typography variant="subtitle2">Pods</Typography>
                <Typography variant="subtitle2">
                  {live?.podCount ?? q?.pods?.used ?? '—'} / {q?.pods?.limit ?? '—'}
                </Typography>
              </Box>
              {q?.pods && (
                <LinearProgress
                  variant="determinate"
                  value={q.pods.usedPct}
                  color={q.pods.usedPct > 80 ? 'secondary' : 'primary'}
                  classes={{ root: classes.barRoot, colorPrimary: classes.barColorPrimary }}
                />
              )}
            </Box>

            {pods.length > 0 && (
              <TableContainer className={classes.podTable}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell className={classes.podTableHeader}>Pod</TableCell>
                      <TableCell className={classes.podTableHeader} align="right">CPU</TableCell>
                      <TableCell className={classes.podTableHeader} align="right">Memory</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pods.map(pod => (
                      <TableRow key={pod.name}>
                        <TableCell className={classes.podTableCell}>{pod.name}</TableCell>
                        <TableCell className={classes.podTableCell} align="right">{pod.cpu}</TableCell>
                        <TableCell className={classes.podTableCell} align="right">{pod.memory}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
