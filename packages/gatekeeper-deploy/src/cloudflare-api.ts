// Minimal Cloudflare REST client for the Deploy Gatekeeper: Workers script versions,
// deployments, settings, subdomain, and the storage lookups that prove a bound resource belongs
// to the session's Worker. The token is the gatekeeper's secret; it never leaves this Worker.

const API_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

type Envelope<T> = {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
};

export type ScriptSettings = {
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings?: { name: string; type: string }[];
};

export type ScriptVersion = {
  id: string;
  number: number;
  created_on?: string;
  metadata?: { created_on?: string };
  annotations?: Record<string, string>;
};

export type ScriptDeployment = {
  id: string;
  created_on?: string;
  versions?: { version_id: string; percentage: number }[];
};

export class WorkersApi {
  constructor(
    readonly token: string,
    readonly accountId: string,
  ) {}

  async #call<T>(method: string, path: string, body?: BodyInit, headers?: HeadersInit): Promise<T> {
    let response = await fetch(`${API_BASE}/accounts/${this.accountId}${path}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${this.token}`, ...headers },
    });
    let envelope = (await response.json()) as Envelope<T>;
    if (!response.ok || !envelope.success) {
      let error = envelope.errors?.[0];
      throw new CloudflareApiError(
        response.status,
        error?.code ?? null,
        error?.message ?? `Cloudflare API returned HTTP ${response.status}`,
      );
    }
    return envelope.result;
  }

  #get<T>(path: string): Promise<T> {
    return this.#call<T>("GET", path);
  }

  /** 404 → null: an unprovisioned Worker is a normal state before the first deploy. */
  async getScriptSettings(workerName: string): Promise<ScriptSettings | null> {
    try {
      return await this.#get(`/workers/scripts/${workerName}/settings`);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getSubdomain(workerName: string): Promise<string | null> {
    try {
      let result = await this.#get<{ subdomain: string }>(`/workers/scripts/${workerName}/subdomain`);
      return result.subdomain;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listVersions(workerName: string, limit: number): Promise<ScriptVersion[]> {
    // The live API wraps the list as result.items (not a bare array, not result.versions).
    let result = await this.#get<{ items?: ScriptVersion[] } | ScriptVersion[]>(
      `/workers/scripts/${workerName}/versions?page_size=${limit}`,
    );
    return Array.isArray(result) ? result : result.items ?? [];
  }

  async listDeployments(workerName: string): Promise<ScriptDeployment[]> {
    try {
      // The live API wraps the list as result.deployments.
      let result = await this.#get<{ deployments?: ScriptDeployment[] } | ScriptDeployment[]>(
        `/workers/scripts/${workerName}/deployments`,
      );
      return Array.isArray(result) ? result : result.deployments ?? [];
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return [];
      throw error;
    }
  }

  /** Upload a new version without deploying it. Returns the version ID. */
  async uploadVersion(
    workerName: string,
    metadata: Record<string, unknown>,
    modules: Record<string, string>,
  ): Promise<ScriptVersion> {
    let form = new FormData();
    form.set(
      "metadata",
      new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" }),
    );
    for (let [partName, source] of Object.entries(modules)) {
      form.set(partName, new File([source], partName, { type: "application/javascript+module" }));
    }
    return this.#call("POST", `/workers/scripts/${workerName}/versions`, form);
  }

  /**
   * Point 100% of traffic at `versionId`. Returns the deployment ID.
   * Provenance rides in the message: `workers/triggered_by` looks settable in the API schema
   * but the platform rejects client-supplied values (error 10210), so don't send it.
   */
  async deployVersion(
    workerName: string,
    versionId: string,
    message: string,
  ): Promise<ScriptDeployment> {
    return this.#call("POST", `/workers/scripts/${workerName}/deployments`, JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: {
        "workers/message": `[gatekeeper-deploy] ${message}`,
      },
    }), { "Content-Type": "application/json" });
  }

  /** The title of a KV namespace, or null when it does not exist. */
  async getKvNamespaceTitle(namespaceId: string): Promise<string | null> {
    try {
      let result = await this.#get<{ title: string }>(`/storage/kv/namespaces/${namespaceId}`);
      return result.title;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** The name of a D1 database, or null when it does not exist. */
  async getD1DatabaseName(databaseId: string): Promise<string | null> {
    try {
      let result = await this.#get<{ name: string }>(`/d1/database/${databaseId}`);
      return result.name;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Whether an R2 bucket exists. */
  async r2BucketExists(bucketName: string): Promise<boolean> {
    try {
      await this.#get(`/r2/buckets/${bucketName}`);
      return true;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return false;
      throw error;
    }
  }
}
