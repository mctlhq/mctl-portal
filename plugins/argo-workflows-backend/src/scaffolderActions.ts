import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Config } from '@backstage/config';
import { ArgoWorkflowsClient, WorkflowStatus } from './argoClient';

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

const TERMINAL_PHASES = ['Succeeded', 'Failed', 'Error'];
const PHASE_ICONS: Record<string, string> = {
  Succeeded: '✅',
  Failed: '❌',
  Error: '❌',
  Running: '🔄',
  Pending: '⏳',
  Skipped: '⏭️',
  Omitted: '⏭️',
};

/** Map Argo node types for display */
function nodeLabel(type: string): string {
  const labels: Record<string, string> = {
    DAG: 'Pipeline',
    Steps: 'Steps',
    StepGroup: 'Step Group',
    Pod: 'Task',
    Skipped: 'Skipped',
    Retry: 'Retry',
    TaskGroup: 'Task Group',
  };
  return labels[type] ?? type;
}

/**
 * Creates the `mctl:workflow:submit` scaffolder action.
 *
 * This action submits an Argo Workflows WorkflowTemplate and polls
 * for completion, streaming step-level status to the Backstage scaffolder UI.
 *
 * Config keys read from app-config:
 *   argoWorkflows:
 *     baseUrl: https://workflows.mctl.me
 *     token: <optional bearer token>
 *     namespace: argo-workflows
 */
