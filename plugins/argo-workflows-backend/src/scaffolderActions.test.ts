import type { Knex } from 'knex';
import { ConfigReader } from '@backstage/config';
import { createSubmitWorkflowAction } from './scaffolderActions';

// mctl:workflow:submit talks to Argo with the portal's own token, so the
// action itself must refuse submissions that target a team the initiating
// user does not belong to. These drive the real handler with a stubbed Argo
// client and check whether anything reaches Argo.

const submitWorkflow = jest.fn(async () => 'wf-123');
jest.mock('./argoClient', () => ({
  ArgoWorkflowsClient: jest.fn().mockImplementation(() => ({
    submitWorkflow,
    getWorkflow: jest.fn(),
    getWorkflowNodes: jest.fn(),
  })),
}));

// Mirrors getTenantMember's real query shape: db('tenant_members')
// [.withSchema(...) on Postgres].where({ tenant_name, user_id }).first()
const withSchema = jest.fn();

type Binding = { team_id: string; repo_full_name: string; created_by: string };

// Also mirrors isRepoBoundToTeam's db('repo_connections')[.withSchema()]
// .where({ team_id }).andWhereRaw(lower(repo) = ?).andWhere(<created_by
// prefixes>).first().
function fakeDb(
  memberships: Record<string, string>,
  client = 'better-sqlite3',
  bindings: Binding[] | 'error' = [],
): Knex {
  const db: any = jest.fn((table: string) => {
    if (table === 'repo_connections') {
      const q: any = { prefixes: [] as string[] };
      const b: any = {
        withSchema: jest.fn().mockReturnThis(),
        where(cond: { team_id: string }) {
          q.team = cond.team_id;
          return b;
        },
        andWhereRaw(_sql: string, [repo]: string[]) {
          q.repo = repo;
          return b;
        },
        andWhere(fn: (w: any) => void) {
          const w: any = {
            orWhere(_col: string, _op: string, pattern: string) {
              q.prefixes.push(pattern.replace(/%$/, ''));
              return w;
            },
          };
          fn(w);
          return b;
        },
        async first() {
          if (bindings === 'error') throw new Error('connection refused');
          return bindings.find(
            r =>
              r.team_id === q.team &&
              r.repo_full_name.toLowerCase() === q.repo &&
              q.prefixes.some((p: string) => r.created_by.startsWith(p)),
          );
        },
      };
      return b;
    }
    const builder: any = {
      withSchema: withSchema.mockImplementation(() => builder),
      where(cond: { tenant_name: string; user_id: string }) {
        builder._cond = cond;
        return builder;
      },
      async first() {
        const role = memberships[`${builder._cond.tenant_name}:${builder._cond.user_id}`];
        return role
          ? { tenant_name: builder._cond.tenant_name, user_id: builder._cond.user_id, role }
          : undefined;
      },
    };
    return builder;
  });
  db.client = { config: { client } };
  return db as Knex;
}

const MEMBERSHIPS = {
  'labs:carol': 'developer',
  'karabu:kim': 'owner',
  'labs:vera': 'viewer',
  'admins:root': 'owner',
};

const makeAction = (client?: string) =>
  createSubmitWorkflowAction({
    config: new ConfigReader({
      argoWorkflows: { baseUrl: 'https://workflows.example.invalid', namespace: 'argo-workflows' },
    }),
    database: { getClient: async () => fakeDb(MEMBERSHIPS, client) } as any,
  });
const action = makeAction();

function run(user: string | undefined, input: Record<string, unknown>, act = action) {
  const ctx: any = {
    input: { templateName: 'deploy-service', waitForCompletion: false, ...input },
    user: user ? { ref: user } : undefined,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
  };
  return act.handler(ctx);
}

// The deploy-component template passes the chosen team as both the Argo
// namespace and team_name.
const deployInto = (team: string) => ({ namespace: team, parameters: { team_name: team } });

beforeEach(() => {
  submitWorkflow.mockClear();
  withSchema.mockClear();
});

