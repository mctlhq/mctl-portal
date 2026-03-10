import fetch, { RequestInit } from 'node-fetch';

export interface WorkflowSubmitRequest {
  resourceKind: 'WorkflowTemplate' | 'ClusterWorkflowTemplate';
  resourceName: string;
  namespace: string;
  parameters?: string[];  // ["key=value", ...]
  labels?: Record<string, string>;
}

export interface WorkflowStatus {
  name: string;
  namespace: string;
  phase: string;   // Pending | Running | Succeeded | Failed | Error
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: string;
}

export interface WorkflowNode {
  id: string;
  displayName: string;
  type: string;
  phase: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export class ArgoWorkflowsClient {
  private baseUrl: string;
  private token?: string;

  constructor(options: { baseUrl: string; token?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: { ...this.headers(), ...(options?.headers as Record<string, string> || {}) },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Argo Workflows API error ${resp.status} at ${path}: ${body}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  /** Submit a WorkflowTemplate and return the created workflow name */
  async submitWorkflow(req: WorkflowSubmitRequest): Promise<string> {
    const body: Record<string, unknown> = {
      resourceKind: req.resourceKind,
      resourceName: req.resourceName,
      submitOptions: {
        labels: req.labels
          ? Object.entries(req.labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(',')
          : 'submitted-by=backstage',
      },
    };

    if (req.parameters && req.parameters.length > 0) {
      body.submitOptions = {
        ...(body.submitOptions as object),
        parameters: req.parameters,
      };
    }

    const result = await this.request<{ metadata: { name: string } }>(
      `/api/v1/workflows/${req.namespace}/submit`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );

    return result.metadata.name;
  }

  /** Get current workflow status */
  async getWorkflow(namespace: string, name: string): Promise<WorkflowStatus> {
    const result = await this.request<{
      metadata: { name: string; namespace: string };
      status: {
        phase?: string;
        message?: string;
        startedAt?: string;
        finishedAt?: string;
        progress?: string;
        nodes?: Record<string, WorkflowNode>;
      };
    }>(`/api/v1/workflows/${namespace}/${name}`);

    return {
      name: result.metadata.name,
      namespace: result.metadata.namespace,
      phase: result.status.phase ?? 'Unknown',
      message: result.status.message,
      startedAt: result.status.startedAt,
      finishedAt: result.status.finishedAt,
      progress: result.status.progress,
    };
  }

  /** Get workflow node details (individual steps) */
  async getWorkflowNodes(
    namespace: string,
    name: string,
  ): Promise<WorkflowNode[]> {
    const result = await this.request<{
      status: { nodes?: Record<string, WorkflowNode> };
    }>(`/api/v1/workflows/${namespace}/${name}`);

    return Object.values(result.status.nodes ?? {});
  }
}
