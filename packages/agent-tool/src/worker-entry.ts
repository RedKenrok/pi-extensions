import { parseArgs } from "node:util";
import { runWorker } from "./worker.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
await runWorker(values.config);
