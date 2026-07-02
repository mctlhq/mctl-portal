import { parseStatusYaml } from './gitops-client';

// .status.yaml is written by mctl-agents Tier 2 and can also be hand-edited
// in mctl-gitops, so parseStatusYaml is the one place guarding against an
// unknown status string reaching the frontend's status-to-color map.
describe('parseStatusYaml', () => {
  it('parses a well-formed status file', () => {
    const yaml = "status: accepted\nupdated_at: '2026-01-01T00:00:00.000Z'\nupdated_by: mashkovd\n";
    expect(parseStatusYaml(yaml)).toMatchObject({
      status: 'accepted',
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'mashkovd',
    });
  });

  it.each(['proposed', 'accepted', 'in-progress', 'implemented', 'rejected'])(
    'accepts the known status %s',
    status => {
      expect(parseStatusYaml(`status: ${status}\n`).status).toBe(status);
    },
  );

  it('falls back to proposed for an unknown status value', () => {
    expect(parseStatusYaml('status: accepetd\n').status).toBe('proposed');
  });

  it('falls back to proposed when status is missing', () => {
    expect(parseStatusYaml('updated_by: mashkovd\n').status).toBe('proposed');
  });

  it('falls back to proposed for empty or non-object YAML', () => {
    expect(parseStatusYaml('').status).toBe('proposed');
    expect(parseStatusYaml('- just\n- a\n- list\n').status).toBe('proposed');
  });

  it('does not throw on malformed YAML', () => {
    expect(() => parseStatusYaml(':::not valid yaml:::')).not.toThrow();
  });
});
