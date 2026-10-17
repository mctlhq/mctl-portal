import { CatalogKey } from './memberKeys';

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
  /**
   * GitHub login of the tenant creator, added as owner. From the landing
   * page: anyone's (legacy GitHub OAuth flow). From the portal: only the
   * caller's own.
   */
  creatorUserId?: string;
  /**
   * Landing page only: the mctl-web site's ZITADEL ID token of a
   * self-service customer, who becomes the owner keyed by principal (stage
   * C2). Exclusive with creatorUserId.
   */
  creatorIdToken?: string;
}

// ─── Member management ────────────────────────────────────────────────────────

/** A user's membership in a tenant */
export interface TenantMember {
  tenantName: string;
  /**
   * The catalog User name: the GitHub login (lowercase) for a login-keyed
   * member, the lowercased principal id for a principal-keyed one.
   */
  userId: string;
  role: 'owner' | 'developer' | 'viewer';
  invitedAt: string;
  invitedBy: string;
  /** How userId was chosen; absent means 'login' (see memberKeys.ts). */
  catalogKey?: CatalogKey;
  /** The canonical principal id, when values.yaml names one. */
  principalId?: string;
  /** A principal-keyed member's GitHub login, for display only. */
  login?: string;
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
    quotas?: Record<string, string>;
    networking?: {
      allowIntraNamespace?: boolean;
      allowClusterEgress?: boolean;
      allowInternetEgress?: boolean;
    };
    /** Optional seed members — synced to DB on startup (add-only, won't remove API-managed members) */
    members?: Array<{
      userId?: string;
      principalId?: string;
      role: 'owner' | 'developer' | 'viewer';
      catalogKey?: CatalogKey;
    }>;
  };
}
