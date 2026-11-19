// Spec validation for the Deploy Gatekeeper. Split from the RPC layer so every rule is unit
// testable without workerd. Shape checks are pure; binding ownership needs the account API and
// is injected.

import { parse } from "acorn";
import type { WorkersApi } from "./cloudflare-api.js";
import type { DeploySpec, DeployValidation } from "./types.js";

export const MAIN_MODULE_DEFAULT = "worker.js";
/** Headroom under Workers' per-script size limits; the account API enforces its own. */
export const MAX_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_MODULE_COUNT = 64;
/** Cloudflare caps deployment messages at 1000 bytes. */
export const MAX_MESSAGE_LENGTH = 1000;

const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const COMPAT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
/** Names that look like credentials smuggled through plain-text vars. */
const SECRETISH = /secret|token|password|private[_-]?key|credential/i;

/** Whether `workerName` is deployable at all under this deployment's prefix. */
export function workerNameAllowed(workerName: string, prefix: string): boolean {
  return WORKER_NAME.test(workerName)
    && workerName.startsWith(prefix)
    && workerName.length > prefix.length;
}

/**
 * Every mutation-independent rule. Ownership of bound resources is checked separately (see
 * validateBindingOwnership), since it needs account reads.
 */
export function validateSpecShape(spec: DeploySpec): DeployValidation {
  let errors: string[] = [];
  let warnings: string[] = [];

  // Modules.
  let modules = spec.modules ?? {};
  let partNames = Object.keys(modules);
  if (partNames.length === 0) {
    errors.push("spec.modules is empty: at least one ES module (the main module) is required.");
  }
  if (partNames.length > MAX_MODULE_COUNT) {
    errors.push(`spec.modules has ${partNames.length} parts; the limit is ${MAX_MODULE_COUNT}.`);
  }
  let totalBytes = 0;
  for (let [part, source] of Object.entries(modules)) {
    if (!PART_NAME.test(part)) {
      errors.push(`Module part name "${part}" is invalid (letters, digits, dot, dash, underscore).`);
    }
    if (typeof source !== "string" || source.length === 0) {
      errors.push(`Module part "${part}" has no source.`);
      continue;
    }
    totalBytes += source.length;
  }
  if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    errors.push(
      `Modules total ${totalBytes} bytes; the gatekeeper cap is ${MAX_TOTAL_SOURCE_BYTES}. ` +
      "Split the app or move static content out of the Worker source.",
    );
  }
  let mainModule = spec.mainModule ?? MAIN_MODULE_DEFAULT;
  if (!PART_NAME.test(mainModule)) {
    errors.push(`Main module name "${mainModule}" is invalid.`);
  } else if (partNames.length > 0 && !(mainModule in modules)) {
    errors.push(`Main module "${mainModule}" is not among the module parts.`);
  }

  // Compatibility.
  if (spec.compatibilityDate !== undefined && !COMPAT_DATE.test(spec.compatibilityDate)) {
    errors.push(`compatibilityDate "${spec.compatibilityDate}" is not a YYYY-MM-DD date.`);
  }
  if (spec.compatibilityFlags !== undefined
      && !spec.compatibilityFlags.every(flag => typeof flag === "string" && flag.length > 0)) {
    errors.push("compatibilityFlags must be non-empty strings.");
  }

  // Bindings and vars: names valid, unique, and non-overlapping.
  let bindingNames = new Set<string>();
  for (let binding of spec.bindings ?? []) {
    if (!BINDING_NAME.test(binding.name)) {
      errors.push(`Binding name "${binding.name}" is not a valid identifier.`);
    }
    if (bindingNames.has(binding.name)) {
      errors.push(`Binding name "${binding.name}" is used more than once.`);
    }
    bindingNames.add(binding.name);
  }
  let vars = spec.vars ?? {};
  for (let [name, value] of Object.entries(vars)) {
    if (!BINDING_NAME.test(name)) {
      errors.push(`Variable name "${name}" is not a valid identifier.`);
    }
    if (bindingNames.has(name)) {
      errors.push(`"${name}" is both a binding and a variable; pick one.`);
    }
    if (typeof value !== "string") {
      errors.push(`Variable "${name}" must be a string (plain text only).`);
    }
    if (SECRETISH.test(name)) {
      warnings.push(
        `Variable "${name}" looks like a credential. Secret values never belong in vars: ` +
        "set them out of band (`wrangler secret put`), where they survive every deploy.",
      );
    }
  }

  if (spec.message !== undefined && spec.message.length > MAX_MESSAGE_LENGTH) {
    errors.push(`message is ${spec.message.length} characters; Cloudflare caps it at ${MAX_MESSAGE_LENGTH}.`);
  }

  // Syntax: parse each ES module so unterminated strings and other syntax errors fail here,
  // with the module name and line/column, instead of surfacing as an opaque upload error at
  // deploy(). Staged last: no point parsing a spec that is already invalid (or oversized).
  if (errors.length === 0) {
    for (let [part, source] of Object.entries(modules)) {
      if (!/\.m?js$/.test(part)) continue;
      try {
        parse(source, { ecmaVersion: "latest", sourceType: "module" });
      } catch (error) {
        errors.push(`Module "${part}" has a JavaScript syntax error: ${(error as Error).message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Every bound resource must exist and belong to this Worker: its own name must start with the
 * Worker's name, which is what keeps one attendee's deploy from attaching another's data.
 */
export async function validateBindingOwnership(
  spec: DeploySpec,
  workerName: string,
  api: WorkersApi,
): Promise<string[]> {
  let errors: string[] = [];
  for (let binding of spec.bindings ?? []) {
    switch (binding.type) {
      case "kv_namespace": {
        let title = await api.getKvNamespaceTitle(binding.namespaceId);
        if (title === null) {
          errors.push(`KV namespace ${binding.namespaceId} does not exist on this account.`);
        } else if (!title.startsWith(workerName)) {
          errors.push(
            `KV namespace "${title}" is not owned by "${workerName}" ` +
            `(owned resource names start with the Worker name).`,
          );
        }
        break;
      }
      case "d1": {
        let name = await api.getD1DatabaseName(binding.databaseId);
        if (name === null) {
          errors.push(`D1 database ${binding.databaseId} does not exist on this account.`);
        } else if (!name.startsWith(workerName)) {
          errors.push(`D1 database "${name}" is not owned by "${workerName}".`);
        }
        break;
      }
      case "r2_bucket": {
        if (!binding.bucketName.startsWith(workerName)) {
          errors.push(`R2 bucket "${binding.bucketName}" is not owned by "${workerName}".`);
          break;
        }
        if (!await api.r2BucketExists(binding.bucketName)) {
          errors.push(`R2 bucket "${binding.bucketName}" does not exist on this account.`);
        }
        break;
      }
      default:
        errors.push(`Binding type "${(binding as { type: string }).type}" is not supported. ` +
          "Only kv_namespace, d1, and r2_bucket are deployable.");
    }
  }
  return errors;
}

/** The metadata part of a version upload, built from a validated spec. */
export function uploadMetadata(
  spec: DeploySpec,
  defaultCompatibilityDate: string,
): Record<string, unknown> {
  let bindings: Record<string, unknown>[] = (spec.bindings ?? []).map(binding => {
    switch (binding.type) {
      case "kv_namespace":
        return { type: "kv_namespace", name: binding.name, namespace_id: binding.namespaceId };
      case "d1":
        return { type: "d1", name: binding.name, id: binding.databaseId };
      case "r2_bucket":
        return { type: "r2_bucket", name: binding.name, bucket_name: binding.bucketName };
    }
  });
  for (let [name, text] of Object.entries(spec.vars ?? {})) {
    bindings.push({ type: "plain_text", name, text });
  }
  return {
    main_module: spec.mainModule ?? MAIN_MODULE_DEFAULT,
    compatibility_date: spec.compatibilityDate ?? defaultCompatibilityDate,
    ...(spec.compatibilityFlags?.length ? { compatibility_flags: spec.compatibilityFlags } : {}),
    ...(bindings.length ? { bindings } : {}),
    ...(spec.message ? { annotations: { "workers/message": spec.message } } : {}),
  };
}
