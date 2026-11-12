import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwCommands } from "../src/commands.js";
export default function btw(pi: ExtensionAPI): void {
  new BtwCommands(pi);
}
