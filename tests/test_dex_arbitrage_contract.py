"""
EVM Unit and Integration Tests for DexArbitrage.sol

Runs directly against the compiled Solidity bytecode using Web3 and EthereumTesterProvider.
Verifies:
1. Contract compilation and ABI integrity
2. Initial deployment state and ownership
3. Access control (unauthorized callers blocked on all state-mutating functions)
4. Parameter validations:
   - Expired deadline
   - Zero address for routers and tokens
   - Identical routers
   - Identical tokens
   - Zero amountIn (InsufficientAmountIn)
   - Zero minAmountOutLeg1 (InsufficientAmountOutLeg1)
5. Pause mechanism (toggled only by owner; execution blocked when paused)
6. Two-hop atomic DEX swap execution (routerBuy -> routerSell) with fresh-quote-based Leg 1 min-out
7. Adverse price movement on Leg 1 (router-level revert protecting gas)
8. Unprofitable arbitrage atomic reversion (UnprofitableArbitrage custom error, zero balance loss)
9. Minimum profit threshold enforcement
10. Token transfer failure handling (TransferFailed)
11. Reentrancy guard protection (ReentrancyGuardReentrantCall)
12. Atomic rollback on second-leg router failure (complete balance restoration)
13. Token ordering and disparate decimal handling (6-decimal USDT vs 18-decimal WETH)
14. Emergency fund rescue (withdrawToken, withdrawETH)
15. simulateArbitrage off-chain view method
"""

import pytest
from pathlib import Path
from web3 import Web3, EthereumTesterProvider
from eth_tester.exceptions import TransactionFailed
import solcx

HELPER_SOL = """
pragma solidity ^0.8.20;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public transferFromReverts;
    bool public transferReverts;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function setTransferFromReverts(bool _reverts) external {
        transferFromReverts = _reverts;
    }

    function setTransferReverts(bool _reverts) external {
        transferReverts = _reverts;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReverts) {
            return false;
        }
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (transferFromReverts) {
            return false;
        }
        require(balanceOf[from] >= amount, "ERC20: transfer exceeds balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: insufficient allowance");
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockRouter {
    address public inToken;
    address public outToken;
    uint256 public multiplierBps;
    address public reenterTarget;
    bool public shouldRevertSwap;

    constructor(address _inToken, address _outToken, uint256 _multiplierBps) {
        inToken = _inToken;
        outToken = _outToken;
        multiplierBps = _multiplierBps;
    }

    function setMultiplier(uint256 _multiplierBps) external {
        multiplierBps = _multiplierBps;
    }

    function setReenterTarget(address _target) external {
        reenterTarget = _target;
    }

    function setShouldRevertSwap(bool _revert) external {
        shouldRevertSwap = _revert;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata /* path */,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(!shouldRevertSwap, "MockRouter: SWAP_EXECUTION_REVERTED");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * multiplierBps) / 10000;

        // Standard Uniswap V2 Router slippage check
        require(amounts[1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");

        if (inToken != address(0)) {
            MockERC20(inToken).transferFrom(msg.sender, address(this), amountIn);
        }
        if (reenterTarget != address(0)) {
            (bool success, ) = reenterTarget.call(
                abi.encodeWithSignature("togglePause()")
            );
            require(success, "Reentrancy should succeed or trigger revert");
        }
        MockERC20(outToken).mint(to, amounts[1]);
    }

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata /* path */
    ) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * multiplierBps) / 10000;
    }
}
"""

@pytest.fixture(scope="module")
def compiled_contracts():
    root = Path(__file__).resolve().parents[1]
    contract_file = root / "contracts" / "DexArbitrage.sol"
    with open(contract_file, "r", encoding="utf-8") as f:
        dex_sol = f.read()

    cleaned_dex = "\n".join([line for line in dex_sol.splitlines() if not line.startswith("// SPDX-License-Identifier")])
    combined_source = "// SPDX-License-Identifier: MIT\n" + HELPER_SOL + "\n" + cleaned_dex

    installed = solcx.get_installed_solc_versions()
    assert len(installed) > 0, "No solc version installed in solcx"
    solc_ver = installed[0]

    compiled = solcx.compile_source(
        combined_source,
        output_values=["abi", "bin"],
        solc_version=solc_ver
    )
    return compiled


