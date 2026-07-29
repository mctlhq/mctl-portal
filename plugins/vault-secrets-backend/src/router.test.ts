import type { Knex } from 'knex';
import {
  SLUG_RE,
  checkTenantRole,
  escapeHtml,
  renderOpenClawIntakePage,
  renderOpenClawSavedPage,
} from './router';

// team/service are interpolated into the intake HTML pages. These tests guard
// the two layers that prevent reflected XSS there: the kebab-case slug gate
// (rejected with 400 in both intake handlers) and the HTML escaping applied
// inside the render functions.
describe('SLUG_RE (intake slug validation)', () => {
  it.each(['labs', 'my-service', 'a', 'svc-2', 'a'.repeat(31)])(
    'accepts valid kebab-case slug %p',
    slug => {
      expect(SLUG_RE.test(slug)).toBe(true);
    },
  );

  it.each([
    '',
    'Labs', // uppercase
    '-labs', // leading hyphen
    'my_service', // underscore
    'a'.repeat(32), // too long
    'team/../other', // path traversal
    '"><script>alert(1)</script>', // XSS payload
    "x' onmouseover='alert(1)", // attribute breakout
    'team name', // whitespace
  ])('rejects invalid slug %p', slug => {
    expect(SLUG_RE.test(slug)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('encodes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes & first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain slugs untouched', () => {
    expect(escapeHtml('my-service')).toBe('my-service');
  });
});

// checkTenantRole gates 4 routes in this file: GET/POST /openclaw/intake
// (minimumRole 'owner') and, via requireTenantRole, GET .../database and
// GET .../secrets (minimumRole 'viewer'). This exercises the admin bypass
// added for platform admins (owner role in the 'admins' tenant), who should
// pass regardless of their membership in the target team.
describe('checkTenantRole (admin bypass)', () => {
  // Mirrors getTenantMember's real query shape: db('tenant_members')
  // [.withSchema(...) on Postgres].where({ tenant_name, user_id }).first()
  function fakeDb(memberships: Record<string, { role: string }>): Knex {
    const db = jest.fn((_table: string) => {
      const builder: any = {
        withSchema: jest.fn().mockReturnThis(),
        where(cond: { tenant_name: string; user_id: string }) {
          builder._cond = cond;
          return builder;
        },
        async first() {
          const key = `${builder._cond.tenant_name}:${builder._cond.user_id}`;
          const role = memberships[key]?.role;
          return role
            ? { tenant_name: builder._cond.tenant_name, user_id: builder._cond.user_id, role }
            : undefined;
        },
      };
      return builder;
    });
    return db as unknown as Knex;
  }

  it('grants an admins-tenant owner access to a team they are not a member of', async () => {
    const db = fakeDb({ 'admins:alice': { role: 'owner' } });
    const result = await checkTenantRole(db, false, 'nfc', 'alice', 'viewer');
    expect(result).toEqual({ ok: true, userId: 'alice', role: 'owner' });
  });

  it('still denies a non-admin who is not a member of the team', async () => {
    const db = fakeDb({});
    const result = await checkTenantRole(db, false, 'nfc', 'bob', 'viewer');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Access denied: not a member of team 'nfc'",
    });
  });
});

describe('intake page rendering', () => {
  const payload = '"><script>alert(1)</script>';

  it('does not reflect raw markup from team/service/returnTo into the intake page', () => {
    const html = renderOpenClawIntakePage(payload, payload, `/x?a=${payload}`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not reflect raw markup into the saved page', () => {
    const html = renderOpenClawSavedPage(payload, payload);
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders valid slugs verbatim in both pages', () => {
    expect(renderOpenClawIntakePage('labs', 'my-svc', '')).toContain('labs/my-svc');
    expect(renderOpenClawSavedPage('labs', 'my-svc')).toContain('labs/my-svc');
  });
});
