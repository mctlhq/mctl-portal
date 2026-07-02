import {
  SLUG_RE,
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
