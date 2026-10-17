export interface Config {
  tenantManagement?: {
    workspaceReady?: {
      enabled?: boolean;
      /** @visibility secret */
      resendApiKey?: string;
    };
  };
}
