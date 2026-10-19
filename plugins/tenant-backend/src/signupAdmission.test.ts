import { createSignupAdmission } from './signupAdmission';

describe('signup admission', () => {
 const originalFetch = global.fetch;
 afterEach(() => { global.fetch = originalFetch; });
 const claim = { principal_id: 'prn_test', tenant: 'new-team', memory: '2Gi', cpu: '1', memory_limit: '3Gi', cpu_limit: '2', pods: '10', pvcs: '5', services: '10' };
 it('sends the fixed claim to the authenticated central gate', async () => {
   const provider = jest.fn().mockResolvedValue(new Response(JSON.stringify({ admitted: true }), { status: 200 }));
   global.fetch = provider;
   await createSignupAdmission('https://api.example', 'surface-secret')(claim);
   expect(provider).toHaveBeenCalledWith('https://api.example/api/v1/surface-principals/signup-claim', expect.objectContaining({ redirect: 'manual', body: JSON.stringify(claim), headers: expect.objectContaining({ Authorization: 'Bearer surface-secret' }) }));
 });
 it.each([403, 409, 503, 302])('refuses provisioning on HTTP %s', async status => {
   global.fetch = jest.fn().mockResolvedValue(new Response(null, { status }));
   await expect(createSignupAdmission('https://api.example', 'surface-secret')(claim)).rejects.toThrow();
 });
 it.each([{}, { admitted: false }, { admitted: 'true' }])('refuses malformed success %p', async body => {
   global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
   await expect(createSignupAdmission('https://api.example', 'surface-secret')(claim)).rejects.toThrow();
 });
});
