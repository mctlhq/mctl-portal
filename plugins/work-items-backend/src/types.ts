/**
 * Portal-side WorkItem shape. Every section that may not be observable says so
 * explicitly, so "unknown" never collapses into "empty".
 */
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
  updatedAt?: string;
  closedAt?: string;
}

export interface PortalWorkItem {
  id: string;
  title: string;
  /** active | waiting | completed | superseded | archived; unrecognised values kept raw. */
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
  /** Not observable through the surface relay today. */
  executions: Observed<ExecutionRef[]>;
  snapshots: Observed<SnapshotRef[]>;
  evidence: Observed<unknown[]>;
  surfaces: Observed<unknown[]>;
  links: { label: string; url: string }[];
  /**
   * Why the Execution Canvas link is, or is not, in `links`, so the UI never
   * reports a feature that was never turned on as a failure:
   * - `ok`: the link is in `links`;
   * - `not_configured`: `workItems.executionCanvasUrlTemplate` is unset;
   * - `no_execution`: the item has no execution to link to;
   * - `unavailable`: configured, but the latest execution was unreadable or
   *   the built URL was refused by the link filter.
   */
  canvas: CanvasLinkStatus;
}

export type CanvasLinkStatus =
  | 'ok'
  | 'not_configured'
  | 'no_execution'
  | 'unavailable';
