// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DexArbitrage
 * @notice 100% Decentralized Atomic Multi-Hop DEX-to-DEX Arbitrage Contract.
 * @dev Executes multi-DEX swaps within a single atomic Ethereum transaction.
 *      If net return after DEX protocol fees and slippage is below amountIn + minProfit,
 *      the entire transaction reverts atomically with ZERO fund loss.
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

contract DexArbitrage {
    address public immutable owner;
    bool public paused;
    uint256 private _status;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    struct ArbitrageParams {
        address routerBuy;
        address routerSell;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOutLeg1;
        uint256 minProfit;
        uint256 deadline;
    }

    event ArbitrageExecuted(
        address indexed caller,
        address indexed routerBuy,
        address indexed routerSell,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 finalBalance,
        uint256 netProfit,
        uint256 timestamp
    );

    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed recipient);
    event PauseToggled(bool isPaused);

    error Unauthorized();
    error ContractPaused();
    error ReentrancyGuardReentrantCall();
    error ExpiredDeadline();
    error IdenticalRouters();
    error IdenticalTokens();
    error InsufficientAmountIn();
    error InsufficientAmountOutLeg1();
    error UnprofitableArbitrage(uint256 finalAmount, uint256 requiredAmount);
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
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

    constructor() {
        owner = msg.sender;
        _status = _NOT_ENTERED;
        paused = false;
    }

    receive() external payable {}

    /**
     * @notice Execute atomic DEX-to-DEX arbitrage between two routers.
     * @param params Struct with routers, tokens, amount, minAmountOutLeg1, minProfit and deadline.
     * @return netProfit Realized net profit in tokenIn.
     */
    function executeArbitrage(
        ArbitrageParams calldata params
    ) external onlyOwner whenNotPaused nonReentrant returns (uint256 netProfit) {
        if (block.timestamp > params.deadline) revert ExpiredDeadline();
        if (params.routerBuy == address(0) || params.routerSell == address(0)) revert ZeroAddress();
        if (params.routerBuy == params.routerSell) revert IdenticalRouters();
        if (params.tokenIn == address(0) || params.tokenOut == address(0)) revert ZeroAddress();
        if (params.tokenIn == params.tokenOut) revert IdenticalTokens();
        if (params.amountIn == 0) revert InsufficientAmountIn();
        if (params.minAmountOutLeg1 == 0) revert InsufficientAmountOutLeg1();

        uint256 balanceBefore = _fundContract(params.tokenIn, params.amountIn);

        // Leg 1: tokenIn -> tokenOut on routerBuy with strict fresh-quote-based minimum output
        uint256 received = _swap(params.routerBuy, params.tokenIn, params.tokenOut, params.amountIn, params.minAmountOutLeg1, params.deadline);

        // Leg 2: tokenOut -> tokenIn on routerSell
        uint256 balanceCurrent = IERC20(params.tokenIn).balanceOf(address(this));
        uint256 minRequired = balanceBefore + params.minProfit;
        uint256 minLeg2Out = minRequired > balanceCurrent ? minRequired - balanceCurrent : 0;
        _swap(params.routerSell, params.tokenOut, params.tokenIn, received, minLeg2Out, params.deadline);

        uint256 balanceAfter = IERC20(params.tokenIn).balanceOf(address(this));

        // Atomic safety check: revert everything if not profitable
        if (balanceAfter < minRequired) {
            revert UnprofitableArbitrage(balanceAfter, minRequired);
        }

        netProfit = balanceAfter - balanceBefore;

        emit ArbitrageExecuted(
            msg.sender,
            params.routerBuy,
            params.routerSell,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            balanceAfter,
            netProfit,
            block.timestamp
        );
    }

    /// @dev Ensure the contract holds `amountIn` of `token`, pulling the shortfall from the owner.
    function _fundContract(address token, uint256 amountIn) internal returns (uint256 balanceBefore) {
        balanceBefore = IERC20(token).balanceOf(address(this));
        if (balanceBefore < amountIn) {
            bool success = IERC20(token).transferFrom(msg.sender, address(this), amountIn - balanceBefore);
            if (!success) revert TransferFailed();
            balanceBefore = IERC20(token).balanceOf(address(this));
        }
    }

    /// @dev Single V2 swap; returns the amount of `tokenTo` received.
    function _swap(
        address router,
        address tokenFrom,
        address tokenTo,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = tokenFrom;
        path[1] = tokenTo;
        _safeApprove(IERC20(tokenFrom), router, amountIn);
        uint256[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );
        amountOut = amounts[1];
    }

    /**
     * @notice Simulate an arbitrage trade off-chain without spending gas.
     * @dev Uses router getAmountsOut views.
     */
    function simulateArbitrage(
        ArbitrageParams calldata params
    ) external view returns (
        bool profitable,
        uint256 expectedProfit,
        uint256 leg1Output,
        uint256 leg2Output
    ) {
        if (params.routerBuy == address(0) || params.routerSell == address(0)) revert ZeroAddress();
        if (params.routerBuy == params.routerSell) revert IdenticalRouters();
        if (params.tokenIn == address(0) || params.tokenOut == address(0)) revert ZeroAddress();
        if (params.tokenIn == params.tokenOut) revert IdenticalTokens();
        if (params.amountIn == 0) revert InsufficientAmountIn();

        address[] memory pathBuy = new address[](2);
        pathBuy[0] = params.tokenIn;
        pathBuy[1] = params.tokenOut;

        uint256[] memory outBuy = IUniswapV2Router(params.routerBuy).getAmountsOut(params.amountIn, pathBuy);
        leg1Output = outBuy[1];

        if (params.minAmountOutLeg1 > 0 && leg1Output < params.minAmountOutLeg1) {
            return (false, 0, leg1Output, 0);
        }

        address[] memory pathSell = new address[](2);
        pathSell[0] = params.tokenOut;
        pathSell[1] = params.tokenIn;

        uint256[] memory outSell = IUniswapV2Router(params.routerSell).getAmountsOut(leg1Output, pathSell);
        leg2Output = outSell[1];

        if (leg2Output > params.amountIn + params.minProfit) {
            profitable = true;
            expectedProfit = leg2Output - params.amountIn;
        } else {
            profitable = false;
            expectedProfit = 0;
        }

        return (profitable, expectedProfit, leg1Output, leg2Output);
    }

    function togglePause() external onlyOwner {
        paused = !paused;
        emit PauseToggled(paused);
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20 tokenContract = IERC20(token);
        uint256 balance = tokenContract.balanceOf(address(this));
        uint256 withdrawAmount = amount > balance ? balance : amount;
        bool success = tokenContract.transfer(owner, withdrawAmount);
        if (!success) revert TransferFailed();
        emit EmergencyWithdraw(token, withdrawAmount, owner);
    }

    function withdrawETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        (bool success, ) = owner.call{value: balance}("");
        if (!success) revert TransferFailed();
        emit EmergencyWithdraw(address(0), balance, owner);
    }

    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            if (currentAllowance > 0) {
                token.approve(spender, 0);
            }
            token.approve(spender, type(uint256).max);
        }
    }
}
