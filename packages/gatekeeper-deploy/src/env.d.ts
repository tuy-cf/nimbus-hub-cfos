declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "DeployGatekeeper";
  }

  // Deployment-provided environment, merged with wrangler's generated declaration. The vars come
  // from the generated wrangler.prod.jsonc (cf-os derives them from deployment.jsonc); the token
  // is a Wrangler secret.
  interface Env {
    CLOUDFLARE_ACCOUNT_ID: string;
    DEPLOY_WORKER_PREFIX: string;
    DEPLOY_COMPATIBILITY_DATE: string;
    CLOUDFLARE_API_TOKEN: string;
    /** Optional public URL template for deployed apps, e.g. "https://app.{slot}.example.com". */
    DEPLOY_PUBLIC_URL_PATTERN?: string;
  }
}
