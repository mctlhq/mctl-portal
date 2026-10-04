import fs from 'fs';
import path from 'path';
import { TEAM_WORKFLOW_TEMPLATES } from './workflowAuthorization';

type Step = {
  file: string;
  templateName: string;
  clusterScope: boolean | null;
  namespace: string;
  team_name: string;
};
const fixture: { source: string; steps: Step[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'gitops-submit-steps.json'), 'utf8'),
);

// The scaffolder templates that call mctl:workflow:submit live in
// mctl-gitops (platform-gitops/backstage/templates). The fixture copies the
// input of every such step (source commit in fixture.source). If a template
// is added or changed there, regenerate the fixture: a template the
// allow-list does not cover, or one that does not submit into its team's
// own namespace, turns this test red instead of failing for users.

describe('gitops templates that submit workflows', () => {
  it('covers the five service flows', () => {
    expect(fixture.steps.map(s => s.file.split('/').slice(-2, -1)[0]).sort()).toEqual([
      'delete-component',
      'deploy-component',
      'deploy-version',
      'provision-database',
      'update-component-config',
    ]);
  });

  it.each(fixture.steps.map(s => [s.file, s] as const))('%s runs a team template', (_file, step) => {
    expect(TEAM_WORKFLOW_TEMPLATES.has(step.templateName)).toBe(true);
    // clusterScope defaults to true in the action
    expect(step.clusterScope ?? true).toBe(true);
  });

  it.each(fixture.steps.map(s => [s.file, s] as const))(
    '%s submits into the namespace of the team it names',
    (_file, step) => {
      expect(step.namespace).toBeTruthy();
      expect(step.namespace).toBe(step.team_name);
    },
  );

  it('allows no template that no flow uses', () => {
    const used = new Set(fixture.steps.map(s => s.templateName));
    expect([...TEAM_WORKFLOW_TEMPLATES].filter(t => !used.has(t))).toEqual([]);
  });
});
