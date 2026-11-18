import { withTests } from "@gadgets/scripts/gatekeeper-configurator";

// Shared gatekeeper tasks (configurator codegen + tsc) plus this package's own vitest pass.
export default withTests;
