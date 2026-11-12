import { createHash } from "node:crypto";
// JSON insertion order is intentional: sorting object keys would hide serialization drift.
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
