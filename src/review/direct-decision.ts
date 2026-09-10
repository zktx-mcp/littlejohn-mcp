import { z } from "zod";

// Provenance for both temporary Review consumers; it does not grant authority.
export const requestInitiatedBySchema = z.enum(["cli", "mcp_app"]);
