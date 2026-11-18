/** RPC the deploy resource configurator iframe may call. */
export interface DeployConfiguratorRpc {
  /** Error string when the name is not deployable, or null when it is. */
  checkWorkerName(name: string): Promise<string | null>;
}

export type DeployConfiguratorValues = {
  workerName?: string | null;
  error?: string | null;
};