export function createSubmitWorkflowAction(options: { config: Config }) {
  const { config } = options;

  return createTemplateAction({
    id: 'mctl:workflow:submit',
    description:
      'Submit an Argo Workflows WorkflowTemplate and stream status to scaffolder output.',
    schema: {
      input: {
        templateName: z =>
          z.string().describe('WorkflowTemplate name (e.g. deploy-service)'),
        clusterScope: z =>
          z
            .boolean()
            .optional()
            .default(true)
            .describe('Use ClusterWorkflowTemplate instead of WorkflowTemplate'),
        namespace: z =>
          z
            .string()
            .optional()
            .describe('Argo Workflows namespace (default from config)'),
        parameters: z =>
          z
            .record(z.string())
            .optional()
            .describe('Workflow parameters as key:value map'),
        waitForCompletion: z =>
          z
            .boolean()
            .optional()
            .default(true)
            .describe('Poll until workflow completes (default: true)'),
        pollIntervalSeconds: z =>
          z
            .number()
            .optional()
            .default(5)
            .describe('Polling interval in seconds (default: 5)'),
        timeoutMinutes: z =>
          z
            .number()
            .optional()
            .default(30)
            .describe('Max wait time in minutes (default: 30)'),
      },
      output: {
        workflowName: z =>
          z.string().optional().describe('Name of the created Argo Workflow'),
        workflowUrl: z =>
          z.string().optional().describe('URL to the Argo Workflows UI'),
        phase: z =>
          z.string().optional().describe('Final workflow phase'),
      },
    },

    async handler(ctx) {
      const baseUrl = config.getString('argoWorkflows.baseUrl');
      const token = config.getOptionalString('argoWorkflows.token');
      const defaultNamespace =
        config.getOptionalString('argoWorkflows.namespace') ?? 'argo-workflows';

      const namespace = (ctx.input.namespace as string | undefined) ?? defaultNamespace;
      const templateName = ctx.input.templateName as string;
      const clusterScope = (ctx.input.clusterScope as boolean) ?? true;
      const parameters = ctx.input.parameters as Record<string, string | null | undefined> | undefined;
      const waitForCompletion = (ctx.input.waitForCompletion as boolean) ?? true;
      const pollInterval = ((ctx.input.pollIntervalSeconds as number) ?? 5) * 1000;
      const timeoutMs = ((ctx.input.timeoutMinutes as number) ?? 30) * 60 * 1000;

      const client = new ArgoWorkflowsClient({ baseUrl, token });

      // Build parameters array: ["key=value", ...]
      // Coerce null/undefined to empty string so Argo API receives all declared params
      const params = parameters
        ? Object.entries(parameters).map(([k, v]) => `${k}=${v ?? ''}`)
        : [];

      // Parameters safe to log (mask secret_env_vars values)
      const SECRET_PARAMS = new Set(['secret_env_vars']);
      const paramsForLog = parameters
        ? Object.entries(parameters).map(([k, v]) => {
            if (SECRET_PARAMS.has(k)) {
              // Show only key names, not values
              const keyNames = (v ?? '')
                .split('\n')
                .map(line => line.split('=')[0].trim())
                .filter(Boolean);
              return keyNames.length > 0
                ? `  ${k}=[${keyNames.map(n => `${n}=****`).join(', ')}]`
                : `  ${k}=(empty)`;
            }
            return `  ${k}=${v ?? ''}`;
          })
        : [];

      const kind = clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate';
      ctx.logger.info(
        `Submitting ${kind} '${templateName}' in namespace '${namespace}'`,
      );
      if (paramsForLog.length > 0) {
        ctx.logger.info(`Parameters:\n${paramsForLog.join('\n')}`);
      }

      // Submit workflow
      let workflowName: string;
      try {
        workflowName = await client.submitWorkflow({
          resourceKind: clusterScope ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate',
          resourceName: templateName,
          namespace,
          parameters: params,
          labels: { 'submitted-by': 'backstage' },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`Failed to submit workflow: ${message}`);
        throw new Error(`Argo Workflows submit failed: ${message}`);
      }

      const workflowUrl = `${baseUrl}/workflows/${namespace}/${workflowName}`;
      ctx.logger.info(`Workflow created: ${workflowName}`);
      ctx.logger.info(`Track progress: ${workflowUrl}`);

      ctx.output('workflowName', workflowName);
      ctx.output('workflowUrl', workflowUrl);

      if (!waitForCompletion) {
        ctx.logger.info('waitForCompletion=false, not polling for status.');
        return;
      }

      // Poll for completion
      ctx.logger.info('Polling for workflow completion...');

      const seenNodes = new Map<string, string>(); // nodeId → last phase
      const startTime = Date.now();
      let lastPhase = '';

      while (true) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(
            `Workflow timed out after ${ctx.input.timeoutMinutes} minutes. ` +
              `Check: ${workflowUrl}`,
          );
        }

        await sleep(pollInterval);

        let status: WorkflowStatus;
        try {
          status = await client.getWorkflow(namespace, workflowName);
        } catch (err) {
          // Transient errors — keep polling
          ctx.logger.warn(`Polling error (will retry): ${err}`);
          continue;
        }

        // Log phase changes
        if (status.phase !== lastPhase) {
          const icon = PHASE_ICONS[status.phase] ?? '•';
          ctx.logger.info(`${icon} Workflow phase: ${status.phase}`);
          lastPhase = status.phase;
        }

        // Log node (step) completions
        try {
          const nodes = await client.getWorkflowNodes(namespace, workflowName);
          for (const node of nodes) {
            // Only leaf tasks (Pods) and skipped nodes
            if (!['Pod', 'Skipped', 'Omitted'].includes(node.type)) continue;
            if (!TERMINAL_PHASES.includes(node.phase) && node.phase !== 'Skipped' && node.phase !== 'Omitted') continue;

            const key = `${node.id}-${node.phase}`;
            if (!seenNodes.has(key)) {
              seenNodes.set(key, node.phase);
              const icon = PHASE_ICONS[node.phase] ?? '•';
              const label = node.displayName || node.id;
              const suffix = node.message ? ` — ${node.message}` : '';
              ctx.logger.info(`  ${icon} [${nodeLabel(node.type)}] ${label}${suffix}`);
            }
          }
        } catch {
          // Node listing is optional — don't fail
        }

        // Check terminal state
        if (TERMINAL_PHASES.includes(status.phase)) {
          ctx.output('phase', status.phase);

          if (status.phase === 'Succeeded') {
            ctx.logger.info('✅ Workflow completed successfully!');
            return;
          }

          const errMsg = status.message
            ? `Workflow ${status.phase}: ${status.message}`
            : `Workflow ${status.phase}`;

          throw new Error(`${errMsg}\nDetails: ${workflowUrl}`);
        }
      }
    },
  });
}
