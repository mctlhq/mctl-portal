import { KubeConfig, CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import { LoggerService } from '@backstage/backend-plugin-api';
import { NamespaceUsage, PodUsage, QuotaMetric } from './types';

// ── Simple TTL cache ──────────────────────────────────────────────────────────

class TtlCache<T> {
  private readonly cache = new Map<string, { data: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }
}

// ── Resource parsing helpers ──────────────────────────────────────────────────

/** Parse CPU string (e.g. "100m", "1.5", "500000000n") to millicores */
function parseCpuMillicores(cpu: string): number {
  if (!cpu) return 0;
  if (cpu.endsWith('n')) return Math.round(parseInt(cpu.slice(0, -1), 10) / 1_000_000);
  if (cpu.endsWith('u')) return Math.round(parseInt(cpu.slice(0, -1), 10) / 1_000);
  if (cpu.endsWith('m')) return parseInt(cpu.slice(0, -1), 10);
  return Math.round(parseFloat(cpu) * 1000);
}

/** Parse memory string (e.g. "256Mi", "1Gi", "512Ki") to bytes */
function parseMemoryBytes(mem: string): number {
  if (!mem) return 0;
  const units: Array<[string, number]> = [
    ['Ti', 1024 ** 4],
    ['Gi', 1024 ** 3],
    ['Mi', 1024 ** 2],
    ['Ki', 1024],
    ['T', 1000 ** 4],
    ['G', 1000 ** 3],
    ['M', 1000 ** 2],
    ['K', 1000],
  ];
  for (const [suffix, multiplier] of units) {
    if (mem.endsWith(suffix)) {
      return Math.round(parseFloat(mem.slice(0, -suffix.length)) * multiplier);
    }
  }
  return parseInt(mem, 10);
}

/** Format millicores to human-readable CPU string */
function formatCpu(mc: number): string {
  if (mc === 0) return '0';
  if (mc >= 1000) return `${(mc / 1000).toFixed(2)}`;
  return `${mc}m`;
}

/** Format bytes to human-readable memory string */
function formatMemory(bytes: number): string {
  if (bytes === 0) return '0';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}Mi`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}Ki`;
  return `${bytes}`;
}

