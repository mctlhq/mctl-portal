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
