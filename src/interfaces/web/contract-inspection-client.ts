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
  BrowserRequestError,
  invalidBrowserResponse,
  queryPublicBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const invalidInspectionResponse = (): BrowserRequestError =>
  invalidBrowserResponse();

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
    if (error instanceof BrowserRequestError) throw error;
    throw invalidInspectionResponse();
  }
};

export type ContractInspectionRequest = ContractInspectInput;
