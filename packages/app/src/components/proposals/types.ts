export type ProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'in-progress'
  | 'implemented'
  | 'rejected';

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
  proposedContent?: string;
}

export interface ProposalDetail extends ProposalSummary {
  documents: ProposalDocuments;
}
