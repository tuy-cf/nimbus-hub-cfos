import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareApiError, WorkersApi } from "../src/cloudflare-api.js";

const API = new WorkersApi("token", "account-id");

type FetchCall = { url: string; method: string; body?: BodyInit | null };

// Envelope shapes here mirror the live Cloudflare API (verified by direct probes):
// versions list -> result.items, deployments list -> result.deployments.
function stubFetch(result: unknown, status = 200, errors: { code: number; message: string }[] = []) {
  let calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    return new Response(
      JSON.stringify({ success: status < 400 && errors.length === 0, errors, result }),
      { status },
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("WorkersApi response envelopes", () => {
  it("reads the versions list from result.items", async () => {
    stubFetch({ items: [{ id: "v1", number: 1 }, { id: "v2", number: 2 }] });
    let versions = await API.listVersions("changeguard-x", 10);
    expect(versions.map(v => v.id)).toEqual(["v1", "v2"]);
  });

  it("tolerates a bare-array versions result", async () => {
    stubFetch([{ id: "v1", number: 1 }]);
    await expect(API.listVersions("changeguard-x", 10)).resolves.toHaveLength(1);
  });

  it("reads the deployments list from result.deployments", async () => {
    stubFetch({ deployments: [{ id: "d1", versions: [{ version_id: "v1", percentage: 100 }] }] });
    let deployments = await API.listDeployments("changeguard-x");
    expect(deployments[0]?.versions?.[0]?.version_id).toBe("v1");
  });

  it("tolerates a bare-array deployments result", async () => {
    stubFetch([{ id: "d1" }]);
    await expect(API.listDeployments("changeguard-x")).resolves.toHaveLength(1);
  });
});

describe("WorkersApi 404 handling", () => {
  it("maps a missing Worker's settings, subdomain, and deployments to empty values", async () => {
    stubFetch(null, 404, [{ code: 10007, message: "workers.api.error.not_found" }]);
    await expect(API.getScriptSettings("changeguard-x")).resolves.toBeNull();
    await expect(API.getSubdomain("changeguard-x")).resolves.toBeNull();
    await expect(API.listDeployments("changeguard-x")).resolves.toEqual([]);
  });
});

describe("WorkersApi deployVersion", () => {
  it("annotates with workers/message only, never the platform-owned workers/triggered_by", async () => {
    let calls = stubFetch({ id: "d1" });
    await API.deployVersion("changeguard-x", "v1", "Deploy of 1 module(s)");
    let body = JSON.parse(String(calls[0]?.body));
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/workers/scripts/changeguard-x/deployments");
    expect(body.strategy).toBe("percentage");
    expect(body.versions).toEqual([{ version_id: "v1", percentage: 100 }]);
    expect(body.annotations).toEqual({
      "workers/message": "[gatekeeper-deploy] Deploy of 1 module(s)",
    });
    expect(Object.keys(body.annotations)).not.toContain("workers/triggered_by");
  });

  it("surfaces the API error code and message", async () => {
    stubFetch(null, 400, [{ code: 10210, message: "Invalid deployment" }]);
    let error = await API.deployVersion("changeguard-x", "v1", "m").catch(e => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error.code).toBe(10210);
    expect(error.message).toBe("Invalid deployment");
  });
});
