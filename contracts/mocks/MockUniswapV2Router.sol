// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MockUniswapV2Router
 * @notice Mock implementation of Uniswap V2 Router for deterministic testing of ArbitrageExecutor.sol.
 */
contract MockUniswapV2Router {
    bool public shouldFailSwap;
    uint256 public multiplierBps = 10000; // 10000 = 1.0x (1:1 conversion by default)
    uint256 public fixedOutputAmount = 0; // If set > 0, returns this exact amount

    event SwapExecuted(
        address indexed sender,
        uint256 amountIn,
        uint256 amountOut,
        address[] path,
        address indexed to
    );

    function setFailSwap(bool fail) external {
        shouldFailSwap = fail;
    }

    function setMultiplierBps(uint256 _multiplierBps) external {
        multiplierBps = _multiplierBps;
    }

    function setFixedOutputAmount(uint256 _fixedAmount) external {
        fixedOutputAmount = _fixedAmount;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(!shouldFailSwap, "MockRouter: Swap forced failure");
        require(block.timestamp <= deadline, "MockRouter: EXPIRED");
        require(path.length >= 2, "MockRouter: INVALID_PATH");

        // Pull tokenIn from msg.sender
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        bool successIn = IERC20Minimal(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        require(successIn, "MockRouter: TransferFrom failed");

        uint256 amountOut;
        if (fixedOutputAmount > 0) {
            amountOut = fixedOutputAmount;
        } else {
            amountOut = (amountIn * multiplierBps) / 10000;
        }

        require(amountOut >= amountOutMin, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");

        // Send tokenOut to recipient
        bool successOut = IERC20Minimal(tokenOut).transfer(to, amountOut);
        require(successOut, "MockRouter: Transfer to recipient failed");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;

        emit SwapExecuted(msg.sender, amountIn, amountOut, path, to);
        return amounts;
    }

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts) {
        require(!shouldFailSwap, "MockRouter: Simulation forced failure");
        require(path.length >= 2, "MockRouter: INVALID_PATH");

        uint256 amountOut;
        if (fixedOutputAmount > 0) {
            amountOut = fixedOutputAmount;
        } else {
            amountOut = (amountIn * multiplierBps) / 10000;
        }

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
        return amounts;
    }
}
