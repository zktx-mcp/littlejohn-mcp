import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  bindCapability,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  evmChainIdSchema,
  sourceReferenceSchema,
  type AnyReadCapabilityDefinition,
  type ApplicationErrorRegistry,
  type CapabilityBinding,
  type CapabilityInput,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationWriter,
  type SourceReference,
} from "../../src/core/index.js";
import { chainErrorRegistry } from "../../src/chain/errors.js";

export const fixedEvaluationTime = "2026-07-12T10:16:02.000Z";
export const configuredChainId = evmChainIdSchema.parse("eip155:4663");

export interface CapabilityHarness {
  readonly invocationAuthority: ReturnType<typeof createCapabilityInvocationAuthority>;
  readonly ports: InvocationBoundaryPorts;
}

export const createCapabilityHarness = (
  now: () => unknown = () => fixedEvaluationTime,
  chainId: string = configuredChainId,
  chainRpc: Readonly<{
    owner: string;
    reference: SourceReference;
  }> = Object.freeze({
    owner: "user_configured",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "rpc_test",
      uri: "https://rpc.example/",
    }),
  }),
): CapabilityHarness => {
  const clock = createCanonicalClock(now);
  const authorities = [
    createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: chainRpc.owner,
      reference: chainRpc.reference,
    }),
    createObservationAuthority({
      clock,
      sourceClass: "wallet_sdk",
      owner: "WalletConnect SDK",
      reference: sourceReferenceSchema.parse({
        kind: "wallet_sdk",
        sourceId: `wallet-sdk:${"A".repeat(22)}`,
      }),
    }),
    createObservationAuthority({
      clock,
      sourceClass: "wallet_session",
      owner: "WalletConnect session",
      reference: sourceReferenceSchema.parse({
        kind: "wallet_session",
        sourceId: `wallet-session:${"A".repeat(43)}`,
        topicDigest: "A".repeat(43),
      }),
    }),
  ];
  return Object.freeze({
    invocationAuthority: createCapabilityInvocationAuthority(clock, evmChainIdSchema.parse(chainId)),
    ports: Object.freeze({ observations: new ObservationAuthorityRegistry(clock, authorities) }),
  });
};

export const bindForHarness = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  harness: CapabilityHarness,
  handler: (
    input: CapabilityInput<Definition>,
    context: HandlerInvocationContext,
    observations: ObservationWriter,
  ) => Promise<unknown>,
  errorRegistry: ApplicationErrorRegistry = chainErrorRegistry,
): CapabilityBinding<Definition> => bindCapability({
  definition,
  errorRegistry,
  invocationAuthority: harness.invocationAuthority,
  createInvocationPorts: (_input) => harness.ports,
  handler,
});

export const invokeBinding = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  binding: CapabilityBinding<Definition>,
  input: unknown,
) => new CapabilityBindingRegistry(
  new CapabilityRegistry([definition]),
  [binding],
).invoke(definition, input, { signal: new AbortController().signal });
