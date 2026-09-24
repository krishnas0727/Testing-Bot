# Live On-Chain Verification Protocol

## On-Chain Verification Pipeline

The verification protocol verifies the complete decentralized trading pipeline without exposing real funds:

1. **RPC Connectivity**: Verifies connection to EVM node and fetches current block number.
2. **Gas Estimation**: Fetches base fee and priority fee in Gwei, computing USD transaction costs.
3. **Pool Reserves**: Validates executable depth across Uniswap V2 and SushiSwap V2.
4. **Smart Contract Verification**: Verifies bytecode presence of `DexArbitrage.sol` on the target network.
5. **Simulation (`eth_call`)**: Simulates the multi-hop swap on-chain to guarantee positive return and atomic revert behavior.
