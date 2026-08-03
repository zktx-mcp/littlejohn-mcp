import { createCliProcessOutputOwner } from "../../src/cli.js";

const payload = "output-settlement-boundary\n".repeat(65_536);
const owner = createCliProcessOutputOwner(process.stdout, process.stderr);
owner.writeOutput(payload);
await owner.settle();
