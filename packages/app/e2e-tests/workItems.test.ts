import { expect, Page, test } from '@playwright/test';

/**
 * T13 (mctl-portal#126): a deep link to a work item renders the header and the
 * Pending panel on desktop, and a single column on a mobile viewport.
 *
 * Every backend call is stubbed in the browser, so neither the portal backend
 * nor mctl-api has to run: the GitHub session refresh returns a fake user and
 * the work-items route returns a fixture shaped like the plugin's response.
 */

const WORK_ITEM_ID = 'wi_0b6f2c1e-7d3a-4c55-9a1e-2f6b8e9d0c11';

const unknownRelay = { state: 'unknown', reason: 'not_available_via_relay' };
const WORK_ITEM = {
  id: WORK_ITEM_ID,
  title: 'E2E work item',
  state: 'waiting',
  waitingReason: 'input',
  stateVersion: 3,
  tenant: 'acme',
  visibility: 'tenant',
  originSurface: 'telegram',
  latestExecution: { state: 'ok', value: { id: 'we_1', attempt: 1, phase: 'Succeeded' } },
  latestSnapshot: { state: 'ok', value: null },
  executionRequests: {
    state: 'ok',
    value: [{ id: 'xr_1', kind: 'resume', state: 'pending' }],
    observedAt: '2026-10-03T00:00:00Z',
  },
  executions: { state: 'ok', value: [{ id: 'we_1', attempt: 1, phase: 'Succeeded' }] },
  // Full-length hashes and ids: unbreakable tokens the mobile scrollWidth
  // check below must still fit.
  snapshots: {
    state: 'ok',
    value: [
      {
        id: 'cs_9f86d081884c7d659a2feaa0c55ad015',
        executionId: 'we_1',
        contentHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        executionSequence: 1,
        strategy: 'devloop',
        strategyVersion: '3',
        createdAt: '2026-10-03T00:00:00Z',
      },
    ],
  },
  evidence: {
    state: 'ok',
    value: [
      {
        id: 'ev_60303ae22b998861bce3b28f33eec1be',
        contentHash: 'sha256:60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752',
        primaryRefKind: 'runtime',
        primaryRefId: 'ex-0123456789abcdef',
        apiVersion: 'evidence/v1',
        createdAt: '2026-10-03T00:00:00Z',
      },
    ],
  },
  events: { state: 'ok', value: [{ seq: 1, kind: 'created', toState: 'active', surface: 'telegram' }] },
  surfaces: unknownRelay,
  links: [],
  actionsEnabled: false,
};

function fakeJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user:default/e2e', ent: ['user:default/e2e'], exp })}.sig`;
}

async function stubBackend(page: Page) {
  // Registered first, so it has the lowest priority: any other backend call
  // gets an empty answer instead of reaching a real server.
  await page.route('**/api/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"message":"stubbed"}}' }),
  );
  await page.route('**/api/auth/github/refresh**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        profile: { email: 'e2e@example.com', displayName: 'E2E User' },
        providerInfo: { accessToken: 'gh-e2e', scope: 'read:user', expiresInSeconds: 3600 },
        backstageIdentity: {
          token: fakeJwt(),
          expiresInSeconds: 3600,
          identity: { type: 'user', userEntityRef: 'user:default/e2e', ownershipEntityRefs: ['user:default/e2e'] },
        },
      }),
    }),
  );
  await page.route(`**/api/work-items/work-items/${WORK_ITEM_ID}`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORK_ITEM) }),
  );
}

async function openDeepLink(page: Page) {
  await stubBackend(page);
  await page.goto(`/work-items/${WORK_ITEM_ID}`);
  const header = page.getByTestId('work-item-header');
  await expect(header).toBeVisible();
  await expect(header).toContainText('E2E work item');
  const pending = page.getByTestId('pending-panel');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('Waiting for human input.');
  await expect(pending).toContainText('Execution request xr_1 (resume) is pending.');
}

async function boxes(page: Page) {
  const requests = await page.getByTestId('execution-requests-panel').boundingBox();
  const latest = await page.getByTestId('latest-execution-panel').boundingBox();
  expect(requests).not.toBeNull();
  expect(latest).not.toBeNull();
  return { requests: requests!, latest: latest! };
}

test.describe('work item deep link', () => {
  test('renders header and Pending panel on desktop, side by side sections', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDeepLink(page);
    const { requests, latest } = await boxes(page);
    // md=6: the two sections share a row.
    expect(Math.abs(requests.y - latest.y)).toBeLessThan(2);
    expect(latest.x).toBeGreaterThan(requests.x + requests.width / 2);
  });

  test('renders a single column on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDeepLink(page);
    const { requests, latest } = await boxes(page);
    // xs=12: stacked, same left edge, the second one below the first.
    expect(Math.abs(requests.x - latest.x)).toBeLessThan(2);
    expect(latest.y).toBeGreaterThanOrEqual(requests.y + requests.height - 1);
    const header = await page.getByTestId('work-item-header').boundingBox();
    const pending = await page.getByTestId('pending-panel').boundingBox();
    expect(pending!.y).toBeGreaterThan(header!.y);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    // An inner scroll container can hide row overflow from the document's
    // scrollWidth, so check the history rows carrying full-length hashes too.
    await expect(page.getByTestId('section-ContextSnapshots')).toContainText(
      WORK_ITEM.snapshots.value[0].contentHash,
    );
    await expect(page.getByTestId('section-Evidence')).toContainText(WORK_ITEM.evidence.value[0].contentHash);
    const overflowing = await page
      .locator('[data-testid^="section-"] li')
      .evaluateAll(rows => rows.filter(r => r.scrollWidth > r.clientWidth).map(r => r.textContent));
    expect(overflowing).toEqual([]);
  });
});
