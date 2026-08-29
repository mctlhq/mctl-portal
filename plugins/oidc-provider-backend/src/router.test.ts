import { isAllowedReturnTo, sanitizeReturnTo } from './router';

describe('isAllowedReturnTo', () => {
  it('allows a relative path', () => {
    expect(isAllowedReturnTo('/catalog')).toBe(true);
  });

  it('allows a subdomain of mctl.ai over https', () => {
    expect(isAllowedReturnTo('https://app.mctl.ai/x')).toBe(true);
  });

  it('allows the bare apex domain over https', () => {
    expect(isAllowedReturnTo('https://mctl.ai/')).toBe(true);
  });

  it('rejects an unrelated host', () => {
    expect(isAllowedReturnTo('https://evil.example/')).toBe(false);
  });

  it('rejects a protocol-relative value', () => {
    expect(isAllowedReturnTo('//evil.example')).toBe(false);
  });

  it('rejects a lookalike host that merely contains mctl.ai as a substring', () => {
    expect(isAllowedReturnTo('https://mctl.ai.evil.example/')).toBe(false);
  });

  it('rejects the correct host over the wrong scheme', () => {
    expect(isAllowedReturnTo('http://app.mctl.ai/x')).toBe(false);
  });

  it('rejects unparseable input without throwing', () => {
    expect(isAllowedReturnTo('not a url')).toBe(false);
  });

  it('rejects a backslash variant of a scheme-relative value', () => {
    expect(isAllowedReturnTo('/\\evil')).toBe(false);
  });

  it('rejects a relative path smuggling a tab (browsers strip it into //)', () => {
    expect(isAllowedReturnTo('/\t/evil.example')).toBe(false);
  });

  it('rejects embedded newline and carriage-return characters', () => {
    expect(isAllowedReturnTo('/\n/evil.example')).toBe(false);
    expect(isAllowedReturnTo('/\r/evil.example')).toBe(false);
    expect(isAllowedReturnTo('https://app.mctl.ai/x\n')).toBe(false);
  });

  it('rejects other ASCII control characters anywhere in the value', () => {
    expect(isAllowedReturnTo('/dash\x00board')).toBe(false);
    expect(isAllowedReturnTo('/dash\x7fboard')).toBe(false);
  });

  it('rejects a trailing-dot host', () => {
    expect(isAllowedReturnTo('https://mctl.ai./')).toBe(false);
  });
});

describe('sanitizeReturnTo', () => {
  it('returns the value unchanged when allowed', () => {
    expect(sanitizeReturnTo('/catalog')).toBe('/catalog');
    expect(sanitizeReturnTo('https://app.mctl.ai/x')).toBe('https://app.mctl.ai/x');
  });

  it('falls back to the default post-login path when disallowed', () => {
    expect(sanitizeReturnTo('https://evil.example/')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('https://mctl.ai.evil.example/')).toBe('/');
  });
});
