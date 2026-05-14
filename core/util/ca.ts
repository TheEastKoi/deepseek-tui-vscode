import { globalAgent } from "https";

export async function setupCa() {
  try {
    switch (process.platform) {
      case "darwin":
        try {
          const macCa = await import("mac-ca");
          macCa.addToGlobalAgent();
        } catch (e) {
          // Fallback: try system-ca
          const { systemCertsAsync } = await import("system-ca");
          globalAgent.options.ca = await systemCertsAsync();
        }
        break;
      case "win32":
        try {
          const winCa = require("win-ca");
          if (typeof winCa.inject === "function") {
            winCa.inject("+");
          } else {
            winCa({ inject: true, $ave: true, async: true });
          }
        } catch (e2) {
          // Fallback: try system-ca
          const { systemCertsAsync } = await import("system-ca");
          globalAgent.options.ca = await systemCertsAsync();
        }
        break;
      default:
        const { systemCertsAsync } = await import("system-ca");
        globalAgent.options.ca = await systemCertsAsync();
        break;
    }
  } catch (e) {
    console.warn("Failed to setup CA: ", e);
  }
}
