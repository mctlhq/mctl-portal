import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import DeleteIcon from '@material-ui/icons/Delete';
import ErrorIcon from '@material-ui/icons/Error';
import HourglassEmptyIcon from '@material-ui/icons/HourglassEmpty';
import VerifiedUserIcon from '@material-ui/icons/VerifiedUser';
import FileCopyIcon from '@material-ui/icons/FileCopy';
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

const TEAM_ANNOTATION = 'platform.mctl.me/team';

export const hasTeamAnnotation = (entity: Entity): boolean =>
  Boolean(entity?.metadata?.annotations?.[TEAM_ANNOTATION]);

interface CustomDomain {
  id: string;
  team: string;
  service: string;
  domain: string;
  auto_domain: string;
  status: 'pending' | 'verified' | 'active' | 'failed';
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const statusConfig: Record<
  string,
  { label: string; color: 'default' | 'primary' | 'secondary'; icon: JSX.Element }
> = {
  pending: {
    label: 'Pending DNS',
    color: 'default',
    icon: <HourglassEmptyIcon fontSize="small" />,
  },
  verified: {
    label: 'Verified',
    color: 'primary',
    icon: <VerifiedUserIcon fontSize="small" />,
  },
  active: {
    label: 'Active',
    color: 'primary',
    icon: <CheckCircleIcon fontSize="small" />,
  },
  failed: {
    label: 'Failed',
    color: 'secondary',
    icon: <ErrorIcon fontSize="small" />,
  },
};

const useStyles = makeStyles(theme => ({
  autoDomain: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.85rem',
    padding: theme.spacing(1, 1.5),
    backgroundColor: theme.palette.type === 'dark' ? '#1e1e1e' : '#f5f5f5',
    borderRadius: 4,
    display: 'inline-block',
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  domainCell: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.85rem',
  },
  emptyState: {
    textAlign: 'center',
    padding: theme.spacing(3),
    color: theme.palette.text.secondary,
  },
  cnameHint: {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '0.8rem',
    backgroundColor: theme.palette.type === 'dark' ? '#1e1e1e' : '#f0f0f0',
    padding: theme.spacing(1.5),
    borderRadius: 4,
    marginTop: theme.spacing(1),
    wordBreak: 'break-all',
  },
  headerAction: {
    marginTop: 0,
    marginRight: 0,
  },
}));

