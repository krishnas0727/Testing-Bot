"""Runs the REAL live_executor + REAL DexArbitrage.sol on an in-process EVM (no funds, no internet).
   python scripts/local_chain_test.py     (needs: pip install \"web3[tester]\")
"""
import json, os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ['DATA_DIR'] = os.path.join(ROOT, 'data_localtest')
os.makedirs(os.environ['DATA_DIR'], exist_ok=True)
os.environ['TRADING_MODE'] = 'TESTNET'
from web3 import Web3, EthereumTesterProvider
from eth_account import Account
import config, live_executor

art = json.load(open(os.path.join(ROOT, 'build', 'test_artifacts.json')))
w3 = Web3(EthereumTesterProvider())
CHAIN = w3.eth.chain_id
funder = w3.eth.accounts[0]
bot = Account.create()
w3.eth.send_transaction({'from': funder, 'to': bot.address, 'value': 10 * 10**18})

def deploy(name, *args, sender=None):
    c = w3.eth.contract(abi=art[name]['abi'], bytecode=art[name]['bytecode'])
    if sender is None:
        h = c.constructor(*args).transact({'from': funder})
    else:
        tx = c.constructor(*args).build_transaction({'from': sender.address, 'nonce': w3.eth.get_transaction_count(sender.address), 'chainId': CHAIN})
        h = w3.eth.send_raw_transaction(sender.sign_transaction(tx).raw_transaction)
    rc = w3.eth.wait_for_transaction_receipt(h)
    return w3.eth.contract(address=rc['contractAddress'], abi=art[name]['abi'])

usdc = deploy('MockERC20', 'USDC', 'USDC', 6)
weth = deploy('MockERC20', 'WETH', 'WETH', 18)
rA = deploy('MockUniswapV2Router')   # buy leg  (USDC -> WETH)
rB = deploy('MockUniswapV2Router')   # sell leg (WETH -> USDC)
arb = deploy('DexArbitrage', sender=bot)

def tx(fn): w3.eth.wait_for_transaction_receipt(fn.transact({'from': funder}))
tx(weth.functions.mint(rA.address, 10**21)); tx(usdc.functions.mint(rB.address, 10**12))
tx(usdc.functions.mint(bot.address, 50 * 10**6))
tx(rA.functions.setFixedOutputAmount(5 * 10**15))          # 10 USDC -> 0.005 WETH
tx(rB.functions.setFixedOutputAmount(10_500_000))          # 0.005 WETH -> 10.5 USDC  (+0.5 gross)

# ---- wire config to the local chain ----
config.CHAIN_REGISTRY[CHAIN] = {
    'name': 'local', 'label': 'Local', 'chain_id': CHAIN, 'is_testnet': True, 'currency': 'ETH', 'explorer': '', 'rpc_url': 'http://x',
    'fallbacks': [], 'dexes': ['Uniswap_V2', 'SushiSwap_V2'],
    'routers': {'Uniswap_V2': rA.address, 'SushiSwap_V2': rB.address}, 'factories': {},
    'tokens': {'WETH': {'address': weth.address, 'decimals': 18, 'symbol': 'WETH'}, 'USDC': {'address': usdc.address, 'decimals': 6, 'symbol': 'USDC'}},
    'pairs': ['WETH/USDC'], 'default_symbol': 'WETH/USDC', 'arbitrage_contract': arb.address}
config.set_active_chain(CHAIN)
config.SYMBOL = 'WETH/USDC'
config.PRIVATE_KEY = bot.key.hex(); config.WALLET_ADDRESS = bot.address
config.ARBITRAGE_CONTRACT_ADDRESS = arb.address
config.TRADING_MODE = 'TESTNET'
live_executor.get_w3 = lambda: w3

def plan(amount=10.0, **kw):
    p = {'buy_dex': 'Uniswap_V2', 'sell_dex': 'SushiSwap_V2', 'amount_in': amount, 'token_pair': 'WETH/USDC',
         'gas_cost_usdt': 0.01, 'eth_price_usdt': 2000.0, 'buy_price': 2000.0, 'max_price_impact_pct': 0.1,
         'detected_at_ms': time.time() * 1000 - 40}
    p.update(kw); return p

print('--- preflight ---'); print(live_executor.preflight('USDC'))

print('\n--- T1: no allowance, contract empty -> must refuse ---')
r = live_executor.execute_live(plan()); print(r['status'], '|', r['message'])

print('\n--- approve, then T2: profitable trade ---')
tx_ = usdc.functions.approve(arb.address, 100 * 10**6).build_transaction({'from': bot.address, 'nonce': w3.eth.get_transaction_count(bot.address), 'chainId': CHAIN})
w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(bot.sign_transaction(tx_).raw_transaction))
bal0 = usdc.functions.balanceOf(bot.address).call()
r = live_executor.execute_live(plan())
print(r['status'], '|', r['message']); print('timings_ms:', r.get('timings_ms'))
print('contract now holds (profit stays in contract):', usdc.functions.balanceOf(arb.address).call() / 1e6, 'USDC; wallet delta:', (usdc.functions.balanceOf(bot.address).call() - bal0) / 1e6)

print('\n--- T3: spread disappears (sell router pays only 9.9) -> must NOT send ---')
tx(rB.functions.setFixedOutputAmount(9_900_000))
nonce_before = w3.eth.get_transaction_count(bot.address)
r = live_executor.execute_live(plan()); print(r['status'], '|', r['message'])
print('nonce unchanged (nothing broadcast):', nonce_before == w3.eth.get_transaction_count(bot.address))

print('\n--- T4: profit too small vs gas+margin (10.02) -> must NOT send ---')
tx(rB.functions.setFixedOutputAmount(10_020_000))
r = live_executor.execute_live(plan()); print(r['status'], '|', r['message'])

print('\n--- T5: router fails at execution -> simulation reverts, nothing sent ---')
tx(rB.functions.setFixedOutputAmount(10_500_000)); tx(rB.functions.setFailSwap(True))
r = live_executor.execute_live(plan()); print(r['status'], '|', r['message'][:140])
print('\ntiming log:'); print(open(os.path.join(os.environ['DATA_DIR'], 'trade_timing.jsonl')).read())
