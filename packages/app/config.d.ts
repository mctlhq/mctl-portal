export interface Config {
  auth?: {
    /**
     * Which providers the portal sign-in page offers: `github` (the default
     * when unset), `zitadel`, or `both` (ZITADEL first, GitHub as legacy).
     * `zitadel` and `both` need auth.providers.oidc configured for ZITADEL.
     * @visibility frontend
     */
    signIn?: 'github' | 'zitadel' | 'both';
  };
}
