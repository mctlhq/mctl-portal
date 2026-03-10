/**
 * Tenant data as stored in the database cache and returned by the API.
 * Sourced from platform-gitops/tenants/{name}/values.yaml in mctl-gitops.
 */
export interface Tenant {
  /** Tenant slug — matches Kubernetes namespace name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Optional description */
  description?: string;
  /** GitHub team slug (for OAuth/ArgoCD RBAC mapping) */
  githubTeam?: string;
  /** Contact email */
  contactEmail?: string;
  /** Quotas as key-value (mirrors Helm values tenant.quotas) */
  quotas: TenantQuotas;
  /** Networking config */
  networking: TenantNetworking;
  /** ISO timestamp of last sync from Git */
  syncedAt: string;
}

export interface TenantQuotas {
  'requests.cpu': string;
  'requests.memory': string;
  'limits.cpu': string;
  'limits.memory': string;
  pods: string;
  persistentvolumeclaims?: string;
  services?: string;
}

export interface TenantNetworking {
  allowIntraNamespace: boolean;
  allowClusterEgress: boolean;
  allowInternetEgress: boolean;
}

/** Input for creating a new tenant (used by POST /tenants) */
export interface CreateTenantRequest {
  tenantName: string;
  displayName: string;
  description?: string;
  githubTeam?: string;
  contactEmail?: string;
  quotaCpuReq?: string;
  quotaCpuLim?: string;
  quotaMemoryReq?: string;
  quotaMemoryLim?: string;
  quotaPods?: string;
  allowInternetEgress?: boolean;
  /** GitHub username of the tenant creator — will be added as owner automatically */
  creatorUserId?: string;
}

// ─── Member management ────────────────────────────────────────────────────────

/** A user's membership in a tenant */
export interface TenantMember {
  tenantName: string;
  /** GitHub username (lowercase) */
  userId: string;
  role: 'owner' | 'developer' | 'viewer';
  invitedAt: string;
  invitedBy: string;
}

/** Input for inviting a user to a tenant */
export interface InviteMemberRequest {
  userId: string;
  role?: 'owner' | 'developer' | 'viewer';
}

/** Input for changing a member's role */
export interface UpdateMemberRoleRequest {
  role: 'owner' | 'developer' | 'viewer';
}

// ─────────────────────────────────────────────────────────────────────────────

/** Parsed structure of platform-gitops/tenants/{name}/values.yaml */
export interface TenantValuesYaml {
  tenant: {
    name: string;
    displayName?: string;
    description?: string;
    githubTeam?: string;
    contactEmail?: string;
    quotas?: Record<string, string>;
    networking?: {
      allowIntraNamespace?: boolean;
      allowClusterEgress?: boolean;
      allowInternetEgress?: boolean;
    };
    /** Optional seed members — synced to DB on startup (add-only, won't remove API-managed members) */
    members?: Array<{
      userId: string;
      role: 'owner' | 'developer' | 'viewer';
    }>;
  };
}
