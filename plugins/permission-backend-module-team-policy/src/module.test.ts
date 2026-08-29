import { AuthorizeResult, createPermission } from '@backstage/plugin-permission-common';
import { PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import { BackstageCredentials } from '@backstage/backend-plugin-api';
import { TeamBasedPermissionPolicy } from './module';

// Regression guard for the fail-open fixes in issue-81: the policy previously
// allowed (1) any request with no resolvable user, and (2) any non-catalog
// permission not otherwise handled. See platform-gitops/agents-state/
// mctl-portal/proposals/issue-81-team-policy-deny-requests-without-a-user/.

function fakeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
}

function fakeUser(ownershipEntityRefs: string[]): PolicyQueryUser {
  const credentials: BackstageCredentials = {
    $$type: '@backstage/BackstageCredentials',
    principal: { type: 'user', userEntityRef: 'user:default/test' },
  } as BackstageCredentials;

  return {
    credentials,
    info: {
      userEntityRef: 'user:default/test',
      ownershipEntityRefs,
    },
  };
}

describe('TeamBasedPermissionPolicy', () => {
  it('denies a request with no resolvable user', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'scaffolder.task.create', attributes: {} }),
    };

    const decision = await policy.handle(request, undefined);

    expect(decision).toEqual({ result: AuthorizeResult.DENY });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('scaffolder.task.create'),
    );
  });

  it('allows an admin-owner user for an arbitrary/unrecognized permission', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'some.unrecognized.permission', attributes: {} }),
    };
    const user = fakeUser(['group:default/admins-owners']);

    const decision = await policy.handle(request, user);

    expect(decision).toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('denies scaffolder.task.create for a viewer user', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'scaffolder.task.create', attributes: {} }),
    };
    const user = fakeUser(['group:default/viewer-acme', 'group:default/acme']);

    const decision = await policy.handle(request, user);

    expect(decision).toEqual({ result: AuthorizeResult.DENY });
  });

  it('returns a conditional decision for a non-viewer member and a catalog-entity permission', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({
        name: 'catalog.entity.read',
        attributes: {},
        resourceType: 'catalog-entity',
      }),
    };
    const user = fakeUser(['group:default/acme']);

    const decision = await policy.handle(request, user);

    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
  });

  it('allows a non-viewer member for a permission in ALLOWED_NON_CATALOG_PERMISSIONS', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'kubernetes.resources.read', attributes: {} }),
    };
    const user = fakeUser(['group:default/acme']);

    const decision = await policy.handle(request, user);

    expect(decision).toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('denies a non-viewer member for an arbitrary unrecognized non-catalog permission', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'notifications.some.unknown.action', attributes: {} }),
    };
    const user = fakeUser(['group:default/acme']);

    const decision = await policy.handle(request, user);

    expect(decision).toEqual({ result: AuthorizeResult.DENY });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('notifications.some.unknown.action'),
    );
  });

  // The allowlist carries load-bearing reasoning (see the doc comment on
  // ALLOWED_NON_CATALOG_PERMISSIONS): each literal is there because a real,
  // in-use portal feature needs it. Assert every entry by name, so silently
  // dropping one — which would break that feature for every non-admin member
  // — fails here rather than in production. The deny cases pin the other
  // edge: names deliberately left out must stay out.
  describe('ALLOWED_NON_CATALOG_PERMISSIONS membership', () => {
    const ALLOWED = [
      'scaffolder.action.execute',
      'scaffolder.task.create',
      'scaffolder.task.read',
      'scaffolder.task.cancel',
      'scaffolder.template.parameter.read',
      'scaffolder.template.step.read',
      'kubernetes.resources.read',
      'kubernetes.clusters.read',
    ];

    // Deliberately absent: template.management is an admin operation,
    // kubernetes.proxy is held back until it shows up in the DENY warn logs,
    // and catalog.entity.create / catalog.location.read are basic (not
    // catalog-entity resource) permissions, so they land here and are denied.
    const DENIED = [
      'scaffolder.template.management',
      'kubernetes.proxy',
      'catalog.entity.create',
      'catalog.location.read',
    ];

    it.each(ALLOWED)('allows %s for a non-viewer member', async name => {
      const policy = new TeamBasedPermissionPolicy(fakeLogger() as any);
      const decision = await policy.handle(
        { permission: createPermission({ name, attributes: {} }) },
        fakeUser(['group:default/acme']),
      );
      expect(decision).toEqual({ result: AuthorizeResult.ALLOW });
    });

    it.each(DENIED)('denies %s for a non-viewer member', async name => {
      const policy = new TeamBasedPermissionPolicy(fakeLogger() as any);
      const decision = await policy.handle(
        { permission: createPermission({ name, attributes: {} }) },
        fakeUser(['group:default/acme']),
      );
      expect(decision).toEqual({ result: AuthorizeResult.DENY });
    });
  });

  it('denies a non-viewer member for catalog.location.create (a basic, not resource, permission)', async () => {
    const logger = fakeLogger();
    const policy = new TeamBasedPermissionPolicy(logger as any);

    const request: PolicyQuery = {
      permission: createPermission({ name: 'catalog.location.create', attributes: {} }),
    };
    const user = fakeUser(['group:default/acme']);

    const decision = await policy.handle(request, user);

    expect(decision).toEqual({ result: AuthorizeResult.DENY });
  });
});
