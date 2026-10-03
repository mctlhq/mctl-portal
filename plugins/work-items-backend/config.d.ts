export interface Config {
  workItems?: {
    /** Base URL of mctl-api. */
    baseUrl?: string;
    /**
     * Token of the `surface:portal` principal (MCTL_SURFACE_PORTAL_TOKEN).
     * Never an admin credential. If unset, every data route answers 503.
     * @visibility secret
     */
    surfaceToken?: string;
    /**
     * Enables the mutation routes (execution requests). Default false.
     */
    actionsEnabled?: boolean;
    /**
     * Optional template for the Execution Canvas link. `{executionId}` and
     * `{workItemId}` are substituted.
     * @visibility frontend
     */
    executionCanvasUrlTemplate?: string;
  };
}
