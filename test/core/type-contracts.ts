import {
  chainStatusCapability,
  type CapabilityBinding,
  type EvmAddress,
  type Hash32,
  type UnsignedDecimal,
} from "../../src/core/index.js";

declare const plain: string;
declare const address: EvmAddress;
declare const hash: Hash32;
declare const amount: UnsignedDecimal;

const acceptsAddress = (_value: EvmAddress): void => undefined;
const acceptsHash = (_value: Hash32): void => undefined;
const acceptsAmount = (_value: UnsignedDecimal): void => undefined;

acceptsAddress(address);
acceptsHash(hash);
acceptsAmount(amount);

// @ts-expect-error Plain strings cannot cross a nominal address boundary.
acceptsAddress(plain);
// @ts-expect-error A hash cannot cross an address boundary.
acceptsAddress(hash);
// @ts-expect-error An address cannot cross an integer boundary.
acceptsAmount(address);

declare const chainBinding: CapabilityBinding<typeof chainStatusCapability>;
// @ts-expect-error Raw Zod schemas are not exposed by opaque capability definitions.
chainStatusCapability.inputSchema;
// @ts-expect-error Opaque bindings are invoked only through CapabilityBindingRegistry.
chainBinding({}, { signal: new AbortController().signal });
