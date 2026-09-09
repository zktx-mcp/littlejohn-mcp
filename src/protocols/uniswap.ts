import { admitProtocolFamilyDescriptor, protocolFamilyIdSchema } from "./contracts.js";

export const uniswapProtocolFamily = admitProtocolFamilyDescriptor({
  familyId: protocolFamilyIdSchema.parse("uniswap"),
  displayName: "Uniswap",
});
