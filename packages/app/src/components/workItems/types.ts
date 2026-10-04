export type Observed<T> =
  | { state: 'ok'; value: T; observedAt?: string }
  | { state: 'stale'; value: T; observedAt: string }
  | { state: 'unknown'; reason?: string };

export interface ExecutionRef {
  id: string;
  attempt?: number;
  phase: string;
  startedAt?: string;
  endedAt?: string;
  resumedFromExecutionId?: string;
}

export interface SnapshotRef {
  id: string;
  executionId: string;
  contentHash: string;
}

export interface ExecutionRequestRef {
  id: string;
  kind: string;
  state: string;
  surface?: string;
  executionId?: string;
  reason?: string;
  createdAt?: string;
}

export interface WorkItem {
  id: string;
  title: string;
  state: string;
  waitingReason?: string;
  supersededBy?: string;
  stateVersion: number;
  tenant?: string;
  visibility?: string;
  originSurface?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  latestExecution: Observed<ExecutionRef | null>;
  latestSnapshot: Observed<SnapshotRef | null>;
  executionRequests: Observed<ExecutionRequestRef[]>;
  executions: Observed<ExecutionRef[]>;
  snapshots: Observed<SnapshotRef[]>;
  evidence: Observed<unknown[]>;
  surfaces: Observed<unknown[]>;
  links: { label: string; url: string }[];
  /** Why the Execution Canvas link is, or is not, in `links`; see the backend's PortalWorkItem. */
  canvas: 'ok' | 'not_configured' | 'no_execution' | 'unavailable';
  actionsEnabled: boolean;
}
