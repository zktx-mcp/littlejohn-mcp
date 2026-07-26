import {
  contractInspectCapability,
  parseCapabilityInput,
  parseCapabilitySuccess,
  type CapabilitySuccess,
  type ContractInspectData,
  type ContractInspectInput,
} from "../../core/browser.js";
import { publicInspectionPaths } from "../browser-contract.js";
import {
  BrowserResponseError,
  invalidBrowserResponse,
  queryPublicBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const invalidInspectionResponse = (): BrowserResponseError =>
  invalidBrowserResponse("The contract inspection response is invalid.");

export const inspectContract = async (
  input: unknown,
  options: BrowserRequestOptions = {},
): Promise<CapabilitySuccess<ContractInspectData>> => {
  const request = parseCapabilityInput(contractInspectCapability, input);
  try {
    return parseCapabilitySuccess(
      contractInspectCapability,
      request,
      await queryPublicBrowserJson(
        publicInspectionPaths.contractQueries,
        request,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidInspectionResponse();
  }
};

export type ContractInspectionRequest = ContractInspectInput;
