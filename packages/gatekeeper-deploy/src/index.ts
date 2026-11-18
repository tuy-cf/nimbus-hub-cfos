export * from "./deploy.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Workshop Deploy gatekeeper is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
