export class SignupAdmissionError extends Error {}
/** Central admission must succeed before any customer provisioning side effect. */
export interface SignupClaim {
  workspace_profile: 'starter';
  principal_id: string;
  tenant: string;
  memory: string;
  cpu: string;
  memory_limit: string;
  cpu_limit: string;
  pods: string;
  pvcs: string;
  services: string;
}
export type SignupAdmission = (claim: SignupClaim) => Promise<void>;
export function createSignupAdmission(baseUrl: string, surfaceToken: string): SignupAdmission {
  return async claim => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/surface-principals/signup-claim`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${surfaceToken}`, 'Content-Type': 'application/json',
        'X-MCTL-Surface-Actor': `principal:${claim.principal_id}` },
      body: JSON.stringify(claim),
    });
    if (!response.ok) throw new Error('Workspace admission refused or unavailable');
    const body: unknown = await response.json();
    if (!body || (body as { admitted?: unknown }).admitted !== true) throw new Error('Workspace admission response is invalid');
  };
}
