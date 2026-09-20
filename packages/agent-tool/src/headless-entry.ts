import { parseArgs } from "node:util";
import { runHeadless } from "./headless.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
await runHeadless(values.config);
