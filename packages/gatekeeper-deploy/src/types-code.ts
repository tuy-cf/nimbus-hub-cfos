// Agent-facing declaration of the Deploy Gatekeeper session API. Keep synchronized with
// types.d.ts (the README's "Adapt it" checklist names both).

const TYPES_CODE = `/** Where this deploy binding points. Fixed for the session's lifetime. */
export interface DeployTarget {
  /** The only Worker this session may deploy to. */
  workerName: string;
  /** The deployment-wide prefix every deployable Worker name must carry. */
  workerPrefix: string;
  /** The Worker's workers.dev URL, or null while its subdomain is disabled. */
  url: string | null;
}

/**
 * A binding a deploy may attach. Only pre-provisioned resources owned by this Worker pass
 * validation: each resource's own name must start with the Worker's name. No other binding types
 * are accepted -- no secrets, service bindings, Durable Objects, or assets in this phase.
 */
export type DeployBindingSpec =
  | { type: "kv_namespace"; name: string; namespaceId: string }
  | { type: "d1"; name: string; databaseId: string }
  | { type: "r2_bucket"; name: string; bucketName: string };

/** Everything needed to deploy a new version of the session's Worker. */
export interface DeploySpec {
  /**
   * ES module sources keyed by part name (e.g. { "worker.js": "export default { ... }" }).
   * Must include the main module.
   */
  modules: Record<string, string>;
  /** The part name of the entry module. Defaults to "worker.js". */
  mainModule?: string;
  /** Defaults to the gatekeeper's configured compatibility date. */
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  bindings?: DeployBindingSpec[];
  /**
   * Plain-text variables. Secret values are never accepted anywhere in this API: set them out of
   * band (\`wrangler secret put\`), where they survive every deploy.
   */
  vars?: Record<string, string>;
  /** Message recorded on the version -- what changed and why. */
  message?: string;
}

/** The outcome of checking a spec without mutating anything. */
export interface DeployValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** A version now serving 100% of the Worker's traffic. */
export interface DeployResult {
  versionId: string;
  deploymentId: string;
  /** workers.dev URL when the subdomain is enabled. */
  url: string | null;
  message: string;
}

export interface DeployVersionSummary {
  versionId: string;
  number: number;
  createdAt: string;
  message: string | null;
  /** Whether this version currently receives traffic. */
  deployed: boolean;
}

export interface DeployStatus {
  current: DeployVersionSummary | null;
  compatibilityDate: string | null;
  /** Binding names and types on the current script settings. */
  bindings: { name: string; type: string }[];
  recentVersions: DeployVersionSummary[];
}

/** Deploy capability for one Worker, granted to one workspace. */
export interface DeploySession {
  /** This session's fixed target. */
  getTarget(): Promise<DeployTarget>;

  /** Current deployment state: serving version, settings, recent history. */
  getStatus(): Promise<DeployStatus>;

  listVersions(limit?: number): Promise<DeployVersionSummary[]>;

  /**
   * Check a spec against every rule deploy() would enforce -- shape, size, scope, binding
   * ownership -- without mutating anything. deploy() refuses a spec with errors, so validate
   * first and fix problems before spending a deploy.
   */
  validate(spec: DeploySpec): Promise<DeployValidation>;

  /**
   * Upload a new version of this session's Worker and deploy it to 100% of traffic. Refuses
   * (throws) when validation finds errors. Executes immediately; there is no approval step in
   * this phase.
   */
  deploy(spec: DeploySpec): Promise<DeployResult>;

  /** Point 100% of traffic back at an earlier version of this Worker. */
  rollback(versionId: string): Promise<DeployResult>;
}
`;

export default TYPES_CODE;
