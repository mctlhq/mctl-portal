import { registerAuthPolicies } from './plugin';

// Regression guard for the domain-hijack fix: the plugin previously allowed
// unauthenticated access to /domains and /domains/, letting any anonymous
// caller enumerate/create/delete custom-domain mappings. Only /health may be
// public; everything else must require authentication.
describe('custom-domains auth policies', () => {
  function collect() {
    const calls: Array<{ path: string; allow: string }> = [];
    registerAuthPolicies({ addAuthPolicy: p => calls.push(p) });
    return calls;
  }

  it('exposes only /health as unauthenticated', () => {
    const calls = collect();
    expect(calls).toEqual([{ path: '/health', allow: 'unauthenticated' }]);
  });

  it('never registers an unauthenticated policy for /domains*', () => {
    const calls = collect();
    const domainPolicies = calls.filter(
      c => c.path.startsWith('/domains') && c.allow === 'unauthenticated',
    );
    expect(domainPolicies).toEqual([]);
  });
});