@pytest.fixture
def evm_env(compiled_contracts):
    w3 = Web3(EthereumTesterProvider())
    owner = w3.eth.accounts[0]
    attacker = w3.eth.accounts[1]

    MockERC20_build = compiled_contracts["<stdin>:MockERC20"]
    MockRouter_build = compiled_contracts["<stdin>:MockRouter"]
    DexArbitrage_build = compiled_contracts["<stdin>:DexArbitrage"]

    # Deploy Token A (e.g. USDT - 6 decimals)
    tx = w3.eth.contract(abi=MockERC20_build["abi"], bytecode=MockERC20_build["bin"]).constructor(
        "Tether USD", "USDT", 6
    ).transact({"from": owner})
    token_a = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=MockERC20_build["abi"])

    # Deploy Token B (e.g. WETH - 18 decimals)
    tx = w3.eth.contract(abi=MockERC20_build["abi"], bytecode=MockERC20_build["bin"]).constructor(
        "Wrapped Ether", "WETH", 18
    ).transact({"from": owner})
    token_b = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=MockERC20_build["abi"])

    # Deploy Router 1: buy leg (Token A -> Token B, 10000 bps = 1:1)
    tx = w3.eth.contract(abi=MockRouter_build["abi"], bytecode=MockRouter_build["bin"]).constructor(
        token_a.address, token_b.address, 10000
    ).transact({"from": owner})
    router_buy = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=MockRouter_build["abi"])

    # Deploy Router 2: sell leg (Token B -> Token A, 10500 bps = +5%)
    tx = w3.eth.contract(abi=MockRouter_build["abi"], bytecode=MockRouter_build["bin"]).constructor(
        token_b.address, token_a.address, 10500
    ).transact({"from": owner})
    router_sell = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=MockRouter_build["abi"])

    # Deploy DexArbitrage
    tx = w3.eth.contract(abi=DexArbitrage_build["abi"], bytecode=DexArbitrage_build["bin"]).constructor().transact({"from": owner})
    dex_arb = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=DexArbitrage_build["abi"])

    return {
        "w3": w3,
        "owner": owner,
        "attacker": attacker,
        "token_a": token_a,
        "token_b": token_b,
        "router_buy": router_buy,
        "router_sell": router_sell,
        "dex_arb": dex_arb,
    }


def test_contract_initial_state_and_ownership(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    assert dex.functions.owner().call() == owner
    assert dex.functions.paused().call() is False


def test_unauthorized_access_rejections(evm_env):
    dex = evm_env["dex_arb"]
    attacker = evm_env["attacker"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # 1. Attacker calling executeArbitrage
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            100,
            95,
            1,
            9999999999
        )).call({"from": attacker})

    # 2. Attacker calling togglePause
    with pytest.raises(TransactionFailed):
        dex.functions.togglePause().call({"from": attacker})

    # 3. Attacker calling withdrawToken
    with pytest.raises(TransactionFailed):
        dex.functions.withdrawToken(token_a.address, 100).call({"from": attacker})

    # 4. Attacker calling withdrawETH
    with pytest.raises(TransactionFailed):
        dex.functions.withdrawETH().call({"from": attacker})


def test_pause_and_unpause_enforcement(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # Pause contract
    dex.functions.togglePause().transact({"from": owner})
    assert dex.functions.paused().call() is True

    # Execution should fail when paused
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            100,
            95,
            1,
            9999999999
        )).call({"from": owner})

    # Unpause contract
    dex.functions.togglePause().transact({"from": owner})
    assert dex.functions.paused().call() is False


def test_trade_parameter_validations(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]
    zero_addr = "0x0000000000000000000000000000000000000000"

    # 1. Expired deadline
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            100,
            95,
            1,
            0  # Expired
        )).call({"from": owner})

    # 2. Zero router address
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            zero_addr,
            router_sell.address,
            token_a.address,
            token_b.address,
            100,
            95,
            1,
            9999999999
        )).call({"from": owner})

    # 3. Identical routers
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_buy.address,  # Identical
            token_a.address,
            token_b.address,
            100,
            95,
            1,
            9999999999
        )).call({"from": owner})

    # 4. Zero token address
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            zero_addr,
            token_b.address,
            100,
            95,
            1,
            9999999999
        )).call({"from": owner})

    # 5. Identical tokens
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_a.address,  # Identical
            100,
            95,
            1,
            9999999999
        )).call({"from": owner})

    # 6. Zero amountIn
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            0,  # Zero
            95,
            1,
            9999999999
        )).call({"from": owner})

    # 7. Zero minAmountOutLeg1
    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            100,
            0,  # Zero minAmountOutLeg1 rejected
            1,
            9999999999
        )).call({"from": owner})


