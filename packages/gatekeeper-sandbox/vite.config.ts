import configurator from "@gadgets/scripts/gatekeeper-configurator";

export default {
  run: {
    tasks: {
      ...configurator.run.tasks,
      build: {
        command: ["node build-app.ts", "wrangler types --include-env=false", "tsc", "tsc -p tsconfig.app.json"],
        dependsOn: ["build:configurator"],
        cache: false,
      },
    },
  },
};
