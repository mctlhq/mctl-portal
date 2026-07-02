/**
 * Status values for a proposal — see shared contract in
 * `mctl-gitops/platform-gitops/agents-state/<service>/proposals/<slug>/.status.yaml`.
 *
 * Default (file absent) = `proposed`.
 */
export type ProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'in-progress'
  | 'implemented'
  | 'rejected';

/** Schema of `.status.yaml` (shared with mctl-agents Tier 2). */
export interface StatusYaml {
  status: ProposalStatus;
  updated_at?: string;
  updated_by?: string;
  pr?: string;
  notes?: string;
}

export interface ProposalSummary {
  service: string;
  slug: string;
  status: ProposalStatus;
  updated_at?: string;
  updated_by?: string;
  pr?: string;
  notes?: string;
}

export interface ProposalDocuments {
  requirements?: string;
  design?: string;
  tasks?: string;
  /** Only present for mctl-docs proposals. */
  proposedContent?: string;
}

export interface ProposalDetail extends ProposalSummary {
  documents: ProposalDocuments;
}
