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
  attempt: number;
  /** Raw mctl-api phase; never defaulted, since it gates the resume action. */
  phase: string;
  startedAt: string;
  endedAt?: string;
  resumedFromExecutionId?: string;
}

/**
 * A sealed ContextSnapshot's metadata. `latest_snapshot` carries only the first
 * three fields; the snapshot list adds the rest. Never the snapshot bytes.
 */
export interface SnapshotRef {
  id: string;
  executionId: string;
  contentHash: string;
  executionSequence?: number;
  strategy?: string;
  strategyVersion?: string;
  priorSnapshotId?: string;
  createdAt?: string;
}

/** A stored execution-evidence envelope's identity, without the envelope. */
export interface EvidenceRef {
  id: string;
  /** Blank for evidence joined only to a runtime context; see primaryRef*. */
  executionId?: string;
  contentHash: string;
  apiVersion?: string;
  createdAt?: string;
  /** `work` (a work-item execution) or `runtime` (an ADR 011 `ex-` context). */
  primaryRefKind: string;
  /** For `runtime`, an opaque ADR 011 `ex-` context id, never an engine run. */
  primaryRefId: string;
}

/** One lifecycle event. Principals, request ids and `detail` are not forwarded. */
export interface WorkItemEventRef {
  seq: number;
  kind: string;
  fromState?: string;
  toState?: string;
  surface?: string;
  createdAt?: string;
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
  /** History, read through the relay (mctl-api#436); each degrades on its own. */
  executions: Observed<ExecutionRef[]>;
  snapshots: Observed<SnapshotRef[]>;
  /** Newest first. mctl-api answers a bounded page; see `evidenceTruncated`. */
  evidence: Observed<EvidenceRef[]>;
  /**
   * Present only when `evidence` is ok and mctl-api clipped the page: the list
   * then holds the latest `limit` envelopes, not all of them.
   */
  evidenceTruncated?: { limit?: number };
  events: Observed<WorkItemEventRef[]>;
  /** Not observable through the surface relay today. */
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
