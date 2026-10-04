import {chainAnchorSchema} from "../../src/evm/client.js";
import {chainStatusEvidence, chainStatusCapability} from "../../src/chain/client.js";
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
    const chain = observations.bind(chainStatusEvidence.configuredChain.target);
    const latest = observations.bind(chainStatusEvidence.targets.latestBlock);
    observations.record(chain.slot, {
      source,
      claims: [{ role: chain.roles.chainId, value: "eip155:4663" }],
    });
    observations.record(latest.slot, {
      source,
      claims: [{ role: latest.roles.block, value: block, chainAnchor: block }],
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
