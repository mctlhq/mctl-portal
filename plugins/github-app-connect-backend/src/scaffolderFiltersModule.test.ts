import { serviceName } from './scaffolderFiltersModule';

describe('serviceName filter', () => {
  it('makes a DNS label from a repo name', () => {
    expect(serviceName('mashkoffdmitry/tsvilt.ru')).toBe('tsvilt-ru');
    expect(serviceName('o/_Hello_World_')).toBe('hello-world');
    expect(serviceName(42)).toBeUndefined();
  });

  it('never ends in a hyphen after the 63-character cut (old code trimmed before cutting)', () => {
    const name = serviceName(`o/${'a'.repeat(62)}.b`)!;
    expect(name).toBe('a'.repeat(62));
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});
