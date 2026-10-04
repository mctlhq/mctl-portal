import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderInTestApp } from '@backstage/test-utils';
import { ObservedSection } from './ObservedSection';
import { WorkItemDetailView } from './WorkItemDetailPage';
import { WorkItemsApi, WorkItemsApiError } from './api';
import { WorkItem } from './types';

const unknownRelay = { state: 'unknown' as const, reason: 'not_available_via_relay' };
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'wi_1',
  title: 'Fix it',
  state: 'waiting',
  waitingReason: 'input',
  stateVersion: 3,
  tenant: 'acme',
  originSurface: 'telegram',
  latestExecution: { state: 'ok', value: { id: 'we_1', phase: 'Succeeded', attempt: 1 } },
  latestSnapshot: { state: 'ok', value: null },
  executionRequests: { state: 'ok', value: [] },
  executions: { state: 'ok', value: [{ id: 'we_1', phase: 'Succeeded', attempt: 1 }] },
  snapshots: { state: 'ok', value: [] },
  evidence: { state: 'ok', value: [] },
  events: { state: 'ok', value: [] },
  surfaces: unknownRelay,
  links: [],
  canvas: 'not_configured',
  actionsEnabled: false,
  ...over,
});

describe('ObservedSection (T9)', () => {
  it('distinguishes unknown, stale and empty', () => {
    const { rerender } = render(
      <ObservedSection title="S" data={{ state: 'unknown', reason: 'not_available_via_relay' }} render={() => null} />,
    );
    expect(screen.getByText('Not available yet')).toBeTruthy();
    rerender(<ObservedSection title="S" data={{ state: 'unknown' }} render={() => null} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    rerender(<ObservedSection title="S" data={{ state: 'stale', value: ['a'], observedAt: 'T0' }} render={v => <>{v}</>} />);
    expect(screen.getByText('Stale since T0')).toBeTruthy();
    rerender(<ObservedSection title="S" data={{ state: 'ok', value: [] as string[] }} render={() => null} />);
    expect(screen.getByText('None')).toBeTruthy();
  });
});

describe('WorkItemDetailView', () => {
  const api = (over: Partial<Record<keyof WorkItemsApi, jest.Mock>> = {}) =>
    ({ redeem: jest.fn(), requestExecution: jest.fn(), get: jest.fn(), ...over }) as unknown as WorkItemsApi;

  it('renders header, pending panel and canvas-unavailable (T10)', () => {
    render(<WorkItemDetailView item={item({ canvas: 'unavailable' })} api={api()} onReload={jest.fn()} />);
    expect(screen.getByTestId('work-item-header').textContent).toContain('Fix it');
    expect(screen.getByTestId('pending-panel').textContent).toContain('human input');
    expect(screen.getByText('Canvas unavailable')).toBeTruthy();
  });

  it('reports no canvas failure when the canvas is not configured or there is no execution', () => {
    const { rerender } = render(<WorkItemDetailView item={item()} api={api()} onReload={jest.fn()} />);
    expect(screen.getByTestId('latest-execution-panel').textContent).toContain('we_1');
    expect(screen.queryByText('Canvas unavailable')).toBeNull();
    rerender(
      <WorkItemDetailView
        item={item({ latestExecution: { state: 'ok', value: null }, canvas: 'no_execution' })}
        api={api()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.queryByText('Canvas unavailable')).toBeNull();
    rerender(
      <WorkItemDetailView
        item={item({ links: [{ label: 'Execution Canvas', url: '/canvas/we_1' }], canvas: 'ok' })}
        api={api()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByText('Execution Canvas').closest('a')?.getAttribute('href')).toBe('/canvas/we_1');
    expect(screen.queryByText('Canvas unavailable')).toBeNull();
  });

  it('renders the history sections, with None for an empty list (mctl-api#436)', () => {
    const { rerender } = render(<WorkItemDetailView item={item()} api={api()} onReload={jest.fn()} />);
    expect(screen.getByTestId('section-All executions').textContent).toContain('we_1 · attempt 1 · Succeeded');
    for (const title of ['ContextSnapshots', 'Evidence', 'Events']) {
      expect(screen.getByTestId(`section-${title}`).textContent).toContain('None');
    }
    expect(screen.getByTestId('section-Surfaces').textContent).toContain('Not available yet');
    rerender(
      <WorkItemDetailView
        item={item({
          executions: {
            state: 'ok',
            value: [
              { id: 'we_1', phase: 'Failed', attempt: 1 },
              { id: 'we_2', phase: 'Running', attempt: 2, resumedFromExecutionId: 'we_1' },
            ],
          },
          snapshots: {
            state: 'ok',
            value: [{ id: 'cs_1', executionId: 'we_1', contentHash: 'sha256:aa', strategy: 'devloop', strategyVersion: '3' }],
          },
          evidence: {
            state: 'ok',
            value: [{ id: 'ev_1', contentHash: 'sha256:bb', primaryRefKind: 'work', primaryRefId: 'we_1' }],
          },
          events: { state: 'ok', value: [{ seq: 1, kind: 'state_changed', fromState: 'active', toState: 'waiting', surface: 'telegram' }] },
        })}
        api={api()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('section-All executions').textContent).toContain('we_2 · attempt 2 · Running · resumed from we_1');
    expect(screen.getByTestId('section-ContextSnapshots').textContent).toContain('cs_1 · we_1 · sha256:aa · devloop@3');
    expect(screen.getByTestId('section-Evidence').textContent).toContain('ev_1 · work we_1 · sha256:bb');
    expect(screen.getByTestId('section-Evidence').textContent).not.toContain('Showing the latest');
    expect(screen.getByTestId('section-Events').textContent).toContain('#1 · state_changed · active → waiting · via telegram');
  });

  it('says when the evidence page is clipped', () => {
    render(
      <WorkItemDetailView
        item={item({ evidence: { state: 'ok', value: [{ id: 'ev_2' }] }, evidenceTruncated: { limit: 1 } })}
        api={api()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('section-Evidence').textContent).toContain('Showing the latest 1; older evidence exists.');
  });

  it('shows an unreadable history section as unknown, not empty', () => {
    render(
      <WorkItemDetailView
        item={item({ executions: { state: 'unknown', reason: 'fetch_failed' }, events: undefined })}
        api={api()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('section-All executions').textContent).toContain('Unknown');
    expect(screen.getByTestId('section-All executions').textContent).not.toContain('None');
    expect(screen.queryByTestId('section-Events')).toBeNull();
  });

  it('shows the link form and no data on link_required (T10)', () => {
    render(
      <WorkItemDetailView error={new WorkItemsApiError(403, 'x', 'link_required')} api={api()} onReload={jest.fn()} />,
    );
    expect(screen.getByText('Link your platform identity')).toBeTruthy();
    expect(screen.queryByTestId('work-item-header')).toBeNull();
  });

  it('renders a generic error in the error panel, without the link form or data', async () => {
    await renderInTestApp(<WorkItemDetailView error={new WorkItemsApiError(502, 'mctl-api upstream error 500')} api={api()} onReload={jest.fn()} />);
    expect(screen.getAllByText(/mctl-api upstream error 500/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Link your platform identity')).toBeNull();
    expect(screen.queryByTestId('work-item-header')).toBeNull();
  });

  it('hides actions when disabled (T11)', () => {
    render(<WorkItemDetailView item={item()} api={api()} onReload={jest.fn()} />);
    expect(screen.queryByText('Request resume')).toBeNull();
  });

  it('calls the API then re-fetches when enabled (T11)', async () => {
    const a = api({ requestExecution: jest.fn().mockResolvedValue(undefined) });
    const onReload = jest.fn();
    render(<WorkItemDetailView item={item({ actionsEnabled: true })} api={a} onReload={onReload} />);
    fireEvent.click(screen.getByText('Request resume'));
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(a.requestExecution).toHaveBeenCalledWith('wi_1', {
      kind: 'resume',
      expectedStateVersion: 3,
      resumedFromExecutionId: 'we_1',
      idempotencyKey: expect.stringMatching(/^portal-.+/),
    });
  });

  it('sends one request for a double-clicked Confirm, with an idempotency key', async () => {
    let resolve: () => void = () => {};
    const a = api({ requestExecution: jest.fn(() => new Promise<void>(r => (resolve = r))) });
    const onReload = jest.fn();
    render(<WorkItemDetailView item={item({ actionsEnabled: true })} api={a} onReload={onReload} />);
    fireEvent.click(screen.getByText('Request resume'));
    const confirmButton = screen.getByText('Confirm');
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(screen.getByText('Confirm').closest('button')).toHaveProperty('disabled', true));
    fireEvent.click(screen.getByText('Confirm'));
    expect(a.requestExecution).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(a.requestExecution).toHaveBeenCalledTimes(1);
  });

  it('offers start for an active item that never ran', async () => {
    const a = api({ requestExecution: jest.fn().mockResolvedValue(undefined) });
    render(
      <WorkItemDetailView
        item={item({ state: 'active', waitingReason: undefined, latestExecution: { state: 'ok', value: null }, actionsEnabled: true })}
        api={a}
        onReload={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Request start'));
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(a.requestExecution).toHaveBeenCalled());
    expect(a.requestExecution).toHaveBeenCalledWith('wi_1', expect.objectContaining({ kind: 'start', expectedStateVersion: 3 }));
  });

  it('shows a progress indicator while loading', () => {
    render(<WorkItemDetailView loading api={api()} onReload={jest.fn()} />);
    expect(screen.getByTestId('progress')).toBeTruthy();
  });

  it('shows the mctl-api error and re-fetches on rejection (T12)', async () => {
    const a = api({
      requestExecution: jest.fn().mockRejectedValue(new WorkItemsApiError(409, 'stale', 'state_version_conflict')),
    });
    const onReload = jest.fn();
    render(<WorkItemDetailView item={item({ actionsEnabled: true })} api={a} onReload={onReload} />);
    fireEvent.click(screen.getByText('Request resume'));
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByText('state_version_conflict: stale')).toBeTruthy());
    expect(onReload).toHaveBeenCalled();
  });
});
