import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

export default {
  initial: {},
  isReady: () => true,
  resourceUrl: ({ ui }) => ui.resourceUrl(),
  render: () => <Section>Connect this gadget to your private Linux workspace.</Section>,
} satisfies ConfiguratorUISpec<{ resourceUrl(): Promise<string> }, Record<string, never>>;
