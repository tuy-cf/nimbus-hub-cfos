import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  DeployConfiguratorRpc,
  DeployConfiguratorValues,
} from "./deploy-configurator-types";

export default {
  initial: { workerName: null, error: null },

  isReady({ values }) {
    return !!values.workerName && !values.error;
  },

  resourceUrl({ values }) {
    return `deploy://workers/${values.workerName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Worker name"
        description={values.error ??
          "The workshop Worker this deploy capability controls, from your roster assignment."}
      >
        <TextInput
          name="workerName"
          value={values.workerName}
          placeholder="cg-your-slot"
          onChange={async workerName => {
            let error = workerName ? await ui.checkWorkerName(workerName) : null;
            setValues({ workerName, error });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DeployConfiguratorRpc, DeployConfiguratorValues>;
