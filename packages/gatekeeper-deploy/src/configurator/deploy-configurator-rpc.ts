import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { CloudflareApiError, WorkersApi } from "../cloudflare-api.js";
import { workerNameAllowed } from "../spec-validation.js";
import type { DeployConfiguratorRpc } from "./deploy-configurator-types.js";

/**
 * The resource configurator's live checks: the name must be deployable under the deployment's
 * prefix and provisioned on the account. Returns an error string, or null when the name is
 * deployable.
 */
@validateRpc()
export class DeployConfiguratorUI extends RpcTarget implements DeployConfiguratorRpc {
  constructor(
    readonly prefix: string,
    readonly api: WorkersApi,
  ) {
    super();
  }

  async checkWorkerName(name: string): Promise<string | null> {
    if (!workerNameAllowed(name, this.prefix)) {
      return `Deployable Workers start with "${this.prefix}" and use lowercase letters, digits, ` +
        "and dashes.";
    }
    try {
      let settings = await this.api.getScriptSettings(name);
      return settings === null
        ? `"${name}" is not provisioned yet. Ask the facilitator to create it.`
        : null;
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        return `Could not check "${name}" against the account (${error.message}).`;
      }
      throw error;
    }
  }
}
