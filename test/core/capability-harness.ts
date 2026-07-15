import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  bindCapability,
  coreErrorRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  sourceReferenceSchema,
  type AnyReadCapabilityDefinition,
  type CapabilityBinding,
  type CapabilityInput,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationWriter,
} from "../../src/core/index.js";

export const fixedEvaluationTime = "2026-07-12T10:16:02.000Z";

export interface CapabilityHarness {
  readonly invocationAuthority: ReturnType<typeof createCapabilityInvocationAuthority>;
  readonly ports: InvocationBoundaryPorts;
}

export const createCapabilityHarness = (
  now: () => unknown = () => fixedEvaluationTime,
): CapabilityHarness => {
  const clock = createCanonicalClock(now);
  const authorities = [
    createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "rpc_test",
        uri: "https://rpc.example/",
      }),
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
    invocationAuthority: createCapabilityInvocationAuthority(clock),
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
): CapabilityBinding<Definition> => bindCapability({
  definition,
  errorRegistry: coreErrorRegistry,
  invocationAuthority: harness.invocationAuthority,
  createInvocationPorts: () => harness.ports,
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
