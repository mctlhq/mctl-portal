export interface QuotaMetric {
  /** Human-readable used value (e.g. "1500m", "2Gi") */
  used: string;
  /** Human-readable hard limit (e.g. "8000m", "16Gi") */
  limit: string;
  /** Numeric used value (millicores for CPU, bytes for memory, count for pods) */
  usedRaw: number;
  /** Numeric hard limit (same units as usedRaw) */
  limitRaw: number;
  /** Used percentage 0–100 */
  usedPct: number;
}

export interface NamespaceUsage {
  namespace: string;
  /** ResourceQuota hard/used data, keyed by quota resource name */
  quota: {
    'requests.cpu'?: QuotaMetric;
    'limits.cpu'?: QuotaMetric;
    'requests.memory'?: QuotaMetric;
    'limits.memory'?: QuotaMetric;
    pods?: QuotaMetric;
  };
  /** Real-time pod metrics from metrics-server (null if unavailable) */
  liveUsage: {
    cpu: string;       // e.g. "500m"
    memory: string;    // e.g. "1.5Gi"
    podCount: number;
    cpuRaw: number;    // millicores
    memoryRaw: number; // bytes
  } | null;
}

export interface PodUsage {
  name: string;
  cpu: string;       // e.g. "125m"
  memory: string;    // e.g. "256Mi"
  cpuRaw: number;    // millicores
  memoryRaw: number; // bytes
}