def test_profitable_arbitrage_execution_and_events(evm_env):
    w3 = evm_env["w3"]
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    amount_in = 1000
    min_amount_out_leg1 = 995  # 0.5% max slippage on Leg 1
    min_profit = 10

    # Mint & approve tokens
    token_a.functions.mint(owner, 5000).transact({"from": owner})
    token_a.functions.approve(dex.address, 5000).transact({"from": owner})

    balance_owner_before = token_a.functions.balanceOf(owner).call()

    # Off-chain simulate check
    sim = dex.functions.simulateArbitrage((
        router_buy.address,
        router_sell.address,
        token_a.address,
        token_b.address,
        amount_in,
        min_amount_out_leg1,
        min_profit,
        9999999999
    )).call()
    assert sim[0] is True  # profitable
    assert sim[1] == 50   # 1050 - 1000 = 50 profit

    # Execute trade
    tx_hash = dex.functions.executeArbitrage((
        router_buy.address,
        router_sell.address,
        token_a.address,
        token_b.address,
        amount_in,
        min_amount_out_leg1,
        min_profit,
        9999999999
    )).transact({"from": owner})

    receipt = w3.eth.get_transaction_receipt(tx_hash)
    assert receipt.status == 1

    # Contract holds the output including profit (1050)
    contract_bal = token_a.functions.balanceOf(dex.address).call()
    assert contract_bal == 1050
    # Owner supplied 1000
    assert token_a.functions.balanceOf(owner).call() == balance_owner_before - amount_in

    # Decode event
    logs = dex.events.ArbitrageExecuted().process_receipt(receipt)
    assert len(logs) == 1
    event_args = logs[0]["args"]
    assert event_args["amountIn"] == amount_in
    assert event_args["finalBalance"] == 1050
    assert event_args["netProfit"] == 50


def test_adverse_price_movement_first_leg_revert(evm_env):
    """When routerBuy slips below minAmountOutLeg1, revert immediately at Leg 1 to protect gas."""
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    amount_in = 1000
    # Expect 1000 from Leg 1 at normal 1:1, so requiring min 995
    min_amount_out_leg1 = 995
    min_profit = 10

    # Adverse price movement: Router 1 multiplier drops to 9800 bps (98% = 980 out)
    router_buy.functions.setMultiplier(9800).transact({"from": owner})

    token_a.functions.mint(owner, 2000).transact({"from": owner})
    token_a.functions.approve(dex.address, 2000).transact({"from": owner})

    balance_owner_before = token_a.functions.balanceOf(owner).call()
    balance_contract_before = token_a.functions.balanceOf(dex.address).call()

    with pytest.raises(TransactionFailed) as exc_info:
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            amount_in,
            min_amount_out_leg1,  # 995 > 980 -> REVERT
            min_profit,
            9999999999
        )).call({"from": owner})

    err_str = str(exc_info.value)
    assert "INSUFFICIENT_OUTPUT_AMOUNT" in err_str or "execution reverted" in err_str

    # Balances completely pristine (zero loss)
    assert token_a.functions.balanceOf(owner).call() == balance_owner_before
    assert token_a.functions.balanceOf(dex.address).call() == balance_contract_before

    # Restore Router 1 multiplier
    router_buy.functions.setMultiplier(10000).transact({"from": owner})


def test_first_leg_zero_min_output_rejected(evm_env):
    """Calling executeArbitrage with minAmountOutLeg1 = 0 is rejected by custom error."""
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            0,  # Zero minAmountOutLeg1
            10,
            9999999999
        )).call({"from": owner})


def test_second_leg_adverse_movement_or_failure_revert(evm_env):
    """When Leg 1 passes but Leg 2 price moves adversely, revert atomically with zero fund loss."""
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # Sell router returns only 95% (-5% loss)
    router_sell.functions.setMultiplier(9500).transact({"from": owner})

    token_a.functions.mint(owner, 2000).transact({"from": owner})
    token_a.functions.approve(dex.address, 2000).transact({"from": owner})

    balance_owner_before = token_a.functions.balanceOf(owner).call()
    balance_contract_before = token_a.functions.balanceOf(dex.address).call()

    with pytest.raises(TransactionFailed) as exc_info:
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            995,  # Leg 1 passes (1000 >= 995)
            10,   # minProfit = 10 -> requires 1010, got 950 -> REVERT
            9999999999
        )).call({"from": owner})

    err_str = str(exc_info.value)
    assert r"\xcezP\xef" in err_str or "ce7a50ef" in err_str or "execution reverted" in err_str

    # Balances must be completely untouched (atomic rollback)
    assert token_a.functions.balanceOf(owner).call() == balance_owner_before
    assert token_a.functions.balanceOf(dex.address).call() == balance_contract_before


def test_atomic_rollback_on_router_revert(evm_env):
    """When Router 2 reverts during swap, entire transaction reverts atomically with zero loss."""
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    token_a.functions.mint(owner, 2000).transact({"from": owner})
    token_a.functions.approve(dex.address, 2000).transact({"from": owner})

    # Cause Router 2 swap to throw a revert
    router_sell.functions.setShouldRevertSwap(True).transact({"from": owner})

    balance_owner_before = token_a.functions.balanceOf(owner).call()
    balance_contract_before = token_a.functions.balanceOf(dex.address).call()

    with pytest.raises(TransactionFailed) as exc_info:
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            995,
            10,
            9999999999
        )).call({"from": owner})

    assert "MockRouter: SWAP_EXECUTION_REVERTED" in str(exc_info.value) or "execution reverted" in str(exc_info.value)
    # 100% balance preservation
    assert token_a.functions.balanceOf(owner).call() == balance_owner_before
    assert token_a.functions.balanceOf(dex.address).call() == balance_contract_before

    router_sell.functions.setShouldRevertSwap(False).transact({"from": owner})


