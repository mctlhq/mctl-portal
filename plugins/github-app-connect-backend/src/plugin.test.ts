import { registerAuthPolicies } from './plugin';

// Regression guard for the unauthenticated-access fix: the plugin previously
// registered `allow: 'unauthenticated'` for every route it exposes
// (/repos, /repo-tags, /service-config, /repo-access, /install-url,
// /install-status included), letting any anonymous caller enumerate a
// team's connected repos, tags, and service configuration. Only /callback,
// /popup-done, and /webhook may stay public — they are gated by their own
// crypto checks (state-token decrypt / X-Hub-Signature-256 HMAC) and GitHub
// cannot present a Backstage bearer token to any of the three.
describe('github-app-connect auth policies', () => {
  function collect() {
    const calls: Array<{ path: string; allow: string }> = [];
    registerAuthPolicies({ addAuthPolicy: p => calls.push(p) });
    return calls;
  }

  it('exposes only /callback, /popup-done, /webhook as unauthenticated', () => {
    const calls = collect();
    expect(calls).toEqual([
      { path: '/callback', allow: 'unauthenticated' },
      { path: '/popup-done', allow: 'unauthenticated' },
      { path: '/webhook', allow: 'unauthenticated' },
    ]);
  });

  it('never registers an unauthenticated policy for the six team/auth-scoped routes', () => {
    const calls = collect();
    const gatedPaths = [
      '/repos',
      '/repo-tags',
      '/service-config',
      '/repo-access',
      '/install-url',
      '/install-status',
    ];
    const reintroduced = calls.filter(
      c => gatedPaths.includes(c.path) && c.allow === 'unauthenticated',
    );
    expect(reintroduced).toEqual([]);
  });
});
