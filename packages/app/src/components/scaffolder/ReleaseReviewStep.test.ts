import { maskSecrets } from './ReleaseReviewStep';

describe('maskSecrets', () => {
  it('shows keys of KEY=VALUE lines and masks values', () => {
    expect(maskSecrets('A=1\nB=two=three')).toEqual(['A=****', 'B=****']);
  });

  it('masks whole any line that is not KEY=VALUE (old code showed it in clear)', () => {
    const out = maskSecrets('API_KEY: sk-live-123\n=topsecret\nbare-token');
    expect(out).toEqual(['****', '****', '****']);
    expect(out.join('\n')).not.toMatch(/sk-live|topsecret|bare-token/);
  });
});
