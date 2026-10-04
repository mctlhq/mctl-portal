import { useMemo, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Grid,
  Link as MuiLink,
  Paper,
  TextField,
  Typography,
} from '@material-ui/core';
import { Content, Header, Page, Progress, ResponseErrorPanel } from '@backstage/core-components';
import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import useAsync from 'react-use/esm/useAsync';
import { useParams } from 'react-router-dom';
import { WorkItemsApi, WorkItemsApiError } from './api';
import { ObservedSection } from './ObservedSection';
import { WorkItem } from './types';

type NextAction = {
  label: string;
  kind: 'start' | 'resume';
  resumedFromExecutionId?: string;
};

/** A confirmed action carries one idempotency key, so a retry is a replay. */
type PendingAction = NextAction & { idempotencyKey: string };

function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return `portal-${c.randomUUID()}`;
  return `portal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Which governed action the canonical state allows (mirrors mctl-api #368 rules). */
export function nextExecutionAction(item: WorkItem): NextAction | undefined {
  if (item.executionRequests.state !== 'ok') return undefined;
  if (item.executionRequests.value.some(r => r.state === 'pending' || r.state === 'claimed')) {
    return undefined;
  }
  if (item.latestExecution.state !== 'ok') return undefined;
  const exec = item.latestExecution.value;
  if (!exec) {
    return item.state === 'active' ? { label: 'Request start', kind: 'start' } : undefined;
  }
  if (exec.phase === 'Pending' || exec.phase === 'Running') return undefined;
  if (item.state === 'waiting' || item.state === 'active') {
    return { label: 'Request resume', kind: 'resume', resumedFromExecutionId: exec.id };
  }
  return undefined;
}

export const WorkItemDetailView = (props: {
  item?: WorkItem;
  error?: Error;
  loading?: boolean;
  api: WorkItemsApi;
  onReload: () => void;
}) => {
  const { item, error, loading, api, onReload } = props;
  const [code, setCode] = useState('');
  const [linkError, setLinkError] = useState<string>();
  const [confirm, setConfirm] = useState<PendingAction>();
  const [submitting, setSubmitting] = useState(false);
  // State updates are async, so two clicks in one tick would both see
  // submitting=false; the ref is the actual guard, the state drives the UI.
  const inFlight = useRef(false);
  const [actionError, setActionError] = useState<string>();

  if (error instanceof WorkItemsApiError && error.code === 'link_required') {
    return (
      <Paper style={{ padding: 16 }}>
        <Typography variant="h6">Link your platform identity</Typography>
        <Typography variant="body2">
          Create a one-time code from your platform account (GitHub login on mctl-api), then
          enter it here to link this portal to your identity.
        </Typography>
        <TextField
          label="Challenge code"
          value={code}
          onChange={e => setCode(e.target.value)}
          fullWidth
          margin="normal"
        />
        {linkError && <Typography color="error">{linkError}</Typography>}
        <Button
          variant="contained"
          color="primary"
          disabled={!code.trim()}
          onClick={async () => {
            try {
              setLinkError(undefined);
              await api.redeem(code.trim());
              setCode('');
              onReload();
            } catch (e) {
              setLinkError((e as Error).message);
            }
          }}
        >
          Link identity
        </Button>
      </Paper>
    );
  }
  if (error) return <ResponseErrorPanel error={error} />;
  if (!item) return loading ? <Progress /> : null;

  const action = item.actionsEnabled ? nextExecutionAction(item) : undefined;
  const openRequests =
    item.executionRequests.state === 'unknown'
      ? []
      : item.executionRequests.value.filter(r => r.state === 'pending' || r.state === 'claimed');

  const runAction = async (a: PendingAction) => {
    // One request per confirmed action: the dialog is locked while it is in
    // flight, and the key makes any resend a replay on mctl-api's side.
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      setActionError(undefined);
      await api.requestExecution(item.id, {
        kind: a.kind,
        expectedStateVersion: item.stateVersion,
        resumedFromExecutionId: a.resumedFromExecutionId,
        idempotencyKey: a.idempotencyKey,
      });
    } catch (e) {
      // Shown as returned by mctl-api (e.g. state_version_conflict).
      const err = e as WorkItemsApiError;
      setActionError(err.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      setConfirm(undefined);
      onReload(); // always re-fetch; never update optimistically
    }
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Paper style={{ padding: 16 }} data-testid="work-item-header">
          <Typography variant="h5">{item.title || item.id}</Typography>
          <Chip label={item.state} size="small" />
          {item.waitingReason && <Chip label={`waiting: ${item.waitingReason}`} size="small" />}
          <Typography variant="body2" color="textSecondary">
            {item.id} · tenant {item.tenant ?? 'unknown'} · origin {item.originSurface ?? 'unknown'}
          </Typography>
        </Paper>
      </Grid>
      <Grid item xs={12} data-testid="pending-panel">
        <Paper style={{ padding: 16 }}>
          <Typography variant="h6">Pending</Typography>
          {item.state === 'waiting' ? (
            <Typography variant="body2">
              Waiting for {item.waitingReason === 'approval' ? 'an approval' : 'human input'}.
            </Typography>
          ) : (
            <Typography variant="body2" color="textSecondary">
              Nothing is waiting on a person.
            </Typography>
          )}
          {openRequests.map(r => (
            <Typography key={r.id} variant="body2">
              Execution request {r.id} ({r.kind}) is {r.state}.
            </Typography>
          ))}
          {action && (
            <Button variant="contained" color="primary" onClick={() => setConfirm({ ...action, idempotencyKey: newIdempotencyKey() })}>
              {action.label}
            </Button>
          )}
          {actionError && <Typography color="error">{actionError}</Typography>}
        </Paper>
      </Grid>
      <Grid item xs={12} md={6} data-testid="execution-requests-panel">
        <Paper style={{ padding: 16 }}>
          <ObservedSection
            title="Execution requests"
            data={item.executionRequests}
            render={list => (
              <ul>
                {list.map(r => (
                  <li key={r.id}>
                    {r.kind} · {r.state}
                    {r.executionId ? ` · ${r.executionId}` : ''}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </li>
                ))}
              </ul>
            )}
          />
        </Paper>
      </Grid>
      <Grid item xs={12} md={6} data-testid="latest-execution-panel">
        <Paper style={{ padding: 16 }}>
          <ObservedSection
            title="Latest execution"
            data={item.latestExecution}
            render={e =>
              e && (
                <Typography variant="body2">
                  {e.id} · attempt {e.attempt ?? '?'} · {e.phase}
                </Typography>
              )
            }
          />
          <ObservedSection
            title="Latest ContextSnapshot"
            data={item.latestSnapshot}
            render={s => s && <Typography variant="body2">{s.id} · {s.contentHash}</Typography>}
          />
          {item.links.map(l => (
            <MuiLink key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label}
            </MuiLink>
          ))}
          {/* Only a configured canvas that could not be linked is a failure;
              an unset template or no execution renders nothing. */}
          {item.links.length === 0 && item.canvas === 'unavailable' && (
            <Typography variant="body2" color="textSecondary">
              Canvas unavailable
            </Typography>
          )}
        </Paper>
      </Grid>
      <Grid item xs={12}>
        <Paper style={{ padding: 16 }}>
          <ObservedSection title="All executions" data={item.executions} render={() => null} />
          <ObservedSection title="ContextSnapshots" data={item.snapshots} render={() => null} />
          <ObservedSection title="Evidence" data={item.evidence} render={() => null} />
          <ObservedSection title="Surfaces" data={item.surfaces} render={() => null} />
        </Paper>
      </Grid>
      <Dialog open={!!confirm} onClose={() => !submitting && setConfirm(undefined)}>
        <DialogTitle>{confirm?.label}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This asks the execution platform to {confirm?.kind} this work item. The platform
            decides whether it runs.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={submitting} onClick={() => setConfirm(undefined)}>
            Cancel
          </Button>
          <Button color="primary" disabled={submitting} onClick={() => confirm && runAction(confirm)}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </Grid>
  );
};

export const WorkItemDetailPage = () => {
  const { workItemId } = useParams();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const api = useMemo(() => new WorkItemsApi(discoveryApi, fetchApi), [discoveryApi, fetchApi]);
  const [reloadKey, setReloadKey] = useState(0);
  const state = useAsync(async () => {
    if (!workItemId) throw new Error('Missing work item id');
    return api.get(workItemId);
  }, [api, workItemId, reloadKey]);

  return (
    <Page themeId="tool">
      <Header title="Work item" subtitle={workItemId} />
      <Content>
        <WorkItemDetailView
          item={state.value}
          error={state.error}
          loading={state.loading}
          api={api}
          onReload={() => setReloadKey(k => k + 1)}
        />
      </Content>
    </Page>
  );
};
