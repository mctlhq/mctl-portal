import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Grid,
  Link as MuiLink,
  Paper,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import {
  Page,
  Header,
  Content,
  ContentHeader,
  ResponseErrorPanel,
} from '@backstage/core-components';
import {
  useApi,
  discoveryApiRef,
  fetchApiRef,
  alertApiRef,
} from '@backstage/core-plugin-api';
import useAsyncFn from 'react-use/esm/useAsyncFn';
import useAsync from 'react-use/esm/useAsync';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProposalsApi } from './api';
import { ProposalDetail, ProposalStatus } from './types';
import { useIsAdmin } from '../../hooks/useIsAdmin';

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
  sidebar: {
    padding: theme.spacing(2),
  },
  meta: {
    marginTop: theme.spacing(1),
    '& > *': {
      display: 'block',
      marginBottom: theme.spacing(0.5),
    },
  },
  actions: {
    marginTop: theme.spacing(2),
    display: 'flex',
    gap: theme.spacing(1),
  },
  notes: {
    marginTop: theme.spacing(2),
    padding: theme.spacing(1.5),
    backgroundColor: theme.palette.background.default,
    borderRadius: 4,
  },
  markdown: {
    padding: theme.spacing(2),
    '& pre': {
      backgroundColor: theme.palette.background.default,
      padding: theme.spacing(1),
      borderRadius: 4,
      overflowX: 'auto',
    },
    '& code': {
      fontFamily: 'monospace',
    },
    '& table': {
      borderCollapse: 'collapse',
    },
    '& th, & td': {
      border: `1px solid ${theme.palette.divider}`,
      padding: theme.spacing(0.5, 1),
    },
  },
  empty: {
    padding: theme.spacing(4),
    textAlign: 'center',
    color: theme.palette.text.secondary,
  },
}));

type TabKey = 'requirements' | 'design' | 'tasks' | 'proposed-content';

