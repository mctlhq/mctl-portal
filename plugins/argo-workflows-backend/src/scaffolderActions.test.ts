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

function fakeDb(memberships: Record<string, string>, client = 'better-sqlite3'): Knex {
  const db: any = jest.fn((_table: string) => {
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
