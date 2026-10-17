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
  /**
   * The ZITADEL organization of self-service customers. Both ids are public
   * (they appear in every customer authorization URL); the sign-in page
   * offers the customer entry, "Sign in with GitHub", only with both.
   */
  zitadelCustomers?: {
    /**
     * ZITADEL id of the customers organization.
     * @visibility frontend
     */
    organizationId?: string;
    /**
     * ZITADEL id of the customers organization's GitHub IdP.
     * @visibility frontend
     */
    githubIdpId?: string;
  };
}
