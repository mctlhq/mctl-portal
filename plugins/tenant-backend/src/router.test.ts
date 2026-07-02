import { staticTokenEquals } from './router';

// /backstage/catalog.yaml serves PII (contact emails, member lists) and is
// gated on the landing token via this comparison; it is also the fallback
// static-token path in resolveAuth. Guard both directions.
describe('staticTokenEquals', () => {
  const token = 'k'.repeat(48);

  it('accepts the exact configured token', () => {
    expect(staticTokenEquals(token, token)).toBe(true);
  });

  it.each([
    ['wrong value of same length', 'x'.repeat(48)],
    ['prefix of the token', token.slice(0, 47)],
    ['token with suffix', `${token}k`],
    ['empty string', ''],
  ])('rejects %s', (_name, provided) => {
    expect(staticTokenEquals(provided, token)).toBe(false);
  });

  it('rejects when the caller sends nothing', () => {
    expect(staticTokenEquals(undefined, token)).toBe(false);
  });

  it('rejects everything when no token is configured (never open by accident)', () => {
    expect(staticTokenEquals(token, undefined)).toBe(false);
    expect(staticTokenEquals('', undefined)).toBe(false);
    expect(staticTokenEquals(undefined, undefined)).toBe(false);
    expect(staticTokenEquals(undefined, '')).toBe(false);
  });
});
