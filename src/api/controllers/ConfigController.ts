/**
 * @file ConfigController.ts
 * @description Phase 13: System Configuration Controller
 *
 * NOTE: Strictly scrubs sensitive fields (private keys, mnemonics, tokens)
 * before returning configuration to the client.
 */

import { RouteHandler } from "../types";
import { config as globalConfig } from "../../config";
import { scrubSensitiveData } from "../framework/middleware";

export class ConfigController {
  private mutableConfig = {
    tradingMode: globalConfig.tradingMode,
    defaultTradeAmount: globalConfig.defaultTradeAmount,
    minTradeAmount: globalConfig.minTradeAmount,
    maxTradeAmount: globalConfig.maxTradeAmount,
    minProfitUsdt: globalConfig.minProfitUsdt,
    minProfitPercent: globalConfig.minProfitPercent,
    slippagePct: globalConfig.slippagePct,
    maxPriceImpactPct: globalConfig.maxPriceImpactPct,
    maxGasPriceGwei: globalConfig.maxGasPriceGwei,
    maxDailyLossUsdt: globalConfig.maxDailyLossUsdt,
    autoTradeCooldownSec: globalConfig.autoTradeCooldownSec,
    activeChainId: globalConfig.chainId,
    contracts: {
      arbitrageContractAddress: globalConfig.arbitrageContractAddress,
      treasuryContractAddress: globalConfig.treasuryContractAddress,
    },
  };

  public getConfig: RouteHandler = async (req, res) => {
    // Ensure all secrets are scrubbed
    const cleanConfig = scrubSensitiveData(this.mutableConfig);

    res.status(200).json({
      success: true,
      data: cleanConfig,
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };

  public updateConfig: RouteHandler = async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Request body must be an object" },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    // Disallow updating contract addresses or private keys
    const forbiddenKeys = ["privateKey", "contracts", "walletAddress"];
    for (const key of forbiddenKeys) {
      if (key in updates) {
        res.status(400).json({
          success: false,
          error: { code: "FORBIDDEN_FIELD", message: `Field '${key}' cannot be modified via API` },
          requestId: req.requestId,
          timestamp: Date.now(),
        });
        return;
      }
    }

    if (updates.minProfitUsdt !== undefined && updates.minProfitUsdt < 0) {
      res.status(400).json({
        success: false,
        error: { code: "INVALID_VALUE", message: "minProfitUsdt must be non-negative" },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    Object.assign(this.mutableConfig, updates);

    res.status(200).json({
      success: true,
      data: {
        message: "Configuration updated successfully",
        updatedConfig: scrubSensitiveData(this.mutableConfig),
      },
      requestId: req.requestId,
      timestamp: Date.now(),
    });
  };
}
