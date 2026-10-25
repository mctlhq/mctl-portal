import {
  AuthService,
  coreServices,
  createBackendModule,
  DiscoveryService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';

const TECHDOCS_ANNOTATION = 'backstage.io/techdocs-ref';

export type WarmupOutcome = 'updated' | 'cached';

export interface WarmupResult {
  updated: number;
  cached: number;
  failed: number;
  listFailed: boolean;
}

export interface WarmupDeps {
  listEntities: () => Promise<Entity[]>;
  build: (entity: Entity) => Promise<WarmupOutcome>;
  logger: Pick<LoggerService, 'info' | 'error'>;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Builds the TechDocs site of every entity carrying the techdocs-ref
 * annotation, one at a time. A failure of one entity never stops the run.
 */
export async function runTechdocsWarmup(
  deps: WarmupDeps,
): Promise<WarmupResult> {
  const { listEntities, build, logger } = deps;
  const result: WarmupResult = {
    updated: 0,
    cached: 0,
    failed: 0,
    listFailed: false,
  };

  let entities: Entity[];
  try {
    entities = await listEntities();
  } catch (e) {
    logger.error(`techdocs warm-up: listing catalog failed: ${errorMessage(e)}`);
    return { ...result, listFailed: true };
  }

  const annotated = entities.filter(
    entity => entity.metadata.annotations?.[TECHDOCS_ANNOTATION],
  );

  for (const entity of annotated) {
    const ref = stringifyEntityRef(entity);
    try {
      const outcome = await build(entity);
      if (outcome === 'updated') {
        result.updated += 1;
        logger.info(`techdocs warm-up: ${ref} updated`);
      } else {
        result.cached += 1;
        logger.info(`techdocs warm-up: ${ref} up to date`);
      }
    } catch (e) {
      result.failed += 1;
      logger.error(`techdocs warm-up: ${ref} failed: ${errorMessage(e)}`);
    }
  }

  logger.info(
    `techdocs warm-up finished: ${result.updated} built, ${result.cached} up to date, ${result.failed} failed`,
  );
  return result;
}

/**
 * Calls the techdocs-backend sync route with the backend's own service
 * credentials, so the build goes through the same preparer/generator/publisher
 * chain and per-entity lock as a browser visit.
 *
 * Response contract, read from the installed @backstage/plugin-techdocs-backend
 * 2.2.0 (dist/service/router.cjs.js, createEventStream): once the entity is
 * found the route ALWAYS answers 200 text/event-stream, whatever the Accept
 * header, with `log` events, then one `finish` event whose data is
 * `{"updated":true|false}` or one `error` event whose data is the message,
 * and then ends the response. An unknown entity or a refused caller is a
 * plain non-200 error before the stream starts. The 304 and non-stream 200
 * branches below are kept only so a future techdocs-backend that restores a
 * plain HTTP mode is still handled; 2.2.0 never takes them.
 */
export function createSyncBuilder(options: {
  discovery: DiscoveryService;
  auth: AuthService;
  fetch?: typeof fetch;
  timeoutMs: number;
}): (entity: Entity) => Promise<WarmupOutcome> {
  const { discovery, auth, timeoutMs } = options;
  const doFetch = options.fetch ?? fetch;

  return async entity => {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'techdocs',
    });
    const namespace = entity.metadata.namespace ?? 'default';
    const path = [namespace, entity.kind, entity.metadata.name]
      .map(p => encodeURIComponent(p))
      .join('/');
    const baseUrl = await discovery.getBaseUrl('techdocs');
    const res = await doFetch(`${baseUrl}/sync/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 304) {
      return 'cached';
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`sync returned status ${res.status}: ${body}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      return 'updated';
    }
    const text = await res.text();
    // createEventStream writes LF frames; CRLF is accepted as well.
    const events = text.split(/\r?\n\r?\n/);
    for (const block of events) {
      const event = /^event:[ \t]*(.*?)\r?$/m.exec(block)?.[1]?.trim();
      const data = /^data:[ \t]*(.*?)\r?$/m.exec(block)?.[1] ?? '';
      if (event === 'error') {
        throw new Error(`sync failed: ${data.slice(0, 200)}`);
      }
      if (event === 'finish') {
        return /updated"?\s*:\s*true/.test(data) ? 'updated' : 'cached';
      }
    }
    throw new Error('sync stream ended without a finish event');
  };
}

export const techdocsWarmupModule = createBackendModule({
  pluginId: 'techdocs',
  moduleId: 'warmup',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
      },
      async init({ logger, scheduler, discovery, auth, config, catalog }) {
        if (config.getOptionalBoolean('techdocs.warmup.enabled') === false) {
          logger.info('techdocs warm-up disabled by configuration');
          return;
        }
        if ((config.getOptionalString('techdocs.builder') ?? 'local') !== 'local') {
          logger.info('techdocs warm-up skipped: builder is not local');
          return;
        }
        const initialDelaySeconds =
          config.getOptionalNumber('techdocs.warmup.initialDelaySeconds') ?? 60;
        const frequencyMinutes =
          config.getOptionalNumber('techdocs.warmup.frequencyMinutes') ?? 30;
        const entityTimeoutSeconds =
          config.getOptionalNumber('techdocs.warmup.entityTimeoutSeconds') ??
          300;

        const build = createSyncBuilder({
          discovery,
          auth,
          timeoutMs: entityTimeoutSeconds * 1000,
        });

        // Scheduled only; nothing is awaited here, so readiness is unaffected.
        // Scope 'local': every replica has its own ephemeral publish dir.
        await scheduler.scheduleTask({
          id: 'techdocs-warmup',
          scope: 'local',
          frequency: { minutes: frequencyMinutes },
          initialDelay: { seconds: initialDelaySeconds },
          timeout: { minutes: 60 },
          fn: async () => {
            await runTechdocsWarmup({
              logger,
              build,
              listEntities: async () => {
                // Annotation filtering is done in runTechdocsWarmup; fields
                // keep the payload small.
                const { items } = await catalog.getEntities(
                  {
                    fields: [
                      'kind',
                      'metadata.namespace',
                      'metadata.name',
                      'metadata.annotations',
                    ],
                  },
                  { credentials: await auth.getOwnServiceCredentials() },
                );
                return items;
              },
            });
          },
        });
      },
    });
  },
});
