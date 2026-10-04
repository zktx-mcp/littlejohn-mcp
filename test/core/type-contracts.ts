import {chainStatusCapability} from "../../src/chain/read-contracts.js";
import {type CapabilityBinding, type Hash32, type UnsignedDecimal} from "../../src/core/index.js";
import {type EvmAddress, type EvmChainId} from "../../src/evm/identities.js";

declare const plain: string;
declare const address: EvmAddress;
declare const chainId: EvmChainId;
declare const hash: Hash32;
declare const amount: UnsignedDecimal;

const acceptsAddress = (_value: EvmAddress): void => undefined;
const acceptsChainId = (_value: EvmChainId): void => undefined;
const acceptsHash = (_value: Hash32): void => undefined;
const acceptsAmount = (_value: UnsignedDecimal): void => undefined;

acceptsAddress(address);
acceptsChainId(chainId);
acceptsHash(hash);
acceptsAmount(amount);

// @ts-expect-error Plain strings cannot cross a nominal address boundary.
acceptsAddress(plain);
// @ts-expect-error Plain strings cannot cross a nominal chain identity boundary.
acceptsChainId(plain);
// @ts-expect-error An address cannot cross a chain identity boundary.
acceptsChainId(address);
// @ts-expect-error A hash cannot cross an address boundary.
acceptsAddress(hash);
// @ts-expect-error An address cannot cross an integer boundary.
acceptsAmount(address);

declare const chainBinding: CapabilityBinding<typeof chainStatusCapability>;
// @ts-expect-error Raw Zod schemas are not exposed by opaque capability definitions.
chainStatusCapability.inputSchema;
// @ts-expect-error Opaque bindings are invoked only through CapabilityBindingRegistry.
chainBinding({}, { signal: new AbortController().signal });
