import { isStrictlyOrderedUnique, deepFreezeValue } from "../core/client.js";
import {
  admitProtocolFamilyDescriptor,
  admitProtocolPackageDescriptor,
  protocolDeploymentIdentityKey,
  type ProtocolDeploymentIdentity,
  type ProtocolFamilyDescriptor,
  type ProtocolPackageDescriptor,
} from "./contracts.js";

const assertOrderedUnique = (
  values: readonly string[],
  label: string,
): void => {
  if (!isStrictlyOrderedUnique(values)) {
    throw new TypeError(`${label} must be unique and ordered.`);
  }
};

export class ProtocolRegistry {
  readonly #families: ReadonlyMap<string, ProtocolFamilyDescriptor>;
  readonly #packages: ReadonlyMap<string, ProtocolPackageDescriptor>;
  readonly #deployments: ReadonlyMap<string, ProtocolDeploymentIdentity>;
  readonly #capabilityOwners: ReadonlyMap<string, string>;

  constructor(
    familiesInput: readonly ProtocolFamilyDescriptor[],
    packagesInput: readonly ProtocolPackageDescriptor[],
  ) {
    const families = familiesInput.map(admitProtocolFamilyDescriptor);
    const packages = packagesInput.map(admitProtocolPackageDescriptor);
    assertOrderedUnique(
      families.map((family) => family.familyId),
      "Protocol family registrations",
    );
    assertOrderedUnique(
      packages.map((entry) => entry.protocolId),
      "Protocol package registrations",
    );
    const familyMap = new Map(families.map((family) => [family.familyId, family]));
    const packageMap = new Map<string, ProtocolPackageDescriptor>();
    const deploymentMap = new Map<string, ProtocolDeploymentIdentity>();
    const capabilityOwners = new Map<string, string>();
    for (const entry of packages) {
      if (!familyMap.has(entry.familyId)) {
        throw new TypeError("Protocol package references an unregistered family.");
      }
      packageMap.set(entry.protocolId, entry);
      for (const deployment of entry.deployments) {
        const key = protocolDeploymentIdentityKey(deployment);
        if (deploymentMap.has(key)) {
          throw new TypeError("Duplicate protocol deployment identity.");
        }
        deploymentMap.set(key, deployment);
      }
      for (const capability of entry.capabilities) {
        if (capabilityOwners.has(capability.capabilityId)) {
          throw new TypeError("Duplicate protocol capability identity.");
        }
        capabilityOwners.set(capability.capabilityId, entry.protocolId);
      }
    }
    this.#families = familyMap;
    this.#packages = packageMap;
    this.#deployments = deploymentMap;
    this.#capabilityOwners = capabilityOwners;
    Object.freeze(this);
  }

  familyValues(): readonly ProtocolFamilyDescriptor[] {
    return deepFreezeValue([...this.#families.values()]);
  }

  packageValues(): readonly ProtocolPackageDescriptor[] {
    return deepFreezeValue([...this.#packages.values()]);
  }

  getFamily(familyId: string): ProtocolFamilyDescriptor {
    const family = this.#families.get(familyId);
    if (family === undefined) throw new TypeError("Unknown protocol family identity.");
    return family;
  }

  getPackage(protocolId: string): ProtocolPackageDescriptor {
    const entry = this.#packages.get(protocolId);
    if (entry === undefined) throw new TypeError("Unknown protocol package identity.");
    return entry;
  }

  getDeployment(identity: ProtocolDeploymentIdentity): ProtocolDeploymentIdentity {
    const deployment = this.#deployments.get(protocolDeploymentIdentityKey(identity));
    if (deployment === undefined) throw new TypeError("Unknown protocol deployment identity.");
    return deployment;
  }

  ownsCapability(protocolId: string, capabilityId: string): boolean {
    return this.#capabilityOwners.get(capabilityId) === protocolId;
  }
}
