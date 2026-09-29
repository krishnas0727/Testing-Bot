// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ITreasury.sol";
import "./interfaces/IERC20.sol";

/**
 * @title Treasury
 * @notice Enterprise Multi-Bucket Capital, Realized Profit Accounting & Non-Custodial User Withdrawal Contract.
 * @dev Implements:
 *      - Segregated Accounting Buckets: Trading Capital, Gas Reserve, Profit Reserve, Emergency Reserve, Revenue
 *      - Non-Custodial On-Chain User Balance Ledger: deposited, realizedProfit, pending, withdrawable
 *      - Exact Realized Profit Verification & Settlement
 *      - Non-Custodial User Withdrawals with Checks-Effects-Interactions (CEI) & ReentrancyGuard
 *      - Strict Admin Protection: Admin cannot arbitrarily withdraw user funds
 *      - Token Whitelisting, Emergency Circuit Breaker (Pausable), and Safe ERC-20 low-level calls
 *      - Blockchain as the single source of truth for user balances
 */
contract Treasury is ITreasury {
    // -------------------------------------------------------------
    // ROLES & ACCESS CONTROL
    // -------------------------------------------------------------
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TREASURY_MANAGER_ROLE = keccak256("TREASURY_MANAGER_ROLE");
    bytes32 public constant ARBITRAGE_EXECUTOR_ROLE = keccak256("ARBITRAGE_EXECUTOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    mapping(bytes32 => mapping(address => bool)) private _roles;

    // -------------------------------------------------------------
    // CIRCUIT BREAKER / PAUSE & REENTRANCY
    // -------------------------------------------------------------
    bool public paused;
    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // -------------------------------------------------------------
    // MULTI-BUCKET ACCOUNTING LEDGER
    // -------------------------------------------------------------
    mapping(address => BucketBalances) public tokenLedger;
    mapping(address => bool) public isTokenWhitelisted;

    // Configurable Allocation Percentages in Basis Points (10000 bps = 100%)
    uint256 public tradingCapitalBps = 5000;    // 50%
    uint256 public gasReserveBps = 1500;        // 15%
    uint256 public profitReserveBps = 1500;     // 15%
    uint256 public emergencyReserveBps = 1000;  // 10%
    uint256 public revenueBps = 1000;           // 10%
    uint256 public constant BPS_DENOMINATOR = 10000;

    // -------------------------------------------------------------
    // USER-SPECIFIC ON-CHAIN LEDGER & ACCOUNTING
    // -------------------------------------------------------------
    mapping(address => mapping(address => UserBalance)) public userBalances; // user => token => UserBalance
    mapping(address => uint256) public totalUserWithdrawable;                 // token => total withdrawable across all users
    mapping(address => uint256) public totalUserDeposits;                     // token => total deposited across all users

    // -------------------------------------------------------------
    // WITHDRAWAL LIMITS & RISK GATING
    // -------------------------------------------------------------
    struct WithdrawalLimit {
        uint256 maxPerTx;
        uint256 maxDaily;
    }

    mapping(address => WithdrawalLimit) public tokenWithdrawalLimits;
    mapping(address => mapping(uint256 => uint256)) public dailyWithdrawnAmount; // token => dayIndex => amount

    // -------------------------------------------------------------
    // CUSTOM ERRORS
    // -------------------------------------------------------------
    error Unauthorized(bytes32 requiredRole);
    error ContractPaused();
    error ReentrancyGuardReentrantCall();
    error InvalidAllocationSum(uint256 totalBps);
    error InsufficientBucketBalance(Bucket bucket, uint256 available, uint256 requested);
    error InsufficientUserBalance(uint256 available, uint256 requested);
    error InsufficientPendingBalance(uint256 available, uint256 requested);
    error InsufficientTreasuryLiquidity(uint256 contractBalance, uint256 requested);
    error InvalidProfitCalculation();
    error AdminCannotWithdrawUserFunds(uint256 requested, uint256 availableAdminReserve);
    error ZeroAddress();
    error ZeroAmount();
    error TokenNotWhitelisted(address token);
    error WithdrawalLimitExceeded(uint256 requested, uint256 limit);
    error DailyWithdrawalLimitExceeded(uint256 requested, uint256 limit);
    error TransferFailed();

    // -------------------------------------------------------------
    // MODIFIERS
    // -------------------------------------------------------------
    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender] && !_roles[ADMIN_ROLE][msg.sender]) {
            revert Unauthorized(role);
        }
        _;
    }

    modifier onlyAdmin() {
        if (!_roles[ADMIN_ROLE][msg.sender]) {
            revert Unauthorized(ADMIN_ROLE);
        }
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // -------------------------------------------------------------
    // CONSTRUCTOR
    // -------------------------------------------------------------
    /**
     * @notice Initializes Treasury contract with admin and arbitrage executor roles.
     * @param adminAddress Administrative root (e.g. multi-sig vault)
     * @param initialExecutor Address of ArbitrageExecutor.sol
     */
    constructor(address adminAddress, address initialExecutor) {
        if (adminAddress == address(0)) revert ZeroAddress();

        _roles[ADMIN_ROLE][adminAddress] = true;
        _roles[TREASURY_MANAGER_ROLE][adminAddress] = true;
        _roles[PAUSER_ROLE][adminAddress] = true;

        if (initialExecutor != address(0)) {
            _roles[ARBITRAGE_EXECUTOR_ROLE][initialExecutor] = true;
            emit RoleGranted(ARBITRAGE_EXECUTOR_ROLE, initialExecutor, adminAddress);
        }

        _status = _NOT_ENTERED;
        paused = false;

        emit RoleGranted(ADMIN_ROLE, adminAddress, msg.sender);
    }

    receive() external payable {}

    // -------------------------------------------------------------
    // 1. PROFIT RECEPTION & BUCKET ALLOCATION
    // -------------------------------------------------------------
    /**
     * @notice Receives realized trading profit from the authorized ArbitrageExecutor
     *         and allocates it across the 5 segregated accounting buckets.
     * @param token Address of the profit asset (e.g. USDT, USDC)
     * @param amount Net profit tokens sent
     */
    function depositProfit(address token, uint256 amount)
        external
        override
        onlyRole(ARBITRAGE_EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        // Pull tokens from sender
        _safeTransferFrom(token, msg.sender, address(this), amount);

        // Calculate distribution shares
        uint256 toTradingCapital = (amount * tradingCapitalBps) / BPS_DENOMINATOR;
        uint256 toGasReserve = (amount * gasReserveBps) / BPS_DENOMINATOR;
        uint256 toProfitReserve = (amount * profitReserveBps) / BPS_DENOMINATOR;
        uint256 toEmergencyReserve = (amount * emergencyReserveBps) / BPS_DENOMINATOR;
        // Remaining dust allocated to revenue
        uint256 toRevenue = amount - toTradingCapital - toGasReserve - toProfitReserve - toEmergencyReserve;

        BucketBalances storage b = tokenLedger[token];
        b.tradingCapital += toTradingCapital;
        b.gasReserve += toGasReserve;
        b.profitReserve += toProfitReserve;
        b.emergencyReserve += toEmergencyReserve;
        b.revenue += toRevenue;
        b.totalRealizedProfit += amount;

        emit ProfitReceived(
            msg.sender,
            token,
            amount,
            toTradingCapital,
            toGasReserve,
            toProfitReserve,
            toEmergencyReserve,
            toRevenue,
            block.timestamp
        );
    }

    // -------------------------------------------------------------
    // 2. USER DEPOSIT & BUCKET DEPOSIT
    // -------------------------------------------------------------
    /**
     * @notice Allows any user to deposit whitelisted ERC-20 tokens to their on-chain account.
     *         Funds immediately become available for trading and withdrawable.
     * @param token Address of the ERC-20 token
     * @param amount Amount of tokens to deposit
     */
    function deposit(address token, uint256 amount)
        external
        override
        whenNotPaused
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        // Pull tokens from depositor to Treasury contract
        _safeTransferFrom(token, msg.sender, address(this), amount);

        UserBalance storage ub = userBalances[msg.sender][token];
        ub.deposited += amount;
        ub.withdrawable += amount;
        totalUserWithdrawable[token] += amount;
        totalUserDeposits[token] += amount;

        emit Deposit(msg.sender, token, amount, Bucket.TRADING_CAPITAL, block.timestamp);
        emit UserDeposit(msg.sender, token, amount, block.timestamp);
    }

    /**
     * @notice Bucket deposit allowing managers or admin to fund specific operational buckets.
     */
    function deposit(address token, uint256 amount, Bucket bucket)
        external
        override
        whenNotPaused
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        _safeTransferFrom(token, msg.sender, address(this), amount);

        BucketBalances storage b = tokenLedger[token];
        if (bucket == Bucket.TRADING_CAPITAL) {
            b.tradingCapital += amount;
        } else if (bucket == Bucket.GAS_RESERVE) {
            b.gasReserve += amount;
        } else if (bucket == Bucket.PROFIT_RESERVE) {
            b.profitReserve += amount;
        } else if (bucket == Bucket.EMERGENCY_RESERVE) {
            b.emergencyReserve += amount;
        } else if (bucket == Bucket.REVENUE) {
            b.revenue += amount;
        }

        emit Deposit(msg.sender, token, amount, bucket, block.timestamp);
    }

    // -------------------------------------------------------------
    // 3. PROFIT RECORDING & SETTLEMENT
    // -------------------------------------------------------------
    /**
     * @notice Records profit to user pending balance during or before final trade settlement.
     *         Enforces Net Realized Profit = Gross Profit - DEX Fees - Gas Cost.
     */
    function recordProfit(
        address user,
        address token,
        uint256 grossProfit,
        uint256 fees,
        uint256 gasCost,
        uint256 netProfit
    )
        external
        override
        onlyRole(ARBITRAGE_EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (user == address(0) || token == address(0)) revert ZeroAddress();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);
        if (netProfit == 0) revert ZeroAmount();

        uint256 totalCosts = fees + gasCost;
        if (grossProfit <= totalCosts || netProfit != (grossProfit - totalCosts)) {
            revert InvalidProfitCalculation();
        }

        userBalances[user][token].pending += netProfit;

        emit ProfitRecorded(user, token, grossProfit, fees, gasCost, netProfit, block.timestamp);
    }

    /**
     * @notice Settles pending profit into the user's withdrawable balance upon on-chain trade confirmation.
     *         Pulls tokens from executor into treasury and moves from pending to withdrawable.
     */
    function settleProfit(address user, address token, uint256 amount)
        external
        override
        onlyRole(ARBITRAGE_EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (user == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        UserBalance storage ub = userBalances[user][token];
        if (ub.pending < amount) {
            revert InsufficientPendingBalance(ub.pending, amount);
        }

        // Pull tokens from the executor to fund the user's withdrawable balance
        _safeTransferFrom(token, msg.sender, address(this), amount);

        ub.pending -= amount;
        ub.realizedProfit += amount;
        ub.withdrawable += amount;
        totalUserWithdrawable[token] += amount;

        emit ProfitSettled(user, token, amount, block.timestamp);
    }

    /**
     * @notice Direct atomic settlement of realized profit in one transaction.
     *         Calculates net profit, pulls tokens, updates user withdrawable balance, and emits events.
     */
    function settleRealizedProfit(
        address user,
        address token,
        uint256 grossProfit,
        uint256 fees,
        uint256 gasCost,
        uint256 netProfit
    )
        external
        override
        onlyRole(ARBITRAGE_EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (user == address(0) || token == address(0)) revert ZeroAddress();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);
        if (netProfit == 0) revert ZeroAmount();

        uint256 totalCosts = fees + gasCost;
        if (grossProfit <= totalCosts || netProfit != (grossProfit - totalCosts)) {
            revert InvalidProfitCalculation();
        }

        // Pull realized profit tokens from caller (ArbitrageExecutor)
        _safeTransferFrom(token, msg.sender, address(this), netProfit);

        UserBalance storage ub = userBalances[user][token];
        ub.realizedProfit += netProfit;
        ub.withdrawable += netProfit;
        totalUserWithdrawable[token] += netProfit;

        emit ProfitRecorded(user, token, grossProfit, fees, gasCost, netProfit, block.timestamp);
        emit ProfitSettled(user, token, netProfit, block.timestamp);
    }

    // -------------------------------------------------------------
    // 4. NON-CUSTODIAL USER WITHDRAWAL
    // -------------------------------------------------------------
    /**
     * @notice Allows user to withdraw their available on-chain balance (deposits + realized profits).
     *         - Non-custodial: user signs their own transaction via MetaMask
     *         - Checks-Effects-Interactions (CEI) to prevent reentrancy
     *         - Invariant check: totalUserWithdrawable[token] <= contract token balance
     */
    function withdraw(address token, uint256 amount)
        external
        override
        whenNotPaused
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        UserBalance storage ub = userBalances[msg.sender][token];
        if (ub.withdrawable < amount) {
            revert InsufficientUserBalance(ub.withdrawable, amount);
        }

        // Invariant Liquidity Verification
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        if (!success || data.length < 32) {
            revert TransferFailed();
        }
        uint256 actualContractBalance = abi.decode(data, (uint256));
        if (actualContractBalance < amount) {
            revert InsufficientTreasuryLiquidity(actualContractBalance, amount);
        }

        // 1. CHECKS-EFFECTS-INTERACTIONS: Update state BEFORE token transfer
        ub.withdrawable -= amount;
        totalUserWithdrawable[token] -= amount;

        // 2. Safe ERC-20 transfer to msg.sender
        _safeTransfer(token, msg.sender, amount);

        emit Withdrawal(msg.sender, token, amount, Bucket.PROFIT_RESERVE, block.timestamp);
        emit UserWithdrawal(msg.sender, token, amount, block.timestamp);
    }

    // -------------------------------------------------------------
    // 5. AUTHORIZED BUCKET WITHDRAWALS (TREASURY MANAGER)
    // -------------------------------------------------------------
    /**
     * @notice Authorized withdrawal from an administrative accounting bucket.
     *         Enforces per-transaction and rolling daily withdrawal limits.
     */
    function withdraw(
        address token,
        uint256 amount,
        address recipient,
        Bucket bucket
    )
        external
        override
        onlyRole(TREASURY_MANAGER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenWhitelisted[token]) revert TokenNotWhitelisted(token);

        // Withdrawal Limits Enforcement
        WithdrawalLimit memory limit = tokenWithdrawalLimits[token];
        if (limit.maxPerTx > 0 && amount > limit.maxPerTx) {
            revert WithdrawalLimitExceeded(amount, limit.maxPerTx);
        }

        uint256 currentDay = block.timestamp / 1 days;
        uint256 todayWithdrawn = dailyWithdrawnAmount[token][currentDay] + amount;
        if (limit.maxDaily > 0 && todayWithdrawn > limit.maxDaily) {
            revert DailyWithdrawalLimitExceeded(todayWithdrawn, limit.maxDaily);
        }
        dailyWithdrawnAmount[token][currentDay] = todayWithdrawn;

        // Bucket Balance Validation & Deduction
        BucketBalances storage b = tokenLedger[token];
        if (bucket == Bucket.TRADING_CAPITAL) {
            if (b.tradingCapital < amount) revert InsufficientBucketBalance(bucket, b.tradingCapital, amount);
            b.tradingCapital -= amount;
        } else if (bucket == Bucket.GAS_RESERVE) {
            if (b.gasReserve < amount) revert InsufficientBucketBalance(bucket, b.gasReserve, amount);
            b.gasReserve -= amount;
        } else if (bucket == Bucket.PROFIT_RESERVE) {
            if (b.profitReserve < amount) revert InsufficientBucketBalance(bucket, b.profitReserve, amount);
            b.profitReserve -= amount;
        } else if (bucket == Bucket.EMERGENCY_RESERVE) {
            if (b.emergencyReserve < amount) revert InsufficientBucketBalance(bucket, b.emergencyReserve, amount);
            b.emergencyReserve -= amount;
        } else if (bucket == Bucket.REVENUE) {
            if (b.revenue < amount) revert InsufficientBucketBalance(bucket, b.revenue, amount);
            b.revenue -= amount;
        }

        b.totalWithdrawn += amount;

        // Secure Transfer
        _safeTransfer(token, recipient, amount);

        emit Withdrawal(recipient, token, amount, bucket, block.timestamp);
    }

    // -------------------------------------------------------------
    // 6. EMERGENCY WITHDRAWAL (WITH STRICT USER PROTECTION)
    // -------------------------------------------------------------
    /**
     * @notice Emergency administrative recovery of surplus contract reserves.
     *         PROTECTION INVARIANT: Admin CANNOT withdraw user funds.
     *         Amount is capped to: IERC20(token).balanceOf(this) - totalUserWithdrawable[token].
     */
    function emergencyWithdraw(
        address token,
        uint256 amount,
        address recipient
    )
        external
        override
        onlyAdmin
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        if (!success || data.length < 32) {
            revert TransferFailed();
        }
        uint256 totalContractBalance = abi.decode(data, (uint256));
        uint256 lockedUserFunds = totalUserWithdrawable[token];

        if (totalContractBalance <= lockedUserFunds) {
            revert AdminCannotWithdrawUserFunds(amount, 0);
        }

        uint256 availableAdminReserve = totalContractBalance - lockedUserFunds;
        if (amount > availableAdminReserve) {
            revert AdminCannotWithdrawUserFunds(amount, availableAdminReserve);
        }

        _safeTransfer(token, recipient, amount);

        emit EmergencyWithdrawal(recipient, token, amount, block.timestamp);
    }

    /**
     * @notice Emergency native gas (ETH) withdrawal for ADMIN.
     */
    function emergencyWithdrawETH(address payable recipient, uint256 amount)
        external
        onlyAdmin
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 toSend = amount > address(this).balance ? address(this).balance : amount;

        (bool success, ) = recipient.call{value: toSend}("");
        if (!success) revert TransferFailed();

        emit EmergencyWithdrawal(recipient, address(0), toSend, block.timestamp);
    }

    // -------------------------------------------------------------
    // 7. CIRCUIT BREAKER / PAUSE CONTROLS
    // -------------------------------------------------------------
    function pause() external override onlyRole(PAUSER_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external override onlyRole(PAUSER_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // -------------------------------------------------------------
    // 8. ROLE MANAGEMENT
    // -------------------------------------------------------------
    function grantRole(bytes32 role, address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    // -------------------------------------------------------------
    // 9. CONFIGURATION & ADMINISTRATION
    // -------------------------------------------------------------
    function setAllocationRatios(
        uint256 _tradingCapitalBps,
        uint256 _gasReserveBps,
        uint256 _profitReserveBps,
        uint256 _emergencyReserveBps,
        uint256 _revenueBps
    ) external onlyAdmin {
        uint256 sum = _tradingCapitalBps + _gasReserveBps + _profitReserveBps + _emergencyReserveBps + _revenueBps;
        if (sum != BPS_DENOMINATOR) {
            revert InvalidAllocationSum(sum);
        }

        tradingCapitalBps = _tradingCapitalBps;
        gasReserveBps = _gasReserveBps;
        profitReserveBps = _profitReserveBps;
        emergencyReserveBps = _emergencyReserveBps;
        revenueBps = _revenueBps;

        emit AllocationUpdated(
            _tradingCapitalBps,
            _gasReserveBps,
            _profitReserveBps,
            _emergencyReserveBps,
            _revenueBps,
            block.timestamp
        );
    }

    function setThreeBucketAllocation(
        uint256 _tradingCapitalBps,
        uint256 _reserveBps,
        uint256 _revenueBps
    ) external override onlyAdmin {
        uint256 sum = _tradingCapitalBps + _reserveBps + _revenueBps;
        if (sum != BPS_DENOMINATOR) {
            revert InvalidAllocationSum(sum);
        }

        tradingCapitalBps = _tradingCapitalBps;
        profitReserveBps = _reserveBps;
        revenueBps = _revenueBps;
        gasReserveBps = 0;
        emergencyReserveBps = 0;

        emit ThreeBucketAllocationUpdated(
            _tradingCapitalBps,
            _reserveBps,
            _revenueBps,
            block.timestamp
        );
        emit AllocationUpdated(
            _tradingCapitalBps,
            0,
            _reserveBps,
            0,
            _revenueBps,
            block.timestamp
        );
    }

    function setTokenWhitelist(address token, bool status)
        external
        override
        onlyRole(TREASURY_MANAGER_ROLE)
    {
        if (token == address(0)) revert ZeroAddress();
        isTokenWhitelisted[token] = status;
        emit TokenWhitelisted(token, status);
    }

    function setWithdrawalLimits(address token, uint256 maxPerTx, uint256 maxDaily)
        external
        onlyAdmin
    {
        if (token == address(0)) revert ZeroAddress();
        tokenWithdrawalLimits[token] = WithdrawalLimit({
            maxPerTx: maxPerTx,
            maxDaily: maxDaily
        });
        emit TreasuryConfigurationUpdated("maxDailyWithdrawal", maxDaily, block.timestamp);
    }

    // -------------------------------------------------------------
    // 10. VIEW FUNCTIONS
    // -------------------------------------------------------------
    function getBucketBalances(address token)
        external
        view
        override
        returns (BucketBalances memory)
    {
        return tokenLedger[token];
    }

    function getUserBalance(address user, address token)
        external
        view
        override
        returns (
            uint256 deposited,
            uint256 realizedProfit,
            uint256 pending,
            uint256 withdrawable
        )
    {
        UserBalance memory b = userBalances[user][token];
        return (b.deposited, b.realizedProfit, b.pending, b.withdrawable);
    }

    function getTotalUserWithdrawable(address token) external view override returns (uint256) {
        return totalUserWithdrawable[token];
    }

    function getRemainingDailyLimit(address token) external view returns (uint256) {
        uint256 currentDay = block.timestamp / 1 days;
        uint256 alreadyWithdrawn = dailyWithdrawnAmount[token][currentDay];
        uint256 maxDaily = tokenWithdrawalLimits[token].maxDaily;

        if (maxDaily == 0) return type(uint256).max;
        if (alreadyWithdrawn >= maxDaily) return 0;
        return maxDaily - alreadyWithdrawn;
    }

    // -------------------------------------------------------------
    // 11. INTERNAL SAFE ERC-20 HELPERS
    // -------------------------------------------------------------
    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, value) // transfer(address,uint256)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, value) // transferFrom(address,address,uint256)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
