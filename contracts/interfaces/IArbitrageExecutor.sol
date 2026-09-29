// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IArbitrageExecutor
 * @notice Standard interface for the atomic zero-loss DEX Arbitrage Executor
 */
interface IArbitrageExecutor {
    struct ArbitrageParams {
        address inputToken;
        address intermediateToken;
        uint256 amountIn;
        uint256 minNetProfit;
        address buyRouter;
        address sellRouter;
        uint256 deadline;
    }

    event ArbitrageExecuted(
        address indexed caller,
        address indexed inputToken,
        address indexed intermediateToken,
        uint256 amountIn,
        uint256 grossReturn,
        uint256 netProfit,
        address buyRouter,
        address sellRouter
    );

    event RouterWhitelisted(address indexed router, bool status);
    event TokenWhitelisted(address indexed token, bool status);
    event TreasuryUpdated(address indexed newTreasury);

    function executeArbitrage(ArbitrageParams calldata params) external returns (uint256 netProfit);
    function simulateArbitrage(ArbitrageParams calldata params) external view returns (bool profitable, uint256 grossReturn, uint256 netProfit);
    function setRouterWhitelist(address router, bool status) external;
    function setTokenWhitelist(address token, bool status) external;
    function emergencyPause() external;
    function setTreasury(address _treasury) external;
}
