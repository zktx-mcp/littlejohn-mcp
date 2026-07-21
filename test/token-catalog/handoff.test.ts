import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/index.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { runtimeProtocolVersion } from "../../src/runtime/runtime-identity.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import {
  currentSqliteSchemaSql,
  currentSqliteTableNames,
  databaseSchemaVersion,
} from "../../src/runtime/sqlite-schema.js";
import { internalResponseLimitBytes } from "../../src/runtime/http-boundary.js";
import { tokenCatalogCoordinatorPolicy } from "../../src/token-catalog/coordinator.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogContractLimits,
  tokenCatalogContractProjectionDigest,
  tokenSelectionSchema,
} from "../../src/token-catalog/contracts.js";
import { tokenCatalogConsumerPortContract } from "../../src/token-catalog/ports.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

const internalProjection = captureCanonicalJson({
  contractProjectionDigest: tokenCatalogContractProjectionDigest,
  databaseSchemaVersion,
  runtimeProtocolVersion,
  consumerPorts: tokenCatalogConsumerPortContract,
  coordinatorPolicy: tokenCatalogCoordinatorPolicy,
});

const supportProjection = captureCanonicalJson(readRuntimeSupportManifest(
  extendTokenCatalogSupportManifest(
    extendChainSupportManifest(
      extendWalletSupportManifest(
        createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      ),
    ),
  ),
));

const schemaDigest = createHash("sha256").update(currentSqliteSchemaSql, "utf8").digest("hex");
const tableManifest = captureCanonicalJson([...currentSqliteTableNames].sort()) as CanonicalJson;

describe("token catalog WU2 handoff", () => {
  it("fixes the exact schema, contract, consumer-port, operation-timing, and support projections", () => {
    expect(databaseSchemaVersion).toBe(6);
    expect(runtimeProtocolVersion).toBe(7);
    expect(currentSqliteTableNames).toHaveLength(12);
    expect(schemaDigest).toBe("9e3adf4d89ae942c91e807fbf51521dffd8175fc34f036dd2d3756ed53a8ebb9");
    expect(canonicalSha256(tableManifest)).toBe("a5b10e2c44f58b93657651a89d34ff70c7b74c847ed882810727d2e246b7cdfd");
    expect(canonicalSha256(internalProjection as CanonicalJson)).toBe("03eb0ec53fa4a8ac90ae385b134c13743ec043426cfb4c0397bbefa710cff6e2");
    expect(canonicalSha256(supportProjection as CanonicalJson)).toBe("8f1f425cd7539b95a4d6c7c7e22a10cc45a7c52bee2c85cef4f002db26d4f5f3");
  });

  it("keeps a maximum selection page within the compatible-process response limit", () => {
    const chainId = `eip155:${"9".repeat(32)}`;
    const walletAddress = `0x${"f".repeat(40)}`;
    const lastAddress = BigInt(`0x${"f".repeat(40)}`);
    const createdAt = "9999-12-31T23:59:59.999Z";
    const selections = Array.from({ length: tokenCatalogContractLimits.listMaximumLimit }, (_, index) =>
      tokenSelectionSchema.parse({
        account: { chainId, address: walletAddress },
        asset: {
          kind: "erc20",
          chainId,
          address: `0x${(lastAddress - BigInt(tokenCatalogContractLimits.listMaximumLimit - index - 1))
            .toString(16).padStart(40, "0")}`,
        },
        included: index % 2 === 0,
        revision: Buffer.alloc(tokenCatalogContractLimits.selectionRevisionBytes, index + 1)
          .toString("base64url"),
        createdAt,
        updatedAt: createdAt,
      }));
    const validPage = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      { limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null },
      { selections, nextCursor: null },
    );
    expect(Buffer.byteLength(`${canonicalJsonStringify(
      captureCanonicalJson(validPage),
    )}\n`, "utf8")).toBeLessThanOrEqual(internalResponseLimitBytes);

  });
});