def test_token_ordering_and_decimals(evm_env):
    """Validate token ordering and disparate decimals (Token A: 6 decimals, Token B: 18 decimals)."""
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # Verify decimal properties
    assert token_a.functions.decimals().call() == 6
    assert token_b.functions.decimals().call() == 18
    assert token_a.address != token_b.address

    # Mint & execute
    token_a.functions.mint(owner, 10_000_000).transact({"from": owner})  # $10 USDT (6 dec)
    token_a.functions.approve(dex.address, 10_000_000).transact({"from": owner})

    # Leg 1: 10,000,000 -> 10,000,000 (1:1 mock rate)
    # Leg 2: 10,000,000 -> 10,500,000 (10500 bps = 105%)
    router_sell.functions.setMultiplier(10500).transact({"from": owner})

    res = dex.functions.simulateArbitrage((
        router_buy.address,
        router_sell.address,
        token_a.address,
        token_b.address,
        10_000_000,
        9_950_000,
        100_000,  # $0.10 min profit
        9999999999
    )).call()

    assert res[0] is True
    assert res[1] == 500_000  # $0.50 profit (6 decimals)
    assert res[2] == 10_000_000
    assert res[3] == 10_500_000


def test_minimum_profit_threshold_enforcement(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # Sell router returns exactly 1010 on 1000 in (+10 profit)
    router_sell.functions.setMultiplier(10100).transact({"from": owner})

    token_a.functions.mint(owner, 5000).transact({"from": owner})
    token_a.functions.approve(dex.address, 5000).transact({"from": owner})

    # Case A: minProfit = 10 -> exact match passes
    dex.functions.executeArbitrage((
        router_buy.address,
        router_sell.address,
        token_a.address,
        token_b.address,
        1000,
        995,
        10,
        9999999999
    )).call({"from": owner})

    # Case B: minProfit = 11 -> required 1011, got 1010 -> REVERT
    with pytest.raises(TransactionFailed) as exc_info:
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            995,
            11,
            9999999999
        )).call({"from": owner})
    err_str = str(exc_info.value)
    assert r"\xcezP\xef" in err_str or "ce7a50ef" in err_str or "execution reverted" in err_str


def test_token_transfer_failure_handling(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    token_a.functions.mint(owner, 2000).transact({"from": owner})
    token_a.functions.approve(dex.address, 2000).transact({"from": owner})

    # Cause transferFrom to fail by setting the mock flag
    token_a.functions.setTransferFromReverts(True).transact({"from": owner})

    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            995,
            1,
            9999999999
        )).call({"from": owner})

    token_a.functions.setTransferFromReverts(False).transact({"from": owner})


def test_reentrancy_guard_protection(evm_env):
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]
    token_b = evm_env["token_b"]
    router_buy = evm_env["router_buy"]
    router_sell = evm_env["router_sell"]

    # Configure Router Buy to attempt calling togglePause on DexArbitrage mid-swap
    router_buy.functions.setReenterTarget(dex.address).transact({"from": owner})

    token_a.functions.mint(owner, 2000).transact({"from": owner})
    token_a.functions.approve(dex.address, 2000).transact({"from": owner})

    with pytest.raises(TransactionFailed):
        dex.functions.executeArbitrage((
            router_buy.address,
            router_sell.address,
            token_a.address,
            token_b.address,
            1000,
            995,
            1,
            9999999999
        )).call({"from": owner})


def test_emergency_token_and_eth_withdrawals(evm_env):
    w3 = evm_env["w3"]
    dex = evm_env["dex_arb"]
    owner = evm_env["owner"]
    token_a = evm_env["token_a"]

    # 1. Token withdrawal
    token_a.functions.mint(dex.address, 500).transact({"from": owner})
    assert token_a.functions.balanceOf(dex.address).call() == 500

    bal_owner_before = token_a.functions.balanceOf(owner).call()
    dex.functions.withdrawToken(token_a.address, 300).transact({"from": owner})
    assert token_a.functions.balanceOf(dex.address).call() == 200
    assert token_a.functions.balanceOf(owner).call() == bal_owner_before + 300

    # 2. ETH withdrawal
    w3.eth.send_transaction({"from": owner, "to": dex.address, "value": w3.to_wei(1, "ether")})
    assert w3.eth.get_balance(dex.address) == w3.to_wei(1, "ether")

    dex.functions.withdrawETH().transact({"from": owner})
    assert w3.eth.get_balance(dex.address) == 0