function makeQuotaMetric(usedRaw: number, limitRaw: number, formatter: (n: number) => string): QuotaMetric {
  const usedPct = limitRaw > 0 ? Math.min(100, Math.round((usedRaw / limitRaw) * 100)) : 0;
  return {
    used: formatter(usedRaw),
    limit: formatter(limitRaw),
    usedRaw,
    limitRaw,
    usedPct,
  };
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface K8sClientOptions {
  logger: LoggerService;
  /** 'inCluster' = pod SA token, 'default' = ~/.kube/config, 'token' = explicit token+url */
  kubeConfigType: 'inCluster' | 'default' | 'token';
  kubeApiUrl?: string;
  kubeToken?: string;
  skipTLSVerify?: boolean;
  cacheTtlMs?: number;
}

export class KubernetesUsageClient {
  private readonly logger: LoggerService;
  private readonly coreApi: CoreV1Api;
  private readonly customApi: CustomObjectsApi;
  private readonly usageCache = new TtlCache<NamespaceUsage>();
  private readonly podsCache = new TtlCache<PodUsage[]>();
  private readonly cacheTtlMs: number;

  constructor(opts: K8sClientOptions) {
    this.logger = opts.logger;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;

    const kc = new KubeConfig();

    if (opts.kubeConfigType === 'inCluster') {
      kc.loadFromCluster();
    } else if (opts.kubeConfigType === 'token' && opts.kubeApiUrl && opts.kubeToken) {
      kc.loadFromOptions({
        clusters: [{
          name: 'cluster',
          server: opts.kubeApiUrl,
          skipTLSVerify: opts.skipTLSVerify ?? false,
        }],
        users: [{ name: 'backstage', token: opts.kubeToken }],
        contexts: [{ name: 'cluster', cluster: 'cluster', user: 'backstage' }],
        currentContext: 'cluster',
      });
    } else {
      kc.loadFromDefault();
    }

    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.customApi = kc.makeApiClient(CustomObjectsApi);
  }

  async getNamespaceUsage(namespace: string): Promise<NamespaceUsage> {
    const cached = this.usageCache.get(namespace);
    if (cached) return cached;

    const [quotaResult, metricsResult] = await Promise.allSettled([
      this.coreApi.listNamespacedResourceQuota(namespace),
      this.customApi.listNamespacedCustomObject('metrics.k8s.io', 'v1beta1', namespace, 'pods'),
    ]);

    // ── Build quota map ────────────────────────────────────────────────────────
    const quotaMap: Record<string, { usedRaw: number; limitRaw: number }> = {};

    if (quotaResult.status === 'fulfilled') {
      for (const q of quotaResult.value.body.items) {
        const hard = q.status?.hard ?? {};
        const used = q.status?.used ?? {};

        const resources = [
          'requests.cpu', 'limits.cpu',
          'requests.memory', 'limits.memory',
          'pods',
        ] as const;

        for (const res of resources) {
          if (hard[res]) {
            if (!quotaMap[res]) quotaMap[res] = { usedRaw: 0, limitRaw: 0 };
            const isCpu = res.includes('cpu');
            const isMem = res.includes('memory');
            const parser = isCpu ? parseCpuMillicores : isMem ? parseMemoryBytes : parseInt;
            quotaMap[res].limitRaw += (parser as any)(hard[res]);
            if (used[res]) quotaMap[res].usedRaw += (parser as any)(used[res]);
          }
        }
      }
    } else {
      this.logger.warn(`[resource-usage] ResourceQuota fetch failed for ${namespace}: ${quotaResult.reason}`);
    }

    // ── Build live pod metrics ─────────────────────────────────────────────────
    let liveUsage: NamespaceUsage['liveUsage'] = null;

    if (metricsResult.status === 'fulfilled') {
      const metricsBody = (metricsResult.value as any).body ?? metricsResult.value;
      let cpuRaw = 0;
      let memoryRaw = 0;
      let podCount = 0;

      for (const pod of (metricsBody.items ?? [])) {
        podCount++;
        for (const c of (pod.containers ?? [])) {
          cpuRaw += parseCpuMillicores(c.usage?.cpu ?? '0');
          memoryRaw += parseMemoryBytes(c.usage?.memory ?? '0');
        }
      }

      liveUsage = {
        cpu: formatCpu(cpuRaw),
        memory: formatMemory(memoryRaw),
        podCount,
        cpuRaw,
        memoryRaw,
      };
    } else {
      this.logger.debug(`[resource-usage] metrics-server unavailable for ${namespace}: ${metricsResult.reason}`);
    }

    // ── Assemble result ────────────────────────────────────────────────────────
    const quota: NamespaceUsage['quota'] = {};

    if (quotaMap['requests.cpu']) {
      quota['requests.cpu'] = makeQuotaMetric(
        quotaMap['requests.cpu'].usedRaw,
        quotaMap['requests.cpu'].limitRaw,
        formatCpu,
      );
    }
    if (quotaMap['limits.cpu']) {
      quota['limits.cpu'] = makeQuotaMetric(
        quotaMap['limits.cpu'].usedRaw,
        quotaMap['limits.cpu'].limitRaw,
        formatCpu,
      );
    }
    if (quotaMap['requests.memory']) {
      quota['requests.memory'] = makeQuotaMetric(
        quotaMap['requests.memory'].usedRaw,
        quotaMap['requests.memory'].limitRaw,
        formatMemory,
      );
    }
    if (quotaMap['limits.memory']) {
      quota['limits.memory'] = makeQuotaMetric(
        quotaMap['limits.memory'].usedRaw,
        quotaMap['limits.memory'].limitRaw,
        formatMemory,
      );
    }
    if (quotaMap['pods']) {
      quota['pods'] = makeQuotaMetric(
        quotaMap['pods'].usedRaw,
        quotaMap['pods'].limitRaw,
        n => String(n),
      );
    }

    const result: NamespaceUsage = { namespace, quota, liveUsage };
    this.usageCache.set(namespace, result, this.cacheTtlMs);
    return result;
  }

  async getPodUsage(namespace: string): Promise<PodUsage[]> {
    const cached = this.podsCache.get(namespace);
    if (cached) return cached;

    try {
      const resp = await this.customApi.listNamespacedCustomObject(
        'metrics.k8s.io', 'v1beta1', namespace, 'pods',
      ) as any;
      const metricsBody = resp.body ?? resp;

      const pods: PodUsage[] = (metricsBody.items ?? []).map((pod: any) => {
        let cpuRaw = 0;
        let memoryRaw = 0;
        for (const c of (pod.containers ?? [])) {
          cpuRaw += parseCpuMillicores(c.usage?.cpu ?? '0');
          memoryRaw += parseMemoryBytes(c.usage?.memory ?? '0');
        }
        return {
          name: pod.metadata.name as string,
          cpu: formatCpu(cpuRaw),
          memory: formatMemory(memoryRaw),
          cpuRaw,
          memoryRaw,
        };
      });

      this.podsCache.set(namespace, pods, this.cacheTtlMs);
      return pods;
    } catch (err) {
      this.logger.warn(`[resource-usage] Pod metrics fetch failed for ${namespace}: ${err}`);
      return [];
    }
  }
}
