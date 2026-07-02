import { isAllowedTransition } from './router';
import { ProposalStatus } from './types';

// This is the server-side guard that stops a direct API call from
// overwriting an in-progress/implemented proposal or performing a no-op
// re-decision, even though the UI also disables those actions.
describe('isAllowedTransition', () => {
  const cases: Array<[ProposalStatus, 'accepted' | 'rejected', boolean]> = [
    ['proposed', 'accepted', true],
    ['proposed', 'rejected', true],
    ['rejected', 'accepted', true],
    ['accepted', 'rejected', true],
    ['accepted', 'accepted', false],
    ['rejected', 'rejected', false],
    ['in-progress', 'accepted', false],
    ['in-progress', 'rejected', false],
    ['implemented', 'accepted', false],
    ['implemented', 'rejected', false],
  ];

  it.each(cases)('%s -> %s is allowed=%s', (current, attempted, expected) => {
    expect(isAllowedTransition(current, attempted)).toBe(expected);
  });
});
