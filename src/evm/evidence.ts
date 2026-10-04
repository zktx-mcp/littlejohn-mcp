import {createEvidenceSchemaSet} from "../core/client.js";
import {createEvmPrimitiveSchemaSet} from "./primitives.js";
export const createEvmEvidenceSchemaSet = () => createEvidenceSchemaSet(createEvmPrimitiveSchemaSet().chainAnchor);
const schemas = createEvmEvidenceSchemaSet();
export const evidenceSourceRecordSchema = schemas.evidenceSourceRecord;
export const evidenceSourceSchema = schemas.evidenceSource;
