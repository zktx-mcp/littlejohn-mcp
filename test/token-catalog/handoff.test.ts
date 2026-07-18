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
  tokenRegistrationSchema,
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
    expect(databaseSchemaVersion).toBe(3);
    expect(runtimeProtocolVersion).toBe(3);
    expect(currentSqliteTableNames).toHaveLength(9);
    expect(schemaDigest).toBe("cf27079d42c4b3bbe70e3ac8a895478463103507d89a1d69fbf82fd984814183");
    expect(canonicalSha256(tableManifest)).toBe("b742c8773e71cd37ad5a9cd58ebb6b9b3d474f9575d046b8a9142a8fc4401512");
    expect(canonicalSha256(internalProjection as CanonicalJson)).toBe("9888a28320ad8a003298ba3f61ef5abcb80d2e95da41db3b2838a38b02666515");
    expect(canonicalSha256(supportProjection as CanonicalJson)).toBe("f49676415ef62b233d2fb939d73e253a7d7404f80622160b3e34a718961f643c");
  });

  it("keeps a maximum registration page within the compatible-process response limit", () => {
    const chainId = `eip155:${"9".repeat(32)}`;
    const walletAddress = `0x${"f".repeat(40)}`;
    const lastAddress = BigInt(`0x${"f".repeat(40)}`);
    const createdAt = "9999-12-31T23:59:59.999Z";
    const maximumValidEscapedLabel = "\\".repeat(tokenCatalogContractLimits.displayTextCodePoints);
    const registrations = Array.from({ length: tokenCatalogContractLimits.listMaximumLimit }, (_, index) =>
      tokenRegistrationSchema.parse({
        account: { chainId, address: walletAddress },
        asset: {
          kind: "erc20",
          chainId,
          address: `0x${(lastAddress - BigInt(tokenCatalogContractLimits.listMaximumLimit - index - 1))
            .toString(16).padStart(40, "0")}`,
        },
        revision: Buffer.alloc(tokenCatalogContractLimits.registrationRevisionBytes, index + 1)
          .toString("base64url"),
        inspectionDigest: `0x${index.toString(16).padStart(64, "0")}`,
        userLabel: maximumValidEscapedLabel,
        visibility: "visible",
        createdAt,
        updatedAt: createdAt,
      }));
    const validPage = tokenCatalogApplicationContracts.registrations.parseSuccess(
      { limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null },
      { registrations, nextCursor: null },
    );
    expect(Buffer.byteLength(canonicalJsonStringify(
      captureCanonicalJson(validPage),
    ), "utf8")).toBeLessThanOrEqual(internalResponseLimitBytes);

    const conservativeEscapingPage = captureCanonicalJson({
      registrations: registrations.map((registration) => ({
        ...registration,
        userLabel: "\\".repeat(tokenCatalogContractLimits.displayTextUtf8Bytes),
      })),
      nextCursor: null,
    });
    expect(Buffer.byteLength(
      canonicalJsonStringify(conservativeEscapingPage),
      "utf8",
    )).toBeLessThanOrEqual(internalResponseLimitBytes);
  });
});
