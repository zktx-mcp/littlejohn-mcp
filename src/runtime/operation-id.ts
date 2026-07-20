import { randomBytes } from "node:crypto";

import {
  operationIdByteLength,
  operationIdFromBytes,
  type OperationId,
} from "../core/index.js";

export const createOperationId = (): OperationId =>
  operationIdFromBytes(randomBytes(operationIdByteLength));
