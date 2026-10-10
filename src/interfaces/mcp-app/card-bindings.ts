import { captureCanonicalJson, type ApplicationContract, type OperationId } from "../../core/index.js";
import { createLocalOperationIdentity, type LocalOperationIdentity, type LocalOperationBinding, type LocalWalletRequestBinding, type LocalSelectorBinding } from "../local-operation.js";
import { cardControlResources, cardCreationTransportEnvelopeSchema } from "./card-controls.js";
import { admitCardActionDelivery, cardActionResponseLimitBytes, cardActionEnvelopeSchema, cardControlContracts, cardErrorRegistry,
  cardPresentationDeliverySchema, type CardPresentation, type CardPresentationDelivery, type CardActionDelivery, type CardCreationResult } from "./card-contract.js";
import { cardInterfaceErrorMappings } from "./card-errors.js";
import { cardReferenceContract } from "./card-contract.js";
import { cardToolContracts, cardReadStartTool, cardDecisionStartTool } from "./card-tool-contracts.js";

export const cardReferenceIdentity = createLocalOperationIdentity({
  action: "read", contract: cardReferenceContract, errorMappings: cardInterfaceErrorMappings,
  operationId: (input) => input.cardId,
  actionRequest: (input) => ({ method: "POST", path: cardControlResources.reference, body: captureCanonicalJson(input) }),
  parseActionResponse: (input, _id, value) => cardReferenceContract.parsePublicSuccess(input, value),
});

export interface CardDecisionInput<Input> {
  readonly cardId: string;
  readonly cardOpenRequestId: string;
  readonly decision: Input;
}

// This adapter changes only the transport envelope. The backend card owner
// admits state, and the original binding still admits the exact domain response.
export const createCardDecisionIdentity = <Input, Result>(
  original: LocalOperationBinding<Input, Result> | LocalWalletRequestBinding<Input, Result> | LocalSelectorBinding<Input, Result>,
): LocalOperationIdentity<CardDecisionInput<Input>, CardActionDelivery<Result>> => {
  if (original.action !== "wallet_request" && original.action !== "decide" && original.action !== "select_account") {
    throw new TypeError("Only a direct decision can use card transport.");
  }
  const common = {
    maximumResponseBytes: cardActionResponseLimitBytes,
    contract: { errorRegistry: cardErrorRegistry,
      parseInput: (value: unknown): CardDecisionInput<Input> => {
        const envelope = cardActionEnvelopeSchema.parse(captureCanonicalJson(value));
        return { ...envelope, decision: original.contract.parseInput(envelope.decision) };
      },
      normalizeFailure: cardControlContracts.read.normalizeFailure,
    },
    errorMappings: cardInterfaceErrorMappings,
    operationId: (input: CardDecisionInput<Input>) => original.operationId(input.decision),
    actionRequest: (input: CardDecisionInput<Input>) => ({ method: "POST" as const,
      path: cardControlResources.action, body: captureCanonicalJson(input) }),
  };
  if (original.action === "wallet_request") return createLocalOperationIdentity({
    ...common, action: "wallet_request", responseDeadlineMilliseconds: original.responseDeadlineMilliseconds,
    operationId: (input: CardDecisionInput<Input>) => original.operationId(input.decision),
    responseContext: (input: CardDecisionInput<Input>) => original.responseContext(input.decision),
    parseActionResponse: (context, value) => {
      const delivery = admitCardActionDelivery(value);
      const result = original.parseActionResponse(context, delivery.result);
      const operationId = context.kind === "signing" ? context.context.operationId : context.operationId;
      if (!("status" in delivery.presentation) && delivery.presentation.state.record?.kind !== "read" && delivery.presentation.state.record?.kind !== "preparing" &&
          delivery.presentation.state.record?.operationId !== operationId) throw new TypeError("Card response operation differs.");
      return { ...delivery, result };
    },
  });
  const parseActionResponse = (input: CardDecisionInput<Input>, id: OperationId | undefined, value: unknown): CardActionDelivery<Result> => {
    const delivery = admitCardActionDelivery(value);
    const cardId = "status" in delivery.presentation ? delivery.presentation.cardId : delivery.presentation.state.reference.kind === "card"
      ? delivery.presentation.state.reference.cardId : undefined;
    if (cardId !== input.cardId) throw new TypeError("Card response identity differs.");
    if (!("status" in delivery.presentation)) {
      const record = delivery.presentation.state.record;
      if (record === null || record.kind === "read" || record.kind === "preparing") throw new TypeError("Card response has no decision source.");
      if (original.action === "select_account" ? record.kind !== "wallet_selection" : record.operationId !== id) throw new TypeError("Card response source differs.");
    }
    return { ...delivery, result: original.parseActionResponse(input.decision, id, delivery.result) };
  };
  if (original.action === "select_account") return createLocalOperationIdentity({
    ...common, action: "select_account", parseActionResponse,
    selector: (input: CardDecisionInput<Input>) => ({ ...original.selector(input.decision), cardId: input.cardId }),
  });
  return createLocalOperationIdentity({ ...common, action: original.action, parseActionResponse });
};

