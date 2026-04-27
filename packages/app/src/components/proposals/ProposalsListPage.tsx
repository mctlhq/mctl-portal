import { useMemo, useState } from 'react';
import {
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  Link as MuiLink,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import {
  Page,
  Header,
  Content,
  ContentHeader,
  SupportButton,
  ResponseErrorPanel,
} from '@backstage/core-components';
import {
  useApi,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import useAsync from 'react-use/esm/useAsync';
import { useNavigate } from 'react-router-dom';
import { ProposalsApi } from './api';
import { ProposalStatus, ProposalSummary } from './types';

const STATUSES: ProposalStatus[] = [
  'proposed',
  'accepted',
  'in-progress',
  'implemented',
  'rejected',
];

const STATUS_COLOR: Record<
  ProposalStatus,
  'default' | 'primary' | 'secondary'
> = {
  proposed: 'default',
  accepted: 'primary',
  'in-progress': 'primary',
  implemented: 'primary',
  rejected: 'secondary',
};

const useStyles = makeStyles(theme => ({
  filters: {
    display: 'flex',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
    flexWrap: 'wrap',
  },
  filter: {
    minWidth: 180,
  },
  row: {
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
  empty: {
    padding: theme.spacing(4),
    textAlign: 'center',
  },
}));

function formatTimestamp(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export const ProposalsListPage = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const api = useMemo(
    () => new ProposalsApi(discoveryApi, fetchApi),
    [discoveryApi, fetchApi],
  );

  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortDesc, setSortDesc] = useState(true);

  const { value, loading, error } = useAsync(async () => api.list(), [api]);
  const proposals = useMemo<ProposalSummary[]>(() => value ?? [], [value]);

  const services = useMemo(() => {
    const set = new Set<string>();
    for (const p of proposals) set.add(p.service);
    return Array.from(set).sort();
  }, [proposals]);

  const filtered = useMemo(() => {
    let out = proposals.slice();
    if (serviceFilter !== 'all') {
      out = out.filter(p => p.service === serviceFilter);
    }
    if (statusFilter !== 'all') {
      out = out.filter(p => p.status === statusFilter);
    }
    out.sort((a, b) => {
      const av = a.updated_at ?? '';
      const bv = b.updated_at ?? '';
      const cmp = av.localeCompare(bv);
      return sortDesc ? -cmp : cmp;
    });
    return out;
  }, [proposals, serviceFilter, statusFilter, sortDesc]);

  return (
    <Page themeId="tool">
      <Header
        title="Proposals"
        subtitle="Review and triage proposals from mctl-agents"
      />
      <Content>
        <ContentHeader title="All proposals">
          <SupportButton>
            Proposals are written by mctl-agents into{' '}
            <code>platform-gitops/agents-state/&lt;service&gt;/proposals/</code>{' '}
            in mctl-gitops. Accept or Reject writes a <code>.status.yaml</code>{' '}
            commit on your behalf.
          </SupportButton>
        </ContentHeader>

        <div className={classes.filters}>
          <FormControl className={classes.filter}>
            <InputLabel id="proposals-service-filter">Service</InputLabel>
            <Select
              labelId="proposals-service-filter"
              value={serviceFilter}
              onChange={e => setServiceFilter(String(e.target.value))}
            >
              <MenuItem value="all">All</MenuItem>
              {services.map(s => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl className={classes.filter}>
            <InputLabel id="proposals-status-filter">Status</InputLabel>
            <Select
              labelId="proposals-status-filter"
              value={statusFilter}
              onChange={e => setStatusFilter(String(e.target.value))}
            >
              <MenuItem value="all">All</MenuItem>
              {STATUSES.map(s => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </div>

        {loading && <CircularProgress />}
        {error && <ResponseErrorPanel error={error} />}

        {!loading && !error && (
          <Paper>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Service</TableCell>
                  <TableCell>Slug</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>
                    <TableSortLabel
                      active
                      direction={sortDesc ? 'desc' : 'asc'}
                      onClick={() => setSortDesc(prev => !prev)}
                    >
                      Updated At
                    </TableSortLabel>
                  </TableCell>
                  <TableCell>Updated By</TableCell>
                  <TableCell>PR</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className={classes.empty}>
                      <Typography variant="body2" color="textSecondary">
                        No proposals match the current filters.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(p => (
                  <TableRow
                    key={`${p.service}/${p.slug}`}
                    className={classes.row}
                    onClick={() =>
                      navigate(
                        `/proposals/${encodeURIComponent(
                          p.service,
                        )}/${encodeURIComponent(p.slug)}`,
                      )
                    }
                    hover
                  >
                    <TableCell>{p.service}</TableCell>
                    <TableCell>{p.slug}</TableCell>
                    <TableCell>
                      <Chip
                        label={p.status}
                        size="small"
                        color={STATUS_COLOR[p.status]}
                      />
                    </TableCell>
                    <TableCell>{formatTimestamp(p.updated_at)}</TableCell>
                    <TableCell>{p.updated_by ?? '—'}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      {p.pr ? (
                        <MuiLink href={p.pr} target="_blank" rel="noreferrer">
                          PR
                        </MuiLink>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </Content>
    </Page>
  );
};
