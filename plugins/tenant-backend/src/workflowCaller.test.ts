import { dirname, join } from 'path';
import { ConfigReader } from '@backstage/config';
import { isTenantWorkflowPrincipal } from './workflowCaller';

it('accepts the static subject returned by the installed Backstage token handler', async () => {
  const root = dirname(require.resolve('@backstage/backend-defaults/package.json'));
  const { staticTokenHandler } = require(join(root, 'dist/entrypoints/auth/external/static.cjs.js'));
  const options = new ConfigReader({ token: 'test-static-workflow-token', subject: 'mctl-api' });
  const context = await staticTokenHandler.initialize({ options });
  const verified = await staticTokenHandler.verifyToken('test-static-workflow-token', context);
  expect(verified).toEqual({ subject: 'mctl-api' });
  expect(isTenantWorkflowPrincipal({ type: 'service', ...verified })).toBe(true);
  expect(await staticTokenHandler.verifyToken('another-token', context)).toBeUndefined();
});

it('refuses other services, plugins, users and absent subjects', () => {
  for (const principal of [
    { type: 'service', subject: 'plugin:tenant-management' },
    { type: 'service', subject: 'external:another-service' },
    { type: 'user', subject: 'mctl-api' },
    { type: 'service' },
  ]) expect(isTenantWorkflowPrincipal(principal)).toBe(false);
  expect(isTenantWorkflowPrincipal({type:'service',subject:'external:mctl-api'})).toBe(true);
});