describe('mctl:workflow:submit authorization', () => {
  it("refuses a tenant member deploying into another tenant's namespace", async () => {
    await expect(run('user:default/carol', deployInto('karabu'))).rejects.toThrow(
      /not a developer or owner of team "karabu"/,
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a mismatched team_name even when the namespace is the caller\'s own', async () => {
    await expect(
      run('user:default/carol', { namespace: 'labs', parameters: { team_name: 'karabu' } }),
    ).rejects.toThrow(/team_name "karabu" does not match the team namespace "labs"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("refuses another team's Argo namespace even when team_name is the caller's own", async () => {
    await expect(
      run('user:default/carol', { namespace: 'karabu', parameters: { team_name: 'labs' } }),
    ).rejects.toThrow(/does not match the team namespace "karabu"/);
    // and with no parameters at all, membership of the namespace decides
    await expect(run('user:default/carol', { namespace: 'karabu' })).rejects.toThrow(/team "karabu"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses tenant_name targets other than the team namespace', async () => {
    await expect(
      run('user:default/carol', {
        templateName: 'provision-database',
        namespace: 'labs',
        parameters: { tenant_name: 'karabu' },
      }),
    ).rejects.toThrow(/tenant_name "karabu" does not match/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a non-admin in the default namespace even with their own team_name", async () => {
    await expect(
      run('user:default/carol', { namespace: 'argo-workflows', parameters: { team_name: 'labs' } }),
    ).rejects.toThrow(/namespace "argo-workflows" is not a team namespace/);
    // no namespace input falls back to the default one
    await expect(
      run('user:default/carol', { parameters: { team_name: 'labs' } }),
    ).rejects.toThrow(/not a team namespace/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses platform-wide templates to a non-admin whatever the parameters say', async () => {
    for (const templateName of ['mctl-agents-run', 'bootstrap-platform', 'platform-skill-publish']) {
      await expect(
        run('user:default/carol', { templateName, ...deployInto('labs') }),
      ).rejects.toThrow(/is not one a team may run/);
    }
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses tenant-scoped templates outside the team list to a non-admin', async () => {
    for (const templateName of ['delete-tenant', 'create-tenant', 'add-custom-domain']) {
      await expect(
        run('user:default/kim', { templateName, ...deployInto('karabu') }),
      ).rejects.toThrow(/is not one a team may run/);
    }
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a namespaced WorkflowTemplate to a non-admin', async () => {
    await expect(
      run('user:default/carol', { clusterScope: false, ...deployInto('labs') }),
    ).rejects.toThrow(/is not one a team may run/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an initiator that is not a user entity', async () => {
    await expect(run('group:default/labs', deployInto('labs'))).rejects.toThrow(/no initiating user/);
    await expect(run('user:other/carol', deployInto('labs'))).rejects.toThrow(/no initiating user/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a viewer of the target team', async () => {
    await expect(run('user:default/vera', deployInto('labs'))).rejects.toThrow(/team "labs"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a platform-wide submission by a non-admin', async () => {
    await expect(
      run('user:default/carol', { templateName: 'mctl-agents-run', parameters: {} }),
    ).rejects.toThrow(/is not one a team may run/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a task without an initiating user', async () => {
    await expect(run(undefined, deployInto('labs'))).rejects.toThrow(/no initiating user/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets a developer deploy into their own team', async () => {
    await run('user:default/carol', deployInto('labs'));
    expect(submitWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'labs', parameters: ['team_name=labs'] }),
    );
  });

  it('lets a developer retire a service and provision a database in their own team', async () => {
    await run('user:default/carol', { templateName: 'retire-service', ...deployInto('labs') });
    await run('user:default/carol', {
      templateName: 'provision-database',
      namespace: 'labs',
      parameters: { team_name: 'labs', app_name: 'api' },
    });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
  });

  it('accepts a differently-cased user kind', async () => {
    await run('User:default/carol', deployInto('labs'));
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('qualifies the membership lookup on every Postgres client name', async () => {
    for (const client of ['pg', 'postgres', 'postgresql']) {
      withSchema.mockClear();
      await run('user:default/carol', deployInto('labs'), makeAction(client));
      expect(withSchema).toHaveBeenCalled();
    }
    withSchema.mockClear();
    await run('user:default/carol', deployInto('labs'));
    expect(withSchema).not.toHaveBeenCalled();
  });

  it('treats a blank team_name as absent, so namespace membership still decides', async () => {
    await run('user:default/carol', { namespace: 'labs', parameters: { team_name: '  ' } });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    await expect(
      run('user:default/carol', { namespace: 'karabu', parameters: { team_name: '' } }),
    ).rejects.toThrow(/not a developer or owner of team "karabu"/);
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('lets an owner deploy into their own team', async () => {
    await run('user:default/kim', deployInto('karabu'));
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('lets a platform admin submit anywhere, including platform-wide workflows', async () => {
    await run('user:default/root', deployInto('karabu'));
    await run('user:default/root', { templateName: 'mctl-agents-run', parameters: {} });
    await run('user:default/root', { templateName: 'create-tenant', parameters: { tenant_name: 'new' } });
    expect(submitWorkflow).toHaveBeenCalledTimes(3);
  });
});

describe('mctl:workflow:submit build repository', () => {
  // As the one-time migration leaves them: a reviewed pre-cutoff row, a
  // verified newer row, an unverified row, and another team's row.
  const BINDINGS: Binding[] = [
    { team_id: 'labs', repo_full_name: 'mashkovd/kuptsi-v2', created_by: 'legacy:sync' },
    { team_id: 'labs', repo_full_name: 'carol/tool', created_by: 'popup:carol' },
    { team_id: 'labs', repo_full_name: 'victim-org/unverified', created_by: 'sync' },
    { team_id: 'karabu', repo_full_name: 'karabu-org/private', created_by: 'sync:kim' },
  ];
  const PUBLIC = new Set(['openclaw/openclaw']);
  let fetchSpy: jest.SpyInstance;
  let publicAnswer: (repo: string) => { status: number; body: unknown };

  function actionWith(bindings: Binding[] | 'error' = BINDINGS) {
    return createSubmitWorkflowAction({
      config: new ConfigReader({
        argoWorkflows: { baseUrl: 'https://workflows.example.invalid', namespace: 'argo-workflows' },
      }),
      database: { getClient: async () => fakeDb(MEMBERSHIPS, undefined, bindings) } as any,
    });
  }

  function deploy(user: string, team: string, repo: string, bindings?: Binding[] | 'error') {
    const ctx: any = {
      input: {
        templateName: 'deploy-service',
        waitForCompletion: false,
        namespace: team,
        parameters: { action: 'onboard', team_name: team, dockerfile_repo: repo },
      },
      user: { ref: user },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      output: jest.fn(),
    };
    return actionWith(bindings).handler(ctx);
  }

  beforeEach(() => {
    publicAnswer = repo =>
      PUBLIC.has(repo)
        ? { status: 200, body: { private: false } }
        : { status: 404, body: { message: 'Not Found' } };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const repo = String(url).replace('https://api.github.com/repos/', '');
      const { status, body } = publicAnswer(repo);
      return { status, ok: status < 300, json: async () => body } as any;
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it('still deploys a repo bound before the cutoff (legacy row after the migration)', async () => {
    await deploy('user:default/carol', 'labs', 'mashkovd/kuptsi-v2');
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deploys a repo bound by a verified flow', async () => {
    await deploy('user:default/carol', 'labs', 'carol/tool');
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses a private repo that is not connected to the team', async () => {
    await expect(deploy('user:default/carol', 'labs', 'victim-org/secret')).rejects.toThrow(
      /not connected to team "labs" and is not public/,
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("refuses another team's connected repo", async () => {
    await expect(deploy('user:default/carol', 'labs', 'karabu-org/private')).rejects.toThrow(/not connected/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('ignores an unverified binding row', async () => {
    await expect(deploy('user:default/carol', 'labs', 'victim-org/unverified')).rejects.toThrow(/not connected/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('allows an unconnected repo that GitHub reports public', async () => {
    await deploy('user:default/carol', 'labs', 'openclaw/openclaw');
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rate-limited', { status: 403, body: { message: 'rate limit' } }],
    ['erroring', { status: 502, body: {} }],
    ['missing the private flag', { status: 200, body: {} }],
    ['private', { status: 200, body: { private: true } }],
    ['a non-200 answer whose body claims public', { status: 203, body: { private: false } }],
  ])('refuses when the public check is %s', async (_label, answer) => {
    publicAnswer = () => answer;
    await expect(deploy('user:default/carol', 'labs', 'victim-org/secret')).rejects.toThrow(/not public/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when the binding lookup fails', async () => {
    await expect(deploy('user:default/carol', 'labs', 'carol/tool', 'error')).rejects.toThrow(/connection refused/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(['../etc', 'owner', 'a/b/c', 'owner/..'])('refuses a malformed repo %p', async repo => {
    await expect(deploy('user:default/carol', 'labs', repo)).rejects.toThrow(/not a GitHub repository name/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets a platform admin build any repo', async () => {
    await deploy('user:default/root', 'labs', 'victim-org/secret');
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('mctl:workflow:submit image name', () => {
  // deploy-service builds into and runs ghcr.io/mctlhq/<component_name>, so
  // a team may not take another team's component name, nor a new mctl- name.
  const COMPONENTS = [
    { metadata: { name: 'shop', labels: { team: 'karabu' } }, spec: { owner: 'group:default/karabu' } },
    { metadata: { name: 'cart' }, spec: { owner: 'group:default/karabu' } },
    { metadata: { name: 'mctl-telegram', labels: { team: 'labs' } }, spec: { owner: 'labs' } },
  ];
  const getEntities = jest.fn();
  const auth = { getOwnServiceCredentials: jest.fn(async () => ({ principal: { type: 'service' } })) };

  function actionWith(withCatalog = true) {
    return createSubmitWorkflowAction({
      config: new ConfigReader({
        argoWorkflows: { baseUrl: 'https://workflows.example.invalid', namespace: 'argo-workflows' },
      }),
      database: { getClient: async () => fakeDb(MEMBERSHIPS) } as any,
      ...(withCatalog ? { catalog: { getEntities } as any, auth: auth as any } : {}),
    });
  }

  function onboard(user: string, component: string, act = actionWith()) {
    const ctx: any = {
      input: {
        templateName: 'deploy-service',
        waitForCompletion: false,
        namespace: 'labs',
        parameters: { action: 'onboard', team_name: 'labs', component_name: component },
      },
      user: { ref: user },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      output: jest.fn(),
    };
    return act.handler(ctx);
  }

  beforeEach(() => {
    getEntities.mockReset();
    getEntities.mockImplementation(async (req: any) => ({
      items: COMPONENTS.filter(c => c.metadata.name === req.filter['metadata.name']),
    }));
  });

  it.each([
    ['shop', /belongs to team "karabu"/],
    ['cart', /belongs to team "karabu"/], // owner taken from spec.owner
    ['mctl-api', /reserved for the platform/],
  ])('refuses %s to another team', async (component, message) => {
    await expect(onboard('user:default/carol', component)).rejects.toThrow(message);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("allows a team's own mctl- component and a new name", async () => {
    await onboard('user:default/carol', 'mctl-telegram');
    await onboard('user:default/carol', 'brand-new');
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
  });

  it('reads the catalog with the plugin credentials, not the user', async () => {
    await onboard('user:default/carol', 'brand-new');
    expect(auth.getOwnServiceCredentials).toHaveBeenCalled();
    expect(getEntities).toHaveBeenCalledWith(
      { filter: { kind: 'Component', 'metadata.name': 'brand-new' } },
      { credentials: { principal: { type: 'service' } } },
    );
  });

  it('refuses when the catalog lookup fails', async () => {
    getEntities.mockRejectedValue(new Error('catalog unavailable'));
    await expect(onboard('user:default/carol', 'brand-new')).rejects.toThrow(/catalog unavailable/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when the catalog is not wired in', async () => {
    await expect(onboard('user:default/carol', 'brand-new', actionWith(false))).rejects.toThrow(
      /catalog is not available/,
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets a platform admin use any name', async () => {
    await onboard('user:default/root', 'mctl-api');
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(getEntities).not.toHaveBeenCalled();
  });
});
