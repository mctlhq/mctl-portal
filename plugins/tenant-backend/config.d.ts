export interface Config {
  tenantManagement?: {
    workspaceReady?: {
      enabled?: boolean;
      from?: string;
      maxObservationAgeSeconds?: number;
      maxFutureClockSkewSeconds?: number;
      /** @visibility secret */
      resendApiKey?: string;
    };
  };
}
