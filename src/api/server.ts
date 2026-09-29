/**
 * @file server.ts
 * @description Phase 21: Production-Ready Backend API Server Entrypoint
 *
 * Implements:
 * - Production host and port resolution (defaults to 0.0.0.0:5000)
 * - Structured production logging
 * - Graceful shutdown handling on SIGTERM and SIGINT
 * - Clean teardown of server connections and background polling
 */

import { createApiApp, ApiAppContainer } from "./routes";
import { Logger } from "../utils/logger";

const serverLogger = new Logger("ApiServer");

let activeContainer: ApiAppContainer | null = null;

export async function startApiServer(
  port?: number,
  host?: string
): Promise<ApiAppContainer> {
  const listenPort = port ?? parseInt(process.env.PORT || "5000", 10);
  const listenHost = host ?? process.env.HOST ?? "0.0.0.0";

  const container = createApiApp();
  activeContainer = container;

  await container.server.listen(listenPort, listenHost);

  serverLogger.info("DEX Arbitrage Backend API Server is online", {
    host: listenHost,
    port: listenPort,
    nodeEnv: process.env.NODE_ENV || "development",
    tradingMode: process.env.TRADING_MODE || "MOCK",
    liveTradingArmed: process.env.LIVE_TRADING_ARMED === "true",
  });

  return container;
}

export async function stopApiServer(): Promise<void> {
  if (activeContainer) {
    serverLogger.info("Initiating graceful shutdown of API server...");
    try {
      await activeContainer.server.close();
      serverLogger.info("API server closed successfully.");
    } catch (err: any) {
      serverLogger.error("Error during server shutdown:", err);
    } finally {
      activeContainer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS SIGNAL HANDLERS (GRACEFUL SHUTDOWN)
// ─────────────────────────────────────────────────────────────────────────────
if (typeof process !== "undefined") {
  const handleShutdown = async (signal: string) => {
    serverLogger.info(`Received ${signal}. Shutting down gracefully...`);
    await stopApiServer();
    process.exit(0);
  };

  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  process.once("SIGINT", () => handleShutdown("SIGINT"));
}

if (require.main === module) {
  startApiServer().catch((err) => {
    serverLogger.error("Failed to start API server:", err);
    process.exit(1);
  });
}
