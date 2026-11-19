import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareApiError, WorkersApi } from "./cloudflare-api.js";
import {
  MAIN_MODULE_DEFAULT,
  uploadMetadata,
  validateBindingOwnership,
  validateSpecShape,
  workerNameAllowed,
} from "./spec-validation.js";
import type {
  DeployResult,
  DeploySession,
  DeploySpec,
  DeployStatus,
  DeployTarget,
  DeployValidation,
  DeployVersionSummary,
} from "./types.js";
import TYPES_CODE from "./types-code.js";
import DEPLOY_CONFIGURATOR_HTML from "./generated/deploy-configurator-html.js";
import { DeployConfiguratorUI } from "./configurator/deploy-configurator-rpc.js";

export const DEPLOY_RESOURCE_URL_PATTERN = "deploy://workers/*";

const DEPLOY_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='%237C3AED' stroke-width='18' stroke-linejoin='round'><path d='M128 24 36 88v80l92 64 92-64V88z'/><path d='M128 24v208M36 88l92 64 92-64'/></svg>",
    ),
};

export const DEPLOY_WORKER_RESOURCE: SupportedResource = {
  urlPattern: DEPLOY_RESOURCE_URL_PATTERN,
  title: "Workshop Worker",
  description:
    "Deploy application code to one Worker on the workshop account. Bound resources " +
    "(KV, D1, R2) must belong to that Worker.",
  icon: DEPLOY_ICON,
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

/** Props the account imbues each DeployGatekeeper facet with (see getGatekeeperClassFor). */
export type DeployGatekeeperProps = {
  workerName: string;
};

/** Parse `deploy://workers/<name>` and enforce the deployment's prefix. */
export function parseDeployUrl(url: string, prefix: string): DeployGatekeeperProps {
  let match = /^deploy:\/\/workers\/([a-z0-9][a-z0-9-]*[a-z0-9])\/?$/.exec(url);
  if (!match) {
    throw new Error(
      `Not a deploy resource URL (${DEPLOY_RESOURCE_URL_PATTERN.replace("*", "<worker-name>")}).`,
    );
  }
  let workerName = match[1];
  if (!workerNameAllowed(workerName, prefix)) {
    throw new Error(
      `Worker "${workerName}" is not deployable here: deployable Workers start with "${prefix}".`,
    );
  }
  return { workerName };
}

export function describeDeployVendor(): VendorDescription {
  return {
    displayName: "Workshop Deploy",
    url: "https://github.com/tuy-cf/noodle-hub-cfos",
    logo: DEPLOY_ICON,
    color: "#7C3AED",
    tagline: "Deploy apps to your workshop Worker",
    description:
      "Lets an agent deploy application code to exactly one Worker on the workshop account, " +
      "with validation and rollback. The gatekeeper holds the account credential; workspaces " +
      "never see it.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeDeployAccount(): AccountDescription {
  return {
    displayName: "Workshop Deploy",
    avatar: DEPLOY_ICON,
  };
}

function notFound(workerName: string): Error {
  return new Error(
    `Worker "${workerName}" is not provisioned on the workshop account. ` +
    "Ask the facilitator to create it before deploying.",
  );
}

function toSummary(
  version: { id: string; number: number; created_on?: string; metadata?: { created_on?: string }; annotations?: Record<string, string> },
  deployed: boolean,
): DeployVersionSummary {
  return {
    versionId: version.id,
    number: version.number,
    createdAt: version.created_on ?? version.metadata?.created_on ?? "",
    message: version.annotations?.["workers/message"] ?? null,
    deployed,
  };
}

@validateRpc()
export class DeploySessionImpl extends RpcTarget implements DeploySession {
  readonly #queue: ObservationQueue;
  readonly #api: WorkersApi;
  readonly #workerName: string;
  readonly #prefix: string;
  readonly #defaultCompatibilityDate: string;

  constructor(
    queue: ObservationQueue,
    api: WorkersApi,
    workerName: string,
    prefix: string,
    defaultCompatibilityDate: string,
  ) {
    super();
    this.#queue = queue;
    this.#api = api;
    this.#workerName = workerName;
    this.#prefix = prefix;
    this.#defaultCompatibilityDate = defaultCompatibilityDate;
  }

  async #url(): Promise<string | null> {
    let subdomain = await this.#api.getSubdomain(this.#workerName);
    return subdomain ? `https://${this.#workerName}.${subdomain}.workers.dev` : null;
  }

  async getTarget(): Promise<DeployTarget> {
    await this.#queue.authorizeObservation({
      title: "Read deploy target",
      description: `Read which Worker this deploy binding controls (${this.#workerName}).`,
    });
    return {
      workerName: this.#workerName,
      workerPrefix: this.#prefix,
      url: await this.#url(),
    };
  }

  async #versions(deployedId: string | null, limit: number): Promise<DeployVersionSummary[]> {
    let versions = await this.#api.listVersions(this.#workerName, limit);
    return versions.map(version => toSummary(version, version.id === deployedId));
  }

  async getStatus(): Promise<DeployStatus> {
    await this.#queue.authorizeObservation({
      title: "Read deployment status",
      description: `Read the current version, settings, and recent history of ${this.#workerName}.`,
    });
    let [settings, deployments, subdomain] = await Promise.all([
      this.#api.getScriptSettings(this.#workerName),
      this.#api.listDeployments(this.#workerName),
      this.#api.getSubdomain(this.#workerName),
    ]);
    if (settings === null) throw notFound(this.#workerName);
    let currentId = deployments[0]?.versions?.find(v => v.percentage > 0)?.version_id ?? null;
    let recent = await this.#versions(currentId, 10);
    return {
      current: recent.find(version => version.deployed) ?? null,
      compatibilityDate: settings.compatibility_date ?? null,
      bindings: (settings.bindings ?? []).map(({ name, type }) => ({ name, type })),
      recentVersions: recent,
    };
  }

  async listVersions(limit = 10): Promise<DeployVersionSummary[]> {
    await this.#queue.authorizeObservation({
      title: "List versions",
      description: `List recent versions of ${this.#workerName}.`,
    });
    let deployments = await this.#api.listDeployments(this.#workerName);
    let currentId = deployments[0]?.versions?.find(v => v.percentage > 0)?.version_id ?? null;
    return this.#versions(currentId, limit);
  }

  async #validate(spec: DeploySpec): Promise<DeployValidation> {
    let shape = validateSpecShape(spec);
    let ownershipErrors = shape.errors.length === 0 && (spec.bindings?.length ?? 0) > 0
      ? await validateBindingOwnership(spec, this.#workerName, this.#api)
      : [];
    let errors = [...shape.errors, ...ownershipErrors];
    return { ok: errors.length === 0, errors, warnings: shape.warnings };
  }

  async validate(spec: DeploySpec): Promise<DeployValidation> {
    await this.#queue.authorizeObservation({
      title: "Validate a deploy spec",
      description: `Check a deploy spec for ${this.#workerName} without deploying.`,
    });
    return this.#validate(spec);
  }

  async deploy(spec: DeploySpec): Promise<DeployResult> {
    let validation = await this.#validate(spec);
    if (!validation.ok) {
      throw new Error(`Deploy refused: ${validation.errors.join("; ")}`);
    }
    let message = spec.message
      ?? `Deploy of ${Object.keys(spec.modules).length} module(s) to ${this.#workerName}`;
    let version = await this.#api.uploadVersion(
      this.#workerName,
      uploadMetadata(spec, this.#defaultCompatibilityDate),
      spec.modules,
    );
    let deployment = await this.#api.deployVersion(this.#workerName, version.id, message);
    return {
      versionId: version.id,
      deploymentId: deployment.id,
      url: await this.#url(),
      message,
    };
  }

  async rollback(versionId: string): Promise<DeployResult> {
    let versions = await this.#api.listVersions(this.#workerName, 100);
    let target = versions.find(version => version.id === versionId);
    if (!target) {
      throw new Error(
        `Version ${versionId} is not among this Worker's last ${versions.length} versions.`,
      );
    }
    let message = `Rollback to version ${target.number} (${versionId})`;
    let deployment = await this.#api.deployVersion(this.#workerName, versionId, message);
    return {
      versionId,
      deploymentId: deployment.id,
      url: await this.#url(),
      message,
    };
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class DeployGatekeeper extends DurableObject<Cloudflare.Env, DeployGatekeeperProps>
    implements Gatekeeper<DeploySession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: `deploy://workers/${this.ctx.props.workerName}`,
      title: `Deploy to ${this.ctx.props.workerName}`,
      snippet: "Deploy application code to this workshop Worker, with validation and rollback.",
      suggestedBindingName: "DEPLOY",
      tsType: "DeploySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  /** No catalog: the session's types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<DeploySession> {
    return new DeploySessionImpl(
      approvalQueue.dup(),
      new WorkersApi(this.env.CLOUDFLARE_API_TOKEN, this.env.CLOUDFLARE_ACCOUNT_ID),
      this.ctx.props.workerName,
      this.env.DEPLOY_WORKER_PREFIX,
      this.env.DEPLOY_COMPATIBILITY_DATE,
    );
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`Deploy Gatekeeper queues no actions in this phase (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("Deploy Gatekeeper has no queued actions to revert.");
  }
}

@validateRpc()
export class DeployAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeDeployAccount();
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [DEPLOY_WORKER_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<DeploySession>>;
    resource: SupportedResource;
  }> {
    let props = parseDeployUrl(url, this.env.DEPLOY_WORKER_PREFIX);
    return {
      class: this.ctx.exports.DeployGatekeeper({ props }),
      resource: DEPLOY_WORKER_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== DEPLOY_RESOURCE_URL_PATTERN) {
      throw new Error(`Unsupported deploy resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: DEPLOY_CONFIGURATOR_HTML,
      ui: new RpcStub(new DeployConfiguratorUI(
        this.env.DEPLOY_WORKER_PREFIX,
        new WorkersApi(this.env.CLOUDFLARE_API_TOKEN, this.env.CLOUDFLARE_ACCOUNT_ID),
      )),
    };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    for (let pattern of resourceUrlPatterns) {
      if (pattern !== DEPLOY_RESOURCE_URL_PATTERN) {
        throw new Error(`Unsupported deploy resource pattern: ${pattern}`);
      }
    }
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Workshop Deploy is auto-provisioned and has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Workshop Deploy is auto-provisioned and has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.DeployVerifier({});
  }
}

@validateRpc()
export class DeployVerifier extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeDeployVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.DeployAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Workshop Deploy is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [DEPLOY_WORKER_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// Re-exported so the test entry lists every class by name (see __tests__/worker.ts).
export { MAIN_MODULE_DEFAULT };
