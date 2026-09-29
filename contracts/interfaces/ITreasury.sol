// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITreasury
 * @notice Standard interface for Enterprise Multi-Bucket Treasury & Non-Custodial User Profit Accounting
 */
interface ITreasury {
    enum Bucket {
        TRADING_CAPITAL,
        GAS_RESERVE,
        PROFIT_RESERVE,
        EMERGENCY_RESERVE,
        REVENUE
    }

    struct BucketBalances {
        uint256 tradingCapital;
        uint256 gasReserve;
        uint256 profitReserve;
        uint256 emergencyReserve;
        uint256 revenue;
        uint256 totalRealizedProfit;
        uint256 totalWithdrawn;
    }

    struct UserBalance {
        uint256 deposited;
        uint256 realizedProfit;
        uint256 pending;
        uint256 withdrawable;
    }

    event ProfitReceived(
        address indexed executor,
        address indexed token,
        uint256 grossAmount,
        uint256 tradingCapitalAllocated,
        uint256 gasReserveAllocated,
        uint256 profitReserveAllocated,
        uint256 emergencyReserveAllocated,
        uint256 revenueAllocated,
        uint256 timestamp
    );

    event Deposit(
        address indexed depositor,
        address indexed token,
        uint256 amount,
        Bucket bucket,
        uint256 timestamp
    );

    event UserDeposit(
        address indexed user,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    event ProfitRecorded(
        address indexed user,
        address indexed token,
        uint256 grossProfit,
        uint256 fees,
        uint256 gasCost,
        uint256 netProfit,
        uint256 timestamp
    );

    event ProfitSettled(
        address indexed user,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    event UserWithdrawal(
        address indexed user,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    event AllocationUpdated(
        uint256 tradingCapitalBps,
        uint256 gasReserveBps,
        uint256 profitReserveBps,
        uint256 emergencyReserveBps,
        uint256 revenueBps,
        uint256 timestamp
    );

    event ThreeBucketAllocationUpdated(
        uint256 tradingCapitalBps,
        uint256 reserveBps,
        uint256 revenueBps,
        uint256 timestamp
    );

    event Withdrawal(
        address indexed recipient,
        address indexed token,
        uint256 amount,
        Bucket bucket,
        uint256 timestamp
    );

    event EmergencyWithdrawal(
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event Paused(address account);
    event Unpaused(address account);
    event TokenWhitelisted(address indexed token, bool status);
    event TreasuryConfigurationUpdated(string parameter, uint256 value, uint256 timestamp);

    function depositProfit(address token, uint256 amount) external;
    function deposit(address token, uint256 amount, Bucket bucket) external;
    function deposit(address token, uint256 amount) external;
    function recordProfit(address user, address token, uint256 grossProfit, uint256 fees, uint256 gasCost, uint256 netProfit) external;
    function settleProfit(address user, address token, uint256 amount) external;
    function settleRealizedProfit(address user, address token, uint256 grossProfit, uint256 fees, uint256 gasCost, uint256 netProfit) external;
    function withdraw(address token, uint256 amount, address recipient, Bucket bucket) external;
    function withdraw(address token, uint256 amount) external;
    function emergencyWithdraw(address token, uint256 amount, address recipient) external;
    function pause() external;
    function unpause() external;
    function setTokenWhitelist(address token, bool status) external;
    function setThreeBucketAllocation(uint256 tradingCapitalBps, uint256 reserveBps, uint256 revenueBps) external;
    function getBucketBalances(address token) external view returns (BucketBalances memory);
    function getUserBalance(address user, address token) external view returns (uint256 deposited, uint256 realizedProfit, uint256 pending, uint256 withdrawable);
    function getTotalUserWithdrawable(address token) external view returns (uint256);
}
