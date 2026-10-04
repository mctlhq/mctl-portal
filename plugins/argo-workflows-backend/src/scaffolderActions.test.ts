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
function fakeDb(memberships: Record<string, string>): Knex {
  const db: any = jest.fn((_table: string) => {
    const builder: any = {
      withSchema: jest.fn().mockReturnThis(),
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
  db.client = { config: { client: 'better-sqlite3' } };
  return db as Knex;
}

const MEMBERSHIPS = {
  'labs:carol': 'developer',
  'karabu:kim': 'owner',
  'labs:vera': 'viewer',
  'admins:root': 'owner',
};

const action = createSubmitWorkflowAction({
  config: new ConfigReader({
    argoWorkflows: { baseUrl: 'https://workflows.example.invalid', namespace: 'argo-workflows' },
  }),
  database: { getClient: async () => fakeDb(MEMBERSHIPS) } as any,
});

function run(user: string | undefined, input: Record<string, unknown>) {
  const ctx: any = {
    input: { templateName: 'deploy-service', waitForCompletion: false, ...input },
    user: user ? { ref: user } : undefined,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
  };
  return action.handler(ctx);
}

// The deploy-component template passes the chosen team as both the Argo
// namespace and team_name.
const deployInto = (team: string) => ({ namespace: team, parameters: { team_name: team } });

beforeEach(() => submitWorkflow.mockClear());

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
    ).rejects.toThrow(/team "karabu"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("refuses another team's Argo namespace even when team_name is the caller's own", async () => {
    await expect(
      run('user:default/carol', { namespace: 'karabu', parameters: { team_name: 'labs' } }),
    ).rejects.toThrow(/team "karabu"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses tenant_name targets the caller does not belong to', async () => {
    await expect(
      run('user:default/carol', {
        templateName: 'delete-tenant',
        parameters: { tenant_name: 'karabu' },
      }),
    ).rejects.toThrow(/team "karabu"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a viewer of the target team', async () => {
    await expect(run('user:default/vera', deployInto('labs'))).rejects.toThrow(/team "labs"/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a platform-wide submission by a non-admin', async () => {
    await expect(
      run('user:default/carol', { templateName: 'mctl-agents-run', parameters: {} }),
    ).rejects.toThrow(/does not target a team/);
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

  it('lets an owner deploy into their own team', async () => {
    await run('user:default/kim', deployInto('karabu'));
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('lets a platform admin submit anywhere, including platform-wide workflows', async () => {
    await run('user:default/root', deployInto('karabu'));
    await run('user:default/root', { templateName: 'mctl-agents-run', parameters: {} });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
  });
});
