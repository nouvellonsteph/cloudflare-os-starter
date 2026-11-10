import { withTests } from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/** Cold tests generate the frame first; emitted tsc files stay out of the build fingerprint. */
export default {
  ...withTests,
  run: { tasks: {
    ...withTests.run.tasks,
    build: { ...withTests.run.tasks.build, cache: { input: [{ auto: true }, { pattern: "!dist/**", base: "package" }], output: ["dist/**"] } },
    test: { ...vitestTask(["tsc -p tsconfig.test.json --noEmit", "vitest run"]), dependsOn: ["build:configurator"] },
  } },
};
