import { describe, expect, it } from "vitest";
import type { WorkersApi } from "../src/cloudflare-api.js";
import {
  MAIN_MODULE_DEFAULT,
  uploadMetadata,
  validateBindingOwnership,
  validateSpecShape,
  workerNameAllowed,
} from "../src/spec-validation.js";
import {
  DeploySessionImpl,
  DEPLOY_WORKER_RESOURCE,
  describeDeployAccount,
  describeDeployVendor,
  parseDeployUrl,
} from "../src/deploy.js";
import type { DeploySpec } from "../src/types.js";

const HELLO: DeploySpec = {
  modules: {
    "worker.js": "export default { async fetch() { return new Response('hi'); } };",
  },
};

describe("deploy gatekeeper metadata", () => {
  it("describes an auto-provisioned vendor and account", () => {
    expect(describeDeployVendor()).toMatchObject({
      displayName: "Workshop Deploy",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect(describeDeployAccount().displayName).toBe("Workshop Deploy");
    expect(DEPLOY_WORKER_RESOURCE.urlPattern).toBe("deploy://workers/*");
  });
});

describe("parseDeployUrl", () => {
  it("accepts a prefixed worker name", () => {
    expect(parseDeployUrl("deploy://workers/changeguard-terrific-tiger", "changeguard-")).toEqual({
      workerName: "changeguard-terrific-tiger",
    });
  });

  it("rejects workers outside the prefix", () => {
    expect(() => parseDeployUrl("deploy://workers/nimbus-labs-os-backend", "changeguard-"))
      .toThrow(/not deployable/);
  });

  it("rejects bare prefix and malformed URLs", () => {
    expect(() => parseDeployUrl("deploy://workers/changeguard-", "changeguard-")).toThrow();
    expect(() => parseDeployUrl("https://example.com/workers/changeguard-x", "changeguard-")).toThrow();
  });

  it("accepts the empty prefix only for well-formed names", () => {
    expect(workerNameAllowed("anything-goes", "")).toBe(true);
    expect(workerNameAllowed("-leading-dash", "")).toBe(false);
  });
});

describe("validateSpecShape", () => {
  it("accepts a minimal module worker", () => {
    let result = validateSpecShape(HELLO);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("requires the main module among the parts", () => {
    let result = validateSpecShape({ modules: { "other.js": "export {};" } });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/worker\.js.*not among/);
  });

  it("rejects oversized sources", () => {
    let result = validateSpecShape({
      modules: { "worker.js": "x".repeat(9 * 1024 * 1024) },
    });
    expect(result.errors.join()).toMatch(/bytes/);
  });

  it("catches an unterminated string at validate time, naming the module and position", () => {
    // The exact failure the first smoke test hit: validate passed, deploy surfaced the error.
    let result = validateSpecShape({
      modules: { "worker.js": 'export default { fetch() { return new Response("hi\n"); } };' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/worker\.js.*syntax error/i);
    expect(result.errors.join()).toMatch(/\(\d+:\d+\)/);
  });

  it("names the failing module among several parts", () => {
    let result = validateSpecShape({
      modules: {
        "worker.js": 'import { helper } from "./helper.js"; export default { fetch: helper };',
        "helper.js": "export function helper( {",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/helper\.js/);
    expect(result.errors.join()).not.toMatch(/worker\.js.*syntax/i);
  });

  it("accepts valid multi-module sources and skips non-JS parts", () => {
    let result = validateSpecShape({
      modules: {
        "worker.js": 'import { helper } from "./helper.js"; export default { fetch: helper };',
        "helper.js": "export const helper = () => new Response('ok');",
        "notes.txt": "this is { not JavaScript",
      },
    });
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("rejects binding/var name collisions", () => {
    let result = validateSpecShape({
      ...HELLO,
      bindings: [{ type: "r2_bucket", name: "BUCKET", bucketName: "changeguard-x-assets" }],
      vars: { BUCKET: "collide" },
    });
    expect(result.errors.join()).toMatch(/both a binding and a variable/);
  });

  it("warns on credential-looking plain-text vars", () => {
    let result = validateSpecShape({ ...HELLO, vars: { API_TOKEN: "hunter2" } });
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toMatch(/looks like a credential/);
  });
});

describe("uploadMetadata", () => {
  it("maps bindings and vars into multipart metadata", () => {
    let metadata = uploadMetadata({
      ...HELLO,
      compatibilityFlags: ["nodejs_compat"],
      bindings: [{ type: "kv_namespace", name: "KV", namespaceId: "abc" }],
      vars: { MODE: "test" },
      message: "first deploy",
    }, "2026-09-04");
    expect(metadata).toEqual({
      main_module: MAIN_MODULE_DEFAULT,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "KV", namespace_id: "abc" },
        { type: "plain_text", name: "MODE", text: "test" },
      ],
      annotations: { "workers/message": "first deploy" },
    });
  });
});

describe("validateBindingOwnership", () => {
  function fakeApi(overrides: Partial<WorkersApi>): WorkersApi {
    return overrides as WorkersApi;
  }

  it("passes resources named after the worker", async () => {
    let errors = await validateBindingOwnership({
      ...HELLO,
      bindings: [
        { type: "kv_namespace", name: "KV", namespaceId: "1" },
        { type: "d1", name: "DB", databaseId: "2" },
        { type: "r2_bucket", name: "BUCKET", bucketName: "changeguard-a-assets" },
      ],
    }, "changeguard-a", fakeApi({
      getKvNamespaceTitle: async () => "changeguard-a-sessions",
      getD1DatabaseName: async () => "changeguard-a-db",
      r2BucketExists: async () => true,
    }));
    expect(errors).toEqual([]);
  });

  it("rejects another worker's resources", async () => {
    let errors = await validateBindingOwnership({
      ...HELLO,
      bindings: [
        { type: "kv_namespace", name: "KV", namespaceId: "1" },
        { type: "r2_bucket", name: "BUCKET", bucketName: "changeguard-b-assets" },
      ],
    }, "changeguard-a", fakeApi({
      getKvNamespaceTitle: async () => "changeguard-b-sessions",
    }));
    expect(errors.join()).toMatch(/not owned by "changeguard-a"/);
    expect(errors.join()).toMatch(/changeguard-b-assets/);
  });

  it("rejects missing resources", async () => {
    let errors = await validateBindingOwnership({
      ...HELLO,
      bindings: [{ type: "d1", name: "DB", databaseId: "gone" }],
    }, "changeguard-a", fakeApi({ getD1DatabaseName: async () => null }));
    expect(errors.join()).toMatch(/does not exist/);
  });
});

describe("DeploySessionImpl", () => {
  function fakeQueue() {
    let observations: unknown[] = [];
    return {
      observations,
      authorizeObservation(value: unknown) {
        observations.push(value);
        return Promise.resolve();
      },
    };
  }

  it("authorizes the observation before returning the target", async () => {
    let queue = fakeQueue();
    let session = new DeploySessionImpl(
      queue,
      { getSubdomain: async () => "nimbus-labs" } as unknown as WorkersApi,
      "changeguard-terrific-tiger",
      "changeguard-",
      "2026-09-04",
    );
    await expect(session.getTarget()).resolves.toEqual({
      workerName: "changeguard-terrific-tiger",
      workerPrefix: "changeguard-",
      url: "https://changeguard-terrific-tiger.nimbus-labs.workers.dev",
    });
    expect(queue.observations).toHaveLength(1);
  });

  it("refuses to deploy a spec with validation errors", async () => {
    let session = new DeploySessionImpl(
      fakeQueue(),
      {} as WorkersApi,
      "changeguard-terrific-tiger",
      "changeguard-",
      "2026-09-04",
    );
    await expect(session.deploy({ modules: {} })).rejects.toThrow(/Deploy refused/);
  });

  it("refuses to roll back to an unknown version", async () => {
    let session = new DeploySessionImpl(
      fakeQueue(),
      { listVersions: async () => [{ id: "v1", number: 1 }] } as unknown as WorkersApi,
      "changeguard-terrific-tiger",
      "changeguard-",
      "2026-09-04",
    );
    await expect(session.rollback("nope")).rejects.toThrow(/not among/);
  });

  it("rolls back to a listed version and redeploys it at 100%", async () => {
    let deploys: unknown[][] = [];
    let session = new DeploySessionImpl(
      fakeQueue(),
      {
        listVersions: async () => [{ id: "v1", number: 1 }, { id: "v2", number: 2 }],
        deployVersion: async (...args: unknown[]) => {
          deploys.push(args);
          return { id: "d1" };
        },
        getSubdomain: async () => null,
      } as unknown as WorkersApi,
      "changeguard-terrific-tiger",
      "changeguard-",
      "2026-09-04",
    );
    let result = await session.rollback("v1");
    expect(deploys).toEqual([
      ["changeguard-terrific-tiger", "v1", "Rollback to version 1 (v1)"],
    ]);
    expect(result.versionId).toBe("v1");
    expect(result.deploymentId).toBe("d1");
  });

  it("reports the deployed version as current in getStatus", async () => {
    let session = new DeploySessionImpl(
      fakeQueue(),
      {
        getScriptSettings: async () => ({ compatibility_date: "2026-09-04", bindings: [] }),
        listDeployments: async () => [
          { id: "d1", versions: [{ version_id: "v2", percentage: 100 }] },
        ],
        listVersions: async () => [{ id: "v1", number: 1 }, { id: "v2", number: 2 }],
        getSubdomain: async () => null,
      } as unknown as WorkersApi,
      "changeguard-terrific-tiger",
      "changeguard-",
      "2026-09-04",
    );
    let status = await session.getStatus();
    expect(status.current?.versionId).toBe("v2");
    expect(status.current?.deployed).toBe(true);
    expect(status.recentVersions).toHaveLength(2);
    expect(status.compatibilityDate).toBe("2026-09-04");
  });
});
