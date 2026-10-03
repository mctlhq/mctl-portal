import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  executions: unknownRelay,
  snapshots: unknownRelay,
  evidence: unknownRelay,
  surfaces: unknownRelay,
  links: [],
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
    render(<WorkItemDetailView item={item()} api={api()} onReload={jest.fn()} />);
    expect(screen.getByTestId('work-item-header').textContent).toContain('Fix it');
    expect(screen.getByTestId('pending-panel').textContent).toContain('human input');
    expect(screen.getByText('Canvas unavailable')).toBeTruthy();
  });

  it('shows the link form and no data on link_required (T10)', () => {
    render(
      <WorkItemDetailView error={new WorkItemsApiError(403, 'x', 'link_required')} api={api()} onReload={jest.fn()} />,
    );
    expect(screen.getByText('Link your platform identity')).toBeTruthy();
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
    });
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
