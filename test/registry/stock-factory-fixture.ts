import { parseHexBytes } from "../../src/core/index.js";
import {
  stockFactoryImplementationCodeFixture as implementationCodeHex,
  stockFactoryProxyCodeFixture as proxyCodeHex,
} from "../../scripts/release/stock-factory-fixture.mjs";

export const stockFactoryProxyCodeFixture = parseHexBytes(proxyCodeHex);
export const stockFactoryImplementationCodeFixture = parseHexBytes(implementationCodeHex);