const bind = <Input>(
  key: keyof typeof cardToolContracts,
  contract: ApplicationContract<Input, Record<string, never>, CardPresentation>,
  operationId: (input: Input) => OperationId | undefined,
) => createLocalOperationIdentity<Input, CardPresentationDelivery>({
  action: key === "read" ? "read" : key === "open" ? "decide" : "cancel",
  contract,
  errorMappings: cardInterfaceErrorMappings,
  operationId,
  actionRequest: (input: Input) => ({
    method: "POST" as const, path: cardControlResources[key], body: captureCanonicalJson(input),
  }),
  parseActionResponse: (input, _id, result) => {
    const delivery = cardPresentationDeliverySchema.parse(result);
    contract.parsePublicSuccess(input, delivery.presentation);
    return delivery;
  },
});

const creationIdentity = <Input>(contract: ApplicationContract<Input, Record<string, never>, CardCreationResult>, path: string) =>
  createLocalOperationIdentity({
    action: "read", contract: { errorRegistry: contract.errorRegistry, normalizeFailure: contract.normalizeFailure,
      parseInput: (value: unknown) => {
        const envelope = cardCreationTransportEnvelopeSchema.parse(captureCanonicalJson(value));
        return {input: contract.parseNormalizedInput(envelope.input), publicationKey: envelope.publicationKey};
      },
    }, errorMappings: cardInterfaceErrorMappings,
    operationId: () => undefined,
    actionRequest: (input) => ({ method: "POST", path, body: captureCanonicalJson(input) }),
    parseActionResponse: (input, _id, result) => contract.parsePublicSuccess(input.input, result),
});
export const cardReadStartBinding = Object.freeze({ ...cardReadStartTool,
  identity: creationIdentity(cardReadStartTool.contract, cardControlResources.startRead),
});
export const cardDecisionStartBinding = Object.freeze({ ...cardDecisionStartTool,
  identity: creationIdentity(cardDecisionStartTool.contract, cardControlResources.startDecision),
});

// The existing client owns authenticated sessions, bounded delivery and cleanup.
// These controls have no automatic recovery or resend; only an admitted reply
// establishes the saved state. A lost reply permits a later explicit exact read.
export const cardBindings = Object.freeze({
  read: { ...cardToolContracts.read, identity: bind("read", cardToolContracts.read.contract,
    (input) => input.kind === "card" ? input.cardId : undefined) },
  open: { ...cardToolContracts.open, identity: bind("open", cardToolContracts.open.contract,
    (input) => input.cardId) },
  discard: { ...cardToolContracts.discard, identity: bind("discard", cardToolContracts.discard.contract,
    (input) => input.cardId) },
  stop: { ...cardToolContracts.stop, identity: bind("stop", cardToolContracts.stop.contract,
    (input) => input.cardId) },
});