export function EntityDomainsCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const { domain } = usePlatformConfig();

  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const team = entity.metadata.annotations?.[TEAM_ANNOTATION] ?? '';
  const service = entity.metadata.name;
  const autoDomain = team && service ? `${team}-${service}.${domain}` : '';

  const fetchDomains = useCallback(async () => {
    if (!team) return;
    setLoading(true);
    setError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('custom-domains');
      const resp = await fetchApi.fetch(
        `${baseUrl}/domains?team=${encodeURIComponent(team)}&service=${encodeURIComponent(service)}`,
      );
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as any;
        setError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as { domains: CustomDomain[] };
      setDomains(data.domains ?? []);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load domains');
    } finally {
      setLoading(false);
    }
  }, [discoveryApi, fetchApi, team, service]);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('custom-domains');
      const resp = await fetchApi.fetch(`${baseUrl}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team, service, domain: newDomain.trim().toLowerCase() }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as any;
        setAddError(body.error ?? `HTTP ${resp.status}`);
        return;
      }
      setAddOpen(false);
      setNewDomain('');
      await fetchDomains();
    } catch (e: any) {
      setAddError(e.message ?? 'Failed to add domain');
    } finally {
      setAdding(false);
    }
  };

  const handleVerify = async (id: string) => {
    setVerifying(id);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('custom-domains');
      await fetchApi.fetch(`${baseUrl}/domains/${id}/verify`, {
        method: 'POST',
      });
      await fetchDomains();
    } catch {
      // Silently fail — user can retry
    } finally {
      setVerifying(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Remove this custom domain?')) return;
    setDeleting(id);
    try {
      const baseUrl = await discoveryApi.getBaseUrl('custom-domains');
      await fetchApi.fetch(`${baseUrl}/domains/${id}`, {
        method: 'DELETE',
      });
      await fetchDomains();
    } catch {
      // Silently fail
    } finally {
      setDeleting(null);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (!team) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Domains"
          classes={{ action: classes.headerAction }}
          action={
            <Box display="flex" style={{ gap: 4 }}>
              <Tooltip title="Refresh">
                <IconButton size="small" onClick={fetchDomains}>
                  <RefreshIcon />
                </IconButton>
              </Tooltip>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => setAddOpen(true)}
              >
                Add Domain
              </Button>
            </Box>
          }
        />
        <Divider />
        <CardContent>
          {/* Auto-generated domain */}
          {autoDomain && (
            <Box mb={2}>
              <Typography variant="subtitle2" gutterBottom>
                Auto-generated Domain
              </Typography>
              <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                <span className={classes.autoDomain}>{autoDomain}</span>
                <Tooltip title="Copy">
                  <IconButton size="small" onClick={() => handleCopy(autoDomain)}>
                    <FileCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Chip size="small" label="Active" color="primary" icon={<CheckCircleIcon />} />
              </Box>
            </Box>
          )}

          {/* Loading */}
          {loading && (
            <Box display="flex" alignItems="center" style={{ gap: 8, marginTop: 16 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">Loading custom domains…</Typography>
            </Box>
          )}

          {/* Error */}
          {error && (
            <Typography variant="body2" color="error" style={{ marginTop: 8 }}>
              {error}
            </Typography>
          )}

          {/* Custom domains table */}
          {!loading && domains.length > 0 && (
            <Box mt={2}>
              <Typography variant="subtitle2" gutterBottom>
                Custom Domains
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Domain</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {domains.map(d => {
                    const sc = statusConfig[d.status] ?? statusConfig.pending;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className={classes.domainCell}>
                          {d.domain}
                          <Tooltip title="Copy">
                            <IconButton
                              size="small"
                              onClick={() => handleCopy(d.domain)}
                              style={{ marginLeft: 4 }}
                            >
                              <FileCopyIcon style={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={sc.label}
                            color={sc.color}
                            icon={sc.icon}
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption">
                            {new Date(d.created_at).toLocaleDateString()}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          {d.status === 'pending' && (
                            <Tooltip title="Verify DNS">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={() => handleVerify(d.id)}
                                  disabled={verifying === d.id}
                                >
                                  {verifying === d.id ? (
                                    <CircularProgress size={16} />
                                  ) : (
                                    <VerifiedUserIcon fontSize="small" />
                                  )}
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                          <Tooltip title="Remove">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => handleDelete(d.id)}
                                disabled={deleting === d.id}
                              >
                                {deleting === d.id ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <DeleteIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}

          {/* Empty state */}
          {!loading && domains.length === 0 && (
            <Box className={classes.emptyState} mt={2}>
              <Typography variant="body2">
                No custom domains configured. Click &quot;Add Domain&quot; to add one.
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Add domain dialog */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Custom Domain</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Enter the custom domain you want to point to this service.
          </DialogContentText>
          <TextField
            autoFocus
            margin="dense"
            label="Domain"
            placeholder="api.mycompany.com"
            fullWidth
            value={newDomain}
            onChange={e => {
              setNewDomain(e.target.value);
              setAddError(null);
            }}
            error={Boolean(addError)}
            helperText={addError}
          />
          {autoDomain && (
            <>
              <DialogContentText style={{ marginTop: 16 }}>
                Before adding, create a <strong>CNAME</strong> record at your DNS provider:
              </DialogContentText>
              <div className={classes.cnameHint}>
                {newDomain.trim() || 'your-domain.com'} CNAME → {autoDomain}
              </div>
              <DialogContentText style={{ marginTop: 8 }} variant="body2">
                DNS propagation may take a few minutes. You can verify after adding.
              </DialogContentText>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button
            onClick={handleAdd}
            color="primary"
            variant="contained"
            disabled={adding || !newDomain.trim()}
          >
            {adding ? <CircularProgress size={20} /> : 'Add Domain'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