export const ProposalDetailPage = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const { service, slug } = useParams();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const alertApi = useApi(alertApiRef);
  const isAdmin = useIsAdmin();

  const api = useMemo(
    () => new ProposalsApi(discoveryApi, fetchApi),
    [discoveryApi, fetchApi],
  );

  const fetchState = useAsync(async () => {
    if (!service || !slug) throw new Error('Missing service or slug');
    return api.get(service, slug);
  }, [api, service, slug]);

  const [reloadKey, setReloadKey] = useState(0);
  const reloaded = useAsync(async () => {
    if (reloadKey === 0) return null;
    if (!service || !slug) return null;
    return api.get(service, slug);
  }, [api, service, slug, reloadKey]);

  const detail: ProposalDetail | undefined =
    reloaded.value ?? fetchState.value;
  const loading = fetchState.loading || reloaded.loading;
  const error = fetchState.error ?? reloaded.error;

  const [tab, setTab] = useState<TabKey>('requirements');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNotes, setRejectNotes] = useState('');

  const [acceptState, doAccept] = useAsyncFn(async () => {
    if (!service || !slug) return;
    await api.accept(service, slug);
    alertApi.post({
      message: `Accepted ${service}/${slug}`,
      severity: 'success',
    });
    setReloadKey(k => k + 1);
  }, [api, service, slug, alertApi]);

  const [rejectState, doReject] = useAsyncFn(async () => {
    if (!service || !slug) return;
    if (!rejectNotes.trim()) return;
    await api.reject(service, slug, rejectNotes.trim());
    alertApi.post({
      message: `Rejected ${service}/${slug}`,
      severity: 'success',
    });
    setRejectOpen(false);
    setRejectNotes('');
    setReloadKey(k => k + 1);
  }, [api, service, slug, rejectNotes, alertApi]);

  const renderMarkdown = (md?: string) => {
    if (!md) {
      return (
        <Typography variant="body2" className={classes.empty}>
          No content for this section.
        </Typography>
      );
    }
    return (
      <Box className={classes.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </Box>
    );
  };

  const docs = detail?.documents ?? {};
  const showProposedContentTab = !!docs.proposedContent;

  const decisionDisabled =
    !detail ||
    detail.status === 'in-progress' ||
    detail.status === 'implemented' ||
    acceptState.loading ||
    rejectState.loading;

  let acceptDisabledReason = '';
  if (!isAdmin) {
    acceptDisabledReason = 'Only admins can change proposal status';
  } else if (decisionDisabled) {
    acceptDisabledReason = 'Cannot change status while in-progress or implemented';
  }

  return (
    <Page themeId="tool">
      <Header
        title={detail ? `${detail.service} / ${detail.slug}` : 'Proposal'}
        subtitle={detail?.status ? `Status: ${detail.status}` : ''}
      />
      <Content>
        <ContentHeader title="Proposal review">
          <Button
            variant="outlined"
            size="small"
            onClick={() => navigate('/proposals')}
          >
            Back to list
          </Button>
        </ContentHeader>

        {loading && !detail && <CircularProgress />}
        {error && <ResponseErrorPanel error={error as Error} />}

        {detail && (
          <Grid container spacing={2}>
            <Grid item xs={12} md={8}>
              <Paper>
                <Tabs
                  value={tab}
                  onChange={(_, v) => setTab(v as TabKey)}
                  indicatorColor="primary"
                  textColor="primary"
                >
                  <Tab label="Requirements" value="requirements" />
                  <Tab label="Design" value="design" />
                  <Tab label="Tasks" value="tasks" />
                  {showProposedContentTab && (
                    <Tab label="Proposed Content" value="proposed-content" />
                  )}
                </Tabs>
                {tab === 'requirements' && renderMarkdown(docs.requirements)}
                {tab === 'design' && renderMarkdown(docs.design)}
                {tab === 'tasks' && renderMarkdown(docs.tasks)}
                {tab === 'proposed-content' &&
                  renderMarkdown(docs.proposedContent)}
              </Paper>
            </Grid>
            <Grid item xs={12} md={4}>
              <Paper className={classes.sidebar}>
                <Typography variant="h6">Status</Typography>
                <Chip
                  label={detail.status}
                  color={STATUS_COLOR[detail.status]}
                />
                <Box className={classes.meta}>
                  <Typography variant="caption" color="textSecondary">
                    Updated at:{' '}
                    {detail.updated_at
                      ? new Date(detail.updated_at).toLocaleString()
                      : '—'}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    Updated by: {detail.updated_by ?? '—'}
                  </Typography>
                  {detail.pr && (
                    <Typography variant="caption" color="textSecondary">
                      PR:{' '}
                      <MuiLink
                        href={detail.pr}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {detail.pr}
                      </MuiLink>
                    </Typography>
                  )}
                </Box>
                {detail.notes && (
                  <Box className={classes.notes}>
                    <Typography variant="caption" color="textSecondary">
                      Notes
                    </Typography>
                    <Typography variant="body2">{detail.notes}</Typography>
                  </Box>
                )}

                <Box className={classes.actions}>
                  <Tooltip
                    title={acceptDisabledReason}
                    disableHoverListener={!acceptDisabledReason}
                  >
                    <span>
                      <Button
                        variant="contained"
                        color="primary"
                        disabled={!isAdmin || decisionDisabled}
                        onClick={() => doAccept()}
                      >
                        {acceptState.loading ? 'Accepting…' : 'Accept'}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip
                    title={acceptDisabledReason}
                    disableHoverListener={!acceptDisabledReason}
                  >
                    <span>
                      <Button
                        variant="outlined"
                        color="secondary"
                        disabled={!isAdmin || decisionDisabled}
                        onClick={() => setRejectOpen(true)}
                      >
                        Reject…
                      </Button>
                    </span>
                  </Tooltip>
                </Box>

                {acceptState.error && (
                  <Typography variant="caption" color="error">
                    {String(acceptState.error.message)}
                  </Typography>
                )}
                {rejectState.error && (
                  <Typography variant="caption" color="error">
                    {String(rejectState.error.message)}
                  </Typography>
                )}
              </Paper>
            </Grid>
          </Grid>
        )}

        <Dialog
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>Reject proposal</DialogTitle>
          <DialogContent>
            <DialogContentText>
              A short note is required and will be saved into{' '}
              <code>.status.yaml: notes</code>. The author of the proposal can
              read it.
            </DialogContentText>
            <TextField
              margin="dense"
              label="Reason for rejection"
              fullWidth
              multiline
              minRows={3}
              value={rejectNotes}
              onChange={e => setRejectNotes(e.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              color="secondary"
              variant="contained"
              disabled={!rejectNotes.trim() || rejectState.loading}
              onClick={() => doReject()}
            >
              {rejectState.loading ? 'Rejecting…' : 'Reject'}
            </Button>
          </DialogActions>
        </Dialog>
      </Content>
    </Page>
  );
};
