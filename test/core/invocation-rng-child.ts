import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto") as {
  randomBytes(size: number): Buffer;
};
const originalRandomBytes = crypto.randomBytes;
const mode = process.argv[2];
let randomByteCalls = 0;
let handlerCalls = 0;

crypto.randomBytes = (size: number): Buffer => {
  randomByteCalls += 1;
  if (size !== 32) throw new Error("unexpected-random-byte-count");
  if (mode === "failure") throw new Error("secret-rng-provider-detail");
  return Buffer.alloc(size, 7);
};
syncBuiltinESMExports();

try {
  const {
    chainAnchorSchema,
    chainStatusCapability,
  } = await import("../../src/core/index.js");
  const {
    bindForHarness,
    createCapabilityHarness,
    invokeBinding,
  } = await import("./capability-harness.js");

  const block = chainAnchorSchema.parse({
    chainId: "eip155:4663",
    blockNumber: "10",
    blockHash: `0x${"a".repeat(64)}`,
    blockTimestamp: "2026-07-12T10:16:02.000Z",
  });
  const harness = createCapabilityHarness();
  const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
    handlerCalls += 1;
    const source = context.ports.observations.get("chain_rpc");
    observations.record("rpc_chain_id", {
      source,
      claims: [{ role: "chain_id", value: "eip155:4663" }],
    });
    observations.record("latest_block", {
      source,
      claims: [{ role: "latest_block", value: block, chainAnchor: block }],
    });
    return {
      status: "success",
      data: { chainId: "eip155:4663", latestBlock: block },
    };
  });
  const result = await invokeBinding(chainStatusCapability, binding, {});
  process.stdout.write(JSON.stringify({ randomByteCalls, handlerCalls, block, result }));
} finally {
  crypto.randomBytes = originalRandomBytes;
  syncBuiltinESMExports();
}
