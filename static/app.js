// ============================================================
// 100% DECENTRALIZED ARBITRAGE TERMINAL JAVASCRIPT
// Uniswap V2 & SushiSwap V2 Web3 Engine Interface
// ============================================================

// Suppress noisy internal browser extension EventEmitter & Tracking Prevention notices
(function() {
    const filterTerms = [
        "MaxListenersExceededWarning",
        "ObjectMultiplex",
        "Tracking Prevention",
        "app-init-liveness",
        "background-liveness"
    ];
    const shouldFilter = function(item) {
        if (!item) return false;
        const s = typeof item === "string" ? item : (item.message || (typeof item.toString === "function" ? item.toString() : ""));
        return filterTerms.some(function(term) { return s.indexOf(term) !== -1; });
    };
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = function() {
        for (let i = 0; i < arguments.length; i++) {
            if (shouldFilter(arguments[i])) return;
        }
        return origWarn.apply(console, arguments);
    };
    console.error = function() {
        for (let i = 0; i < arguments.length; i++) {
            if (shouldFilter(arguments[i])) return;
        }
        return origError.apply(console, arguments);
    };
})();

// Safe Storage wrapper resilient to browser Tracking Prevention & strict cookie policies
const safeStorage = {
    _memory: {},
    getItem(key) {
        try {
            if (typeof window !== "undefined" && window.localStorage) {
                return window.localStorage.getItem(key);
            }
        } catch (e) {
            // Storage access blocked by browser Tracking Prevention
        }
        return this._memory[key] || null;
    },
    setItem(key, value) {
        try {
            if (typeof window !== "undefined" && window.localStorage) {
                window.localStorage.setItem(key, value);
                return;
            }
        } catch (e) {
            // Storage access blocked by browser Tracking Prevention
        }
        this._memory[key] = String(value);
    },
    removeItem(key) {
        try {
            if (typeof window !== "undefined" && window.localStorage) {
                window.localStorage.removeItem(key);
                return;
            }
        } catch (e) {
            // Storage access blocked by browser Tracking Prevention
        }
        delete this._memory[key];
    }
};

// ============================================================
// CENTRALIZED MULTI-CHAIN SPECIFICATIONS & TOKEN REGISTRY
// Single Source of Truth for Global Selected-Chain State
// ============================================================

const SUPPORTED_CHAINS = {
    8453: {
        id: 8453,
        name: "Base L2 Mainnet",
        short: "Base L2",
        currency: "ETH",
        isTestnet: false,
        decimals: 18,
        explorer: "https://basescan.org",
        hex: "0x2105",
        rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        defaultPair: "WETH/USDC",
        pairs: ["WETH/USDC", "WETH/USDT", "WETH/DAI"]
    },
    84532: {
        id: 84532,
        name: "Base Sepolia Testnet",
        short: "Base Sepolia",
        currency: "ETH",
        isTestnet: true,
        decimals: 18,
        explorer: "https://sepolia.basescan.org",
        hex: "0x14a34",
        rpcUrls: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        defaultPair: "WETH/USDC",
        pairs: ["WETH/USDC", "WETH/USDT"]
    },
    137: {
        id: 137,
        name: "Polygon PoS",
        short: "Polygon",
        currency: "POL",
        isTestnet: false,
        decimals: 18,
        explorer: "https://polygonscan.com",
        hex: "0x89",
        rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        defaultPair: "WETH/USDT",
        pairs: ["WETH/USDT", "WETH/USDC"]
    },
    42161: {
        id: 42161,
        name: "Arbitrum One",
        short: "Arbitrum",
        currency: "ETH",
        isTestnet: false,
        decimals: 18,
        explorer: "https://arbiscan.io",
        hex: "0xa4b1",
        rpcUrls: ["https://arbitrum-one-rpc.publicnode.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        defaultPair: "WETH/USDC",
        pairs: ["WETH/USDC", "WETH/USDT"]
    },
    1: {
        id: 1,
        name: "Ethereum Mainnet",
        short: "Ethereum",
        currency: "ETH",
        isTestnet: false,
        decimals: 18,
        explorer: "https://etherscan.io",
        hex: "0x1",
        rpcUrls: ["https://eth.llamarpc.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        defaultPair: "WETH/USDT",
        pairs: ["WETH/USDT", "WETH/USDC", "WETH/DAI"]
    },
    11155111: {
        id: 11155111,
        name: "Sepolia Testnet",
        short: "SepoliaETH",
        currency: "SepoliaETH",
        isTestnet: true,
        decimals: 18,
        explorer: "https://sepolia.etherscan.io",
        hex: "0xaa36a7",
        rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        defaultPair: "WETH/USDC",
        pairs: ["WETH/USDC", "WETH/USDT"]
    }
};

const CLIENT_TOKEN_ADDRESSES = {
    8453: { // Base L2
        USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
        USDbC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
        USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
        DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
        WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 }
    },
    1: { // Ethereum Mainnet
        USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
        USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
        DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
        WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
        WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 }
    },
    42161: { // Arbitrum One
        USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
        USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
        WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 }
    },
    137: { // Polygon PoS
        USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
        USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
        WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 }
    },
    11155111: { // Sepolia Testnet
        USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
        USDT: { address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", decimals: 6 },
        WETH: { address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", decimals: 18 }
    },
    84532: { // Base Sepolia Testnet
        USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
        USDT: { address: "0x0a1e4ff477ff2099307c87c06eb73cbeec0678eb", decimals: 6 },
        WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 }
    }
};

const CLIENT_ROUTER_ADDRESSES = {
    8453: { // Base L2
        Uniswap_V2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        SushiSwap_V2: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891"
    },
    1: { // Ethereum
        Uniswap_V2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        SushiSwap_V2: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"
    },
    42161: { // Arbitrum One
        Uniswap_V2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
    },
    137: { // Polygon PoS
        Uniswap_V2: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
    },
    11155111: { // Sepolia Testnet
        Uniswap_V2: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
        SushiSwap_V2: "0xeaBcE3E74EF41FB40024a21Cc2ee2F5dDc615791"
    },
    84532: { // Base Sepolia Testnet
        Uniswap_V2: "0x1662C4Ca803B6d5d42C85d552318b7625038923d",
        SushiSwap_V2: "0x1662C4Ca803B6d5d42C85d552318b7625038923d"
    }
};

const CLIENT_FACTORY_ADDRESSES = {
    8453: {
        Uniswap_V2: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
        SushiSwap_V2: "0x71524b4f93c58fcbf659783284e38825f0622859"
    },
    1: {
        Uniswap_V2: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
        SushiSwap_V2: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"
    },
    42161: {
        Uniswap_V2: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
        SushiSwap_V2: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
    },
    137: {
        Uniswap_V2: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
        SushiSwap_V2: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
    },
    11155111: {
        Uniswap_V2: "0x7E0987E5b3a30e3f2828572Bb659A548460a3003",
        SushiSwap_V2: "0x734583F62bB6acE3c9bA9Bd5a53143CA2CE8c55a"
    },
    84532: {
        Uniswap_V2: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
        SushiSwap_V2: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6"
    }
};

const CLIENT_FACTORY_V2_ABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

let currentTab = "dashboard";
let selectedTradeAmount = 5;
let latestMarketData = null;
let liveChart = null;
let priceSnapshots = [];
const MAX_SNAPSHOTS = 30;

let currentChainEpoch = 0;
let currentSelectedChainId = parseInt(safeStorage.getItem("userSelectedChainId") || "8453", 10);
if (isNaN(currentSelectedChainId) || !SUPPORTED_CHAINS[currentSelectedChainId]) currentSelectedChainId = 8453;

function getSelectedChain() {
    return SUPPORTED_CHAINS[currentSelectedChainId] || SUPPORTED_CHAINS[8453];
}

function invalidateAndResetChainUI(newChainId) {
    const chainIdNum = Number(newChainId);
    if (!SUPPORTED_CHAINS[chainIdNum]) return;

    currentChainEpoch++;
    currentSelectedChainId = chainIdNum;
    safeStorage.setItem("userSelectedChainId", chainIdNum);
    latestMarketData = null;

    const chainInfo = SUPPORTED_CHAINS[chainIdNum];
    const shortUpper = (chainInfo.short || chainInfo.name).toUpperCase();

    // 1. Invalidate live ticker prices & gas
    setText("tickerUniswap", "--");
    setText("tickerSushiSwap", "--");
    setText("tickerSpread", "Switching network...");
    setText("tickerGasPrice", "--");
    const sym = chainInfo.defaultPair || (chainIdNum === 8453 || chainIdNum === 84532 ? "WETH/USDC" : "WETH/USDT");
    setText("tickerUniLabel", `Uniswap V2 ${sym}`);
    setText("tickerSushiLabel", `SushiSwap V2 ${sym}`);

    // 2. Invalidate Pools tab spot prices and reserves
    setText("uniSpotPrice", "--");
    setText("sushiSpotPrice", "--");
    setText("uniResBase", "--");
    setText("uniResQuote", "--");
    setText("sushiResBase", "--");
    setText("sushiResQuote", "--");
    setText("uniChainLabel", `(${chainInfo.short || chainInfo.name})`);
    setText("sushiChainLabel", `(${chainInfo.short || chainInfo.name})`);

    // 3. Clear Chart snapshots and update dataset labels
    priceSnapshots = [];
    if (liveChart) {
        liveChart.data.labels = [];
        liveChart.data.datasets[0].data = [];
        liveChart.data.datasets[1].data = [];
        liveChart.data.datasets[0].label = `Uniswap V2 (${chainInfo.short || chainInfo.name})`;
        liveChart.data.datasets[1].label = `SushiSwap V2 (${chainInfo.short || chainInfo.name})`;
        liveChart.update();
    }

    // 4. Invalidate Best DEX Route panel
    setText("oppBuyDex", "Scanning...");
    setText("oppBuyPrice", "$0.00");
    setText("oppSellDex", "Scanning...");
    setText("oppSellPrice", "$0.00");
    setText("oppSpread", "$0.00 (0.00%)");
    setText("oppNetProfit", "$0.00");
    setText("oppImpact", "0.00%");
    setText("oppGas", "$0.00");
    setText("flowInputToken", sym.split("/")[1] || "USDT");
    setText("flowOutputToken", sym.split("/")[1] || "USDT");
    setText("flowBridgeAsset", `${sym.split("/")[0] || "WETH"} BRIDGE`);
    setText("flowOutputProfit", "+$0.00 (+0.00%)");
    const oppBadge = document.getElementById("oppBadge");
    if (oppBadge) {
        oppBadge.innerText = "SCANNING";
        oppBadge.className = "badge badge-yellow";
    }
    const oppDiagReason = document.getElementById("oppDiagReason");
    if (oppDiagReason) {
        oppDiagReason.innerText = `Scanning liquidity pools on ${chainInfo.name}...`;
        oppDiagReason.style.color = "var(--text-secondary)";
    }
    const oppDiagBadge = document.getElementById("oppDiagBadge");
    if (oppDiagBadge) {
        oppDiagBadge.innerText = "SWITCHING";
        oppDiagBadge.className = "badge badge-blue";
    }
    const bestRouteTimestamp = document.getElementById("bestRouteTimestamp");
    if (bestRouteTimestamp) bestRouteTimestamp.innerText = "";

    // 5. Invalidate Multi-Pair Heatmap grid
    const grid = document.getElementById("multiPairGrid");
    if (grid) {
        grid.innerHTML = `<div id="multiPairPlaceholder" style="color:var(--text-muted); font-size:12px; padding:15px;">Scanning ${chainInfo.name} pairs...</div>`;
    }

    // 6. Invalidate wallet balances
    clientWalletBalances = { eth: 0, weth: 0, usdt: 0, usdc: 0, usdbc: 0, updated: 0 };
    setText("kpiBalance", "--");
    setText("balETH", "--");
    setText("balETHusd", "--");
    setText("balWETH", "--");
    setText("balWETHusd", "--");
    setText("balUSDT", "--");
    setText("balUSDC", "--");

    // Invalidate KPI Engine Status immediately
    setText("kpiStatus", "SWITCHING");
    setText("kpiStatusSub", `Switching to ${chainInfo.name}...`);
    const kpiStatusResetEl = document.getElementById("kpiStatus");
    if (kpiStatusResetEl) kpiStatusResetEl.className = "value text-blue";

    // 7. Update all prominent visual badges, labels, and modal pipeline steps
    setText("globalNetworkText", `NETWORK: ${shortUpper}`);
    setText("heatmapChainLabel", `(${chainInfo.short || chainInfo.name})`);
    setText("bestRouteChainBadge", shortUpper);
    setText("bestRouteChainName", chainInfo.name);
    setText("networkSpeedLabel", `${chainInfo.short} Speed`);
    setText("stepPill4Name", chainInfo.short || chainInfo.name);
    setText("execModalSub", `Invoking ${chainInfo.name} Smart Router via Web3 RPC`);

    if (chainIdNum === 137) {
        setText("networkSpeedVal", "⚡ ~2.1s Block");
        setText("networkFeeLabel", "Avg POL Fee");
        setText("networkFeeVal", "< 0.01 POL");
        setText("balUSDCsub", "Polygon Secondary Liquidity");
        setText("balUSDTsub", "Polygon Primary Liquidity");
    } else if (chainIdNum === 42161) {
        setText("networkSpeedVal", "⚡ ~0.25s Block");
        setText("networkFeeLabel", "Avg Nitro Fee");
        setText("networkFeeVal", "< $0.01");
        setText("balUSDCsub", "Arbitrum Primary Liquidity");
        setText("balUSDTsub", "Arbitrum Active Inventory");
    } else if (chainIdNum === 1) {
        setText("networkSpeedVal", "⚡ ~12.0s Block");
        setText("networkFeeLabel", "Avg Gas Fee");
        setText("networkFeeVal", "~$1.50");
        setText("balUSDCsub", "Ethereum Primary Liquidity");
        setText("balUSDTsub", "Ethereum Active Inventory");
    } else if (chainIdNum === 11155111) {
        setText("networkSpeedVal", "⚡ ~12.0s Block");
        setText("networkFeeLabel", "Sepolia Faucet");
        setText("networkFeeVal", "Free (0.00)");
        setText("balUSDCsub", "Sepolia Test Token");
        setText("balUSDTsub", "Sepolia Primary Liquidity");
    } else if (chainIdNum === 84532) {
        setText("networkSpeedVal", "⚡ ~2.0s Block");
        setText("networkFeeLabel", "Avg Testnet Fee");
        setText("networkFeeVal", "Free (0.00)");
        setText("balUSDCsub", "Base Sepolia Primary");
        setText("balUSDTsub", "Base Sepolia Secondary");
    } else {
        setText("networkSpeedVal", "⚡ ~2.0s Block");
        setText("networkFeeLabel", "Avg L2 Fee");
        setText("networkFeeVal", "< $0.001");
        setText("balUSDCsub", "Base L2 Primary Liquidity");
        setText("balUSDTsub", "Active Arbitrage Inventory");
    }

    // 8. Update network selector cards & dropdowns
    if (typeof updateNetworkCardsVisual === "function") {
        updateNetworkCardsVisual(chainIdNum);
    }

    // 9. Cancel any in-progress transaction modal
    if (typeof closeExecModal === "function") {
        closeExecModal();
    }

    // 10. Revalidate MetaMask wallet reconciliation
    if (metamaskAccount && typeof updateWalletUIConnected === "function") {
        updateWalletUIConnected(metamaskAccount, metamaskChainId);
    }
}

// Web Audio API State & Synthesizer
let terminalAudioCtx = null;
let terminalSoundEnabled = safeStorage.getItem("terminalSoundEnabled") !== "false";
let lastChimedRoute = "";
let lastChimeTime = 0;

function initTerminalAudio() {
    updateAudioButtonUI();
    const unlockAudio = () => {
        if (!terminalAudioCtx) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) terminalAudioCtx = new AudioContextClass();
            } catch (e) {}
        }
        if (terminalAudioCtx && terminalAudioCtx.state === "suspended") {
            terminalAudioCtx.resume();
        }
        window.removeEventListener("pointerdown", unlockAudio);
        window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
}

function toggleTerminalAudio() {
    terminalSoundEnabled = !terminalSoundEnabled;
    safeStorage.setItem("terminalSoundEnabled", terminalSoundEnabled ? "true" : "false");
    updateAudioButtonUI();
    if (terminalSoundEnabled) {
        playTerminalSound("test");
        showToast("🔊 Audio Chimes Enabled", "info");
    } else {
        showToast("🔇 Audio Chimes Muted", "info");
    }
}

function updateAudioButtonUI() {
    const btn = document.getElementById("btnSoundToggle");
    if (btn) {
        if (terminalSoundEnabled) {
            btn.innerHTML = `<span style="font-size:12px;">🔊</span> <span id="soundToggleLabel" style="font-size:11px; font-weight:700;">Sound ON</span>`;
            btn.className = "sound-toggle-pill sound-active";
        } else {
            btn.innerHTML = `<span style="font-size:12px;">🔇</span> <span id="soundToggleLabel" style="font-size:11px; font-weight:700;">Muted</span>`;
            btn.className = "sound-toggle-pill sound-muted";
        }
    }
}

function playTerminalSound(type) {
    if (!terminalSoundEnabled) return;
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!terminalAudioCtx) {
            terminalAudioCtx = new AudioContextClass();
        }
        if (terminalAudioCtx.state === "suspended") {
            terminalAudioCtx.resume();
        }
        const now = terminalAudioCtx.currentTime;
        const osc = terminalAudioCtx.createOscillator();
        const gain = terminalAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(terminalAudioCtx.destination);

        if (type === "opp" || type === "profitable") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(587.33, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.12, now + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === "trade_success") {
            osc.type = "triangle";
            osc.frequency.setValueAtTime(523.25, now);
            osc.frequency.setValueAtTime(659.25, now + 0.08);
            osc.frequency.setValueAtTime(783.99, now + 0.16);
            osc.frequency.setValueAtTime(1046.50, now + 0.24);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
            osc.start(now);
            osc.stop(now + 0.55);
        } else if (type === "alert" || type === "error") {
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(220, now);
            osc.frequency.linearRampToValueAtTime(160, now + 0.2);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.08, now + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        } else {
            osc.type = "sine";
            osc.frequency.setValueAtTime(700, now);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        }
    } catch (e) {
        console.warn("WebAudio synthesis notice:", e);
    }
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initChart();
    initTerminalAudio();
    handleInitialRoute();
    startClock();
    invalidateAndResetChainUI(currentSelectedChainId);
    startPolling();
    loadSettings();
    loadTrades();
    initMetaMask();
    fetchMultiPairData();
    setInterval(fetchMultiPairData, 3500);
});

// Close wallet dropdown when clicking anywhere outside
document.addEventListener("click", (e) => {
    const container = document.getElementById("headerWalletContainer");
    const menu = document.getElementById("walletDropdownMenu");
    if (menu && menu.style.display !== "none" && container && !container.contains(e.target)) {
        menu.style.display = "none";
    }
});

function handleInitialRoute() {
    const path = window.location.pathname.replace("/", "") || "dashboard";
    const validTabs = ["dashboard", "prices", "arbitrage", "trades", "settings"];
    const target = validTabs.includes(path) ? path : "dashboard";
    switchTab(null, target);
}

function switchTab(event, tabName) {
    if (event) event.preventDefault();
    currentTab = tabName;

    // Update URL without page reload
    const newPath = tabName === "dashboard" ? "/" : "/" + tabName;
    window.history.pushState({}, "", newPath);

    // Update nav links
    document.querySelectorAll(".sidebar nav a").forEach(el => el.classList.remove("active"));
    const activeNav = document.getElementById("nav-" + tabName);
    if (activeNav) activeNav.classList.add("active");

    // Update tab contents
    document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
    const activeContent = document.getElementById("tab-" + tabName);
    if (activeContent) activeContent.classList.add("active");

    // Update header titles
    const titles = {
        dashboard: { title: "DEX Arbitrage Terminal", sub: "100% Decentralized On-Chain Arbitrage Monitor (Uniswap V2 • SushiSwap V2)" },
        prices: { title: "DEX Pools & Liquidity Reserves", sub: "Live On-Chain Constant-Product Pool Reserves via Web3 JSON-RPC" },
        arbitrage: { title: "DEX-to-DEX Atomic Execution", sub: "Atomic Multi-Hop Arbitrage Execution via DexArbitrage.sol" },
        trades: { title: "On-Chain & Simulated Trade Audit Log", sub: "Immutable Execution History, Transaction Hashes, and Gas Receipts" },
        settings: { title: "Web3 & Protocol Settings", sub: "Blockchain JSON-RPC Endpoints, Non-Custodial Wallet, and Execution Controls" },
    };
    if (titles[tabName]) {
        document.getElementById("pageTitle").innerText = titles[tabName].title;
        document.getElementById("pageSubtitle").innerText = titles[tabName].sub;
    }

    if (tabName === "trades") {
        loadTrades();
        loadExecutionLogs();
    }
    if (tabName === "settings") loadSettings();
}

function startClock() {
    function updateTime() {
        const d = new Date();
        const el = document.getElementById("time");
        if (el) el.innerText = d.toTimeString().split(" ")[0];
    }
    updateTime();
    setInterval(updateTime, 1000);
}

// ============================================================
// CHART.JS INITIALIZATION
// ============================================================

function initChart() {
    const ctx = document.getElementById("liveChart");
    if (!ctx) return;

    liveChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                {
                    label: "Uniswap V2 (Base L2)",
                    borderColor: "#00f2fe",
                    backgroundColor: "rgba(0, 242, 254, 0.08)",
                    borderWidth: 2.5,
                    pointRadius: 1,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: "#00f2fe",
                    fill: true,
                    tension: 0.3,
                    data: [],
                },
                {
                    label: "SushiSwap V2 (Base L2)",
                    borderColor: "#00f59b",
                    backgroundColor: "rgba(0, 245, 155, 0.08)",
                    borderWidth: 2.5,
                    pointRadius: 1,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: "#00f59b",
                    fill: true,
                    tension: 0.3,
                    data: [],
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
                mode: "index",
                intersect: false,
            },
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    labels: {
                        color: "#cbd5e1",
                        font: { family: "'Inter', sans-serif", size: 11, weight: "600" },
                        boxWidth: 12,
                        boxHeight: 12,
                        usePointStyle: true,
                        pointStyle: "circle"
                    }
                },
                tooltip: {
                    backgroundColor: "rgba(8, 15, 28, 0.95)",
                    borderColor: "rgba(56, 189, 248, 0.3)",
                    borderWidth: 1,
                    titleColor: "#ffffff",
                    bodyColor: "#cbd5e1",
                    bodyFont: { family: "'JetBrains Mono', monospace" },
                    padding: 10,
                    displayColors: true,
                    cornerRadius: 8
                }
            },
            scales: {
                x: {
                    grid: { color: "rgba(56, 189, 248, 0.06)", borderColor: "rgba(56, 189, 248, 0.15)" },
                    ticks: { color: "#64748b", font: { family: "'JetBrains Mono', monospace", size: 10 } }
                },
                y: {
                    grid: { color: "rgba(56, 189, 248, 0.06)", borderColor: "rgba(56, 189, 248, 0.15)" },
                    ticks: {
                        color: "#94a3b8",
                        font: { family: "'JetBrains Mono', monospace", size: 10 },
                        callback: (v) => "$" + Number(v).toFixed(2)
                    }
                }
            }
        }
    });
}

function updateChart(prices) {
    if (!liveChart || !prices) return;
    const now = new Date().toLocaleTimeString();
    const uniPrice = Number(prices["Uniswap_V2"] || 0);
    const sushiPrice = Number(prices["SushiSwap_V2"] || 0);

    priceSnapshots.push({ time: now, uni: uniPrice, sushi: sushiPrice });
    if (priceSnapshots.length > MAX_SNAPSHOTS) priceSnapshots.shift();

    liveChart.data.labels = priceSnapshots.map(s => s.time);
    liveChart.data.datasets[0].data = priceSnapshots.map(s => s.uni);
    liveChart.data.datasets[1].data = priceSnapshots.map(s => s.sushi);

    const validPrices = priceSnapshots.flatMap(s => [s.uni, s.sushi]).filter(p => p > 0);
    if (validPrices.length > 0) {
        const minP = Math.min(...validPrices);
        const maxP = Math.max(...validPrices);
        const pad = Math.max(1, (maxP - minP) * 0.25);
        liveChart.options.scales.y.min = Math.floor(minP - pad);
        liveChart.options.scales.y.max = Math.ceil(maxP + pad);
    }
    liveChart.update("none");
}

// ============================================================
// MARKET DATA POLLING & UI UPDATE
// ============================================================

function startPolling() {
    fetchMarketData();
    setInterval(fetchMarketData, 1000);
}

// ============================================================
// AUTO-EXECUTE ENGINE — Immediate execution on profitable opportunity
// Runs on every market data update in LIVE/TESTNET mode
// ============================================================

let _autoExecLock = false;         // Prevent concurrent executions
let _autoExecCooldownUntil = 0;   // Timestamp: don't try again until this time
const AUTO_EXEC_COOLDOWN_MS = 15000; // 15s between auto-executions

async function maybeAutoExecute(marketPayload) {
    // Guard 1: Lock — only one execution at a time
    if (_autoExecLock) return;

    // Guard 2: Cooldown
    if (Date.now() < _autoExecCooldownUntil) return;

    // Guard 3: Settings check — auto_trade must be enabled
    const settings = marketPayload.settings || {};
    const autoTradeOn = Boolean(settings.auto_trade);
    if (!autoTradeOn) return;

    // Guard 4: Mode must be LIVE or TESTNET
    const mode = (settings.trading_mode || marketPayload.trading_mode || "MOCK").toUpperCase();
    if (mode !== "LIVE" && mode !== "TESTNET") return;

    // Guard 5: MetaMask wallet must be connected
    if (!metamaskAccount) return;

    // Guard 6: Emergency stop must be off
    const emergencyOn = Boolean(settings.emergency_stop || marketPayload.summary?.emergency_stop);
    if (emergencyOn) return;

    // Guard 7: Best route must be profitable (net_profit_usdt > 0) based on latest scan
    const best = marketPayload.data?.best_route || marketPayload.best_route;
    if (!best) return;
    const latestNet = Number(best.net_profit_usdt || 0);
    if (latestNet <= 0) return;

    // --- All guards passed — opportunity detected! ---
    console.log(
        `[AUTO-EXEC] Profitable opportunity detected: net=$${latestNet.toFixed(6)} USDT ` +
        `(${best.buy_dex} → ${best.sell_dex}). Triggering immediate execution...`
    );

    _autoExecLock = true;
    try {
        await executeAutoOpportunity(best);
    } catch (err) {
        console.warn("[AUTO-EXEC] Execution error:", err);
    } finally {
        _autoExecLock = false;
        _autoExecCooldownUntil = Date.now() + AUTO_EXEC_COOLDOWN_MS;
    }
}

async function executeAutoOpportunity(bestRoute) {
    const tradeAmt = selectedTradeAmount || Number(bestRoute.amount_in || 0.10);

    // Step 1: Show status in UI (non-blocking toast, no modal popup for auto-exec)
    showToast(
        `⚡ Auto-Exec: ${bestRoute.buy_dex?.replace("_", " ")} → ${bestRoute.sell_dex?.replace("_", " ")} | Net +$${Number(bestRoute.net_profit_usdt || 0).toFixed(4)}`,
        "success"
    );

    // Step 2: IMMEDIATE pre-execution fresh quote + profit recheck from backend
    let freshCheck;
    try {
        const verifyRes = await fetch("/api/trade/verify-profit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trade_amount: tradeAmt,
                wallet_address: metamaskAccount,
                chain_id: currentSelectedChainId,
            })
        });
        freshCheck = await verifyRes.json();
    } catch (err) {
        console.warn("[AUTO-EXEC] Failed to get fresh profit check:", err);
        return;
    }

    // Step 3: Recheck — still profitable after fresh quote?
    if (!freshCheck.is_profitable || Number(freshCheck.net_profit_usdt || 0) <= 0) {
        console.log(`[AUTO-EXEC] SKIPPED after recheck: ${freshCheck.skip_reason || "INSUFFICIENT_PROFIT"}`);
        showToast(`⚠️ Auto-Exec skipped: ${freshCheck.skip_reason || "Opportunity disappeared before execution"}`, "warning");
        return;
    }

    const freshNet = Number(freshCheck.net_profit_usdt);
    console.log(`[AUTO-EXEC] Fresh profit confirmed: net=$${freshNet.toFixed(6)} USDT. Signing via MetaMask...`);

    // Step 4: Route to MetaMask non-custodial execution (no server private key)
    // This uses the existing executeMetaMaskOnChainTrade which handles:
    //   - approve token if needed
    //   - swapExactTokensForTokens on buy DEX
    //   - swapExactTokensForTokens on sell DEX
    //   - wait for tx confirmation
    //   - record only on success
    try {
        await executeMetaMaskOnChainTrade({
            autoExec: true,
            tradeAmount: tradeAmt,
            freshRoute: freshCheck,
        });
    } catch (err) {
        if (err && err.code === 4001) {
            showToast("Auto-Exec: MetaMask signature rejected by user.", "warning");
        } else {
            console.warn("[AUTO-EXEC] MetaMask execution failed:", err);
        }
    }
}

async function fetchMarketData() {
    const thisEpoch = currentChainEpoch;
    const thisChainId = currentSelectedChainId;
    const t0 = performance.now();
    try {
        const params = new URLSearchParams();
        if (selectedTradeAmount) params.append("amount", selectedTradeAmount);
        if (metamaskAccount) params.append("address", metamaskAccount);
        // Always pass user's explicitly selected network ID
        params.append("chain_id", thisChainId);

        const qs = params.toString();
        const url = `/api/market?${qs}`;
        const res = await fetch(url);
        const json = await res.json();

        // Strict Race Condition & Epoch Guard:
        if (thisEpoch !== currentChainEpoch || thisChainId !== currentSelectedChainId) {
            return;
        }
        if (!json.success || !json.data) return;

        // Verify response belongs to currentSelectedChainId
        const respChainId = Number(json.data.chain_id || json.settings?.chain_id || json.wallet?.chain_id || thisChainId);
        if (respChainId !== currentSelectedChainId) {
            return;
        }

        const elapsed = Math.round(performance.now() - t0);
        const badge = document.getElementById("latencyBadge");
        if (badge) {
            badge.innerText = `⚡ ${elapsed}ms`;
            badge.style.color = elapsed < 150 ? "#22c55e" : (elapsed < 400 ? "#38bdf8" : "#f59e0b");
        }

        latestMarketData = {
            ...json.data,
            data: json.data,
            market: json.data,
            wallet: json.wallet || {},
            summary: json.summary || {},
            settings: json.settings || {},
            trading_mode: json.summary?.trading_mode || json.settings?.trading_mode || "MOCK",
            has_private_key: Boolean(json.settings?.has_private_key),
            chain_id: respChainId,
            best_route: json.data?.best_route || null
        };
        updateDashboardUI(json);
        updateChart(json.data.prices);

        // Periodically refresh client-side Web3 balances via MetaMask
        if (metamaskAccount && typeof fetchClientWalletBalances === "function") {
            if (!clientWalletBalances.updated || Date.now() - clientWalletBalances.updated > 4000) {
                fetchClientWalletBalances(metamaskAccount, currentSelectedChainId);
            }
        }

        // AUTO-EXECUTE: Immediately trigger trade if profitable and auto_trade is on in LIVE/TESTNET
        maybeAutoExecute(json);

    } catch (err) {
        console.warn("[DEX Polling Error]:", err);
    }
}


function updateDashboardUI(payload) {
    const data = payload.data;
    const wallet = payload.wallet || {};
    const summary = payload.summary || {};
    const settings = payload.settings || {};
    const best = data.best_route || {};
    const prices = data.prices || {};
    const reserves = data.reserves || {};

    // 1. Ticker bar
    const activeChainId = currentSelectedChainId;
    const sym = payload.symbol || settings.symbol || (activeChainId === 8453 ? "WETH/USDC" : "WETH/USDT");
    setText("tickerUniLabel", `Uniswap V2 ${sym}`);
    setText("tickerSushiLabel", `SushiSwap V2 ${sym}`);

    const uniP = Number(prices["Uniswap_V2"] || 0);
    const sushiP = Number(prices["SushiSwap_V2"] || 0);
    setText("tickerUniswap", uniP > 0 ? "$" + uniP.toFixed(2) : "--");
    setText("tickerSushiSwap", sushiP > 0 ? "$" + sushiP.toFixed(2) : "--");

    if (best.spread_usdt !== undefined) {
        const sign = best.spread_usdt >= 0 ? "+" : "";
        setText("tickerSpread", `${sign}$${best.spread_usdt.toFixed(2)} (${sign}${best.spread_pct.toFixed(2)}%)`);
    }
    if (data.gas_price_gwei !== undefined) {
        const gwei = Number(data.gas_price_gwei);
        const gweiStr = gwei < 0.1 ? gwei.toFixed(3) : gwei.toFixed(1);
        setText("tickerGasPrice", `${gweiStr} Gwei`);
    }

    // Synchronize Header Chain Select, Settings Select, and Network Cards strictly with currentSelectedChainId
    const chainSelect = document.getElementById("headerChainSelect");
    if (chainSelect && chainSelect.value != currentSelectedChainId) {
        chainSelect.value = currentSelectedChainId;
    }
    const cfgChain = document.getElementById("cfgChainId");
    if (cfgChain && cfgChain.value != currentSelectedChainId) {
        cfgChain.value = currentSelectedChainId;
    }
    if (typeof updateNetworkCardsVisual === "function") {
        updateNetworkCardsVisual(currentSelectedChainId);
    }
    const currentActiveChain = SUPPORTED_CHAINS[currentSelectedChainId] || SUPPORTED_CHAINS[8453];
    setText("stepPill4Name", currentActiveChain.short || currentActiveChain.name);
    setText("execModalSub", `Invoking ${currentActiveChain.name} Smart Router via Web3 RPC`);
    setText("networkSpeedLabel", `${currentActiveChain.short} Speed`);

    // 2. Mode & Auto-trade badges
    const modeSelect = document.getElementById("headerTradingModeSelect");
    if (modeSelect && settings.trading_mode) {
        modeSelect.value = settings.trading_mode;
        if (settings.trading_mode === "LIVE") {
            modeSelect.style.background = "#dc2626";
            modeSelect.style.boxShadow = "0 0 10px rgba(220, 38, 38, 0.5)";
        } else if (settings.trading_mode === "TESTNET") {
            modeSelect.style.background = "#d97706";
            modeSelect.style.boxShadow = "none";
        } else {
            modeSelect.style.background = "#0ea5e9";
            modeSelect.style.boxShadow = "none";
        }
    }
    const modeBadge = document.getElementById("headerTradingModeBadge");
    if (modeBadge) {
        modeBadge.innerText = `${settings.trading_mode} ${settings.trading_mode === "MOCK" ? "(SAFE)" : ""}`;
        modeBadge.className = "badge " + (settings.trading_mode === "LIVE" ? "badge-red" : "badge-green");
    }

    const isLiveModeActive = (settings.trading_mode === "LIVE");
    const dashLiveBanner = document.getElementById("dashLiveWarningBanner");
    if (dashLiveBanner) dashLiveBanner.style.display = isLiveModeActive ? "block" : "none";
    const arbLiveBanner = document.getElementById("arbLiveWarningBanner");
    if (arbLiveBanner) arbLiveBanner.style.display = isLiveModeActive ? "block" : "none";

    const autoToggle = document.getElementById("headerAutoTradeToggle");
    if (autoToggle) autoToggle.checked = Boolean(settings.auto_trade);

    if (settings.emergency_stop !== undefined) {
        updateEmergencyStopUI(Boolean(settings.emergency_stop));
    }

    // 3. KPI stats
    const isConnected = Boolean(metamaskAccount) || (Boolean(wallet.is_connected) && Boolean(wallet.wallet_address));
    const activeAddress = metamaskAccount || wallet.wallet_address || "";

    const ethPrice = Number(summary.eth_price_usdt || 3000);
    const dispEth = (wallet.eth !== undefined && Number(wallet.eth) > 0) ? Number(wallet.eth) : Number(clientWalletBalances.eth || 0);
    const dispWeth = (wallet.weth !== undefined && Number(wallet.weth) > 0) ? Number(wallet.weth) : Number(clientWalletBalances.weth || 0);
    const dispUsdt = (wallet.usdt !== undefined && Number(wallet.usdt) > 0) ? Number(wallet.usdt) : Number(clientWalletBalances.usdt || 0);
    const dispUsdc = (wallet.usdc !== undefined && Number(wallet.usdc) > 0) ? Number(wallet.usdc) : Number(clientWalletBalances.usdc || 0);

    const totalStable = dispUsdt + dispUsdc;
    const totalEthEq = (dispEth + dispWeth) * ethPrice;
    const computedBal = totalStable + totalEthEq;
    const totalBal = computedBal > 0 ? computedBal : Number(summary.balance || 0);

    const totalProf = Number(summary.total_profit || 0);
    const totalTrades = Number(summary.total_trades || 0);
    const isEmergency = Boolean(settings.emergency_stop);

    setText("kpiBalance", `$${totalBal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    setText("kpiProfit", `${totalProf >= 0 ? "+" : ""}$${totalProf.toFixed(4)}`);
    setText("kpiTrades", totalTrades);

    let engineStatusText = payload.execution_status || "SCANNING POOLS";
    let statusTitle = engineStatusText;
    let statusSubtitle = "Scanning Liquidity Pools";

    if (isEmergency) {
        statusTitle = "HALTED (EMERGENCY STOP)";
        statusSubtitle = "Kill switch active; execution blocked.";
    } else if (!isConnected && settings.trading_mode === "LIVE") {
        statusTitle = "DISCONNECTED";
        statusSubtitle = "Connect Web3 wallet for LIVE execution.";
    } else if (engineStatusText.includes("INSUFFICIENT BALANCE")) {
        statusTitle = "INSUFFICIENT BALANCE";
        statusSubtitle = engineStatusText.replace(/INSUFFICIENT BALANCE(\s*[-:]\s*|\s*)/i, "").trim() || "Wallet funds insufficient for trade notional or gas.";
    } else if (/^TRADE SKIPPED/i.test(engineStatusText)) {
        statusTitle = "TRADE SKIPPED";
        statusSubtitle = engineStatusText.replace(/^TRADE SKIPPED(\s*[-:]\s*|\s*)/i, "").trim();
    } else if (/^TRADE FAILED/i.test(engineStatusText)) {
        statusTitle = "TRADE FAILED";
        statusSubtitle = engineStatusText.replace(/^TRADE FAILED(\s*[-:]\s*|\s*)/i, "").trim();
    } else if (/^STANDBY/i.test(engineStatusText)) {
        statusTitle = "STANDBY";
        statusSubtitle = engineStatusText.replace(/^STANDBY(\s*[-:]\s*|\s*)/i, "").trim() || "Engine in standby mode";
    } else if (/^BLOCKED/i.test(engineStatusText)) {
        statusTitle = "BLOCKED";
        statusSubtitle = engineStatusText.replace(/^BLOCKED(\s*[-:]\s*|\s*)/i, "").trim() || "Execution blocked";
    } else if (/^READY/i.test(engineStatusText)) {
        statusTitle = "READY";
        statusSubtitle = engineStatusText.replace(/^READY(\s*[-:]\s*|\s*)/i, "").trim() || "Ready for execution";
    } else if (/^ACTIVE/i.test(engineStatusText)) {
        statusTitle = "ACTIVE";
        statusSubtitle = engineStatusText.replace(/^ACTIVE(\s*[-:]\s*|\s*)/i, "").trim() || "Scanning Liquidity Pools";
    } else if (engineStatusText.startsWith("ATOMIC TRADE FILLED")) {
        statusTitle = "ATOMIC TRADE SUCCESSFUL";
        statusSubtitle = "Atomic Arbitrage Executed On-Chain";
    }

    // Header Auto-Trade Badge - never show fake ACTIVE status if engine is in STANDBY/BLOCKED
    const autoBadge = document.getElementById("headerAutoTradeBadge");
    if (autoBadge) {
        if (isEmergency || statusTitle.includes("BLOCKED") || statusTitle.includes("HALTED")) {
            autoBadge.innerText = "BLOCKED";
            autoBadge.className = "badge badge-red";
        } else if (!settings.auto_trade) {
            autoBadge.innerText = "STANDBY";
            autoBadge.className = "badge badge-red";
        } else if (statusTitle.includes("STANDBY") || statusTitle.includes("DISCONNECTED")) {
            autoBadge.innerText = "STANDBY";
            autoBadge.className = "badge badge-yellow";
        } else {
            autoBadge.innerText = "ACTIVE";
            autoBadge.className = "badge badge-green";
        }
    }

    const kpiStatusEl = document.getElementById("kpiStatus");
    if (kpiStatusEl) {
        kpiStatusEl.innerText = statusTitle;
        if (statusTitle.includes("HALTED") || statusTitle.includes("FAILED") || statusTitle.includes("INSUFFICIENT BALANCE") || statusTitle.includes("BLOCKED")) {
            kpiStatusEl.className = "value text-loss";
        } else if (statusTitle.includes("SKIPPED") || statusTitle.includes("STANDBY") || statusTitle.includes("DISCONNECTED")) {
            kpiStatusEl.className = "value text-yellow";
        } else if (statusTitle.includes("SUCCESSFUL") || statusTitle.includes("FILLED")) {
            kpiStatusEl.className = "value text-profit";
        } else {
            kpiStatusEl.className = "value text-blue";
        }
    }
    const kpiStatusSubEl = document.getElementById("kpiStatusSub");
    if (kpiStatusSubEl) {
        kpiStatusSubEl.innerText = statusSubtitle;
        kpiStatusSubEl.title = statusSubtitle;
    }

    // Live Execution Diagnostics strip on Best Opportunity card
    const oppDiagBox = document.getElementById("oppExecutionDiag");
    const oppDiagBadge = document.getElementById("oppDiagBadge");
    const oppDiagReason = document.getElementById("oppDiagReason");
    if (oppDiagBox && oppDiagBadge && oppDiagReason) {
        oppDiagBox.style.display = "block";
        const lastReason = payload.last_skip_reason || (payload.last_execution_result && payload.last_execution_result.skip_reason) || "";
        if (statusTitle.includes("INSUFFICIENT BALANCE")) {
            oppDiagBadge.className = "badge badge-red";
            oppDiagBadge.innerText = "INSUFFICIENT BALANCE";
            oppDiagReason.innerText = lastReason || statusSubtitle;
            oppDiagReason.style.color = "var(--loss-color)";
        } else if (statusTitle.includes("SKIPPED")) {
            oppDiagBadge.className = "badge badge-yellow";
            oppDiagBadge.innerText = "TRADE SKIPPED";
            oppDiagReason.innerText = lastReason || statusSubtitle;
            oppDiagReason.style.color = "#f59e0b";
        } else if (statusTitle.includes("STANDBY")) {
            oppDiagBadge.className = "badge badge-yellow";
            oppDiagBadge.innerText = "STANDBY";
            oppDiagReason.innerText = statusSubtitle;
            oppDiagReason.style.color = "var(--text-secondary)";
        } else if (statusTitle.includes("SUCCESSFUL") || statusTitle.includes("FILLED")) {
            oppDiagBadge.className = "badge badge-green";
            oppDiagBadge.innerText = "ATOMIC TRADE SUCCESSFUL";
            oppDiagReason.innerText = "Atomic arbitrage successfully executed on-chain.";
            oppDiagReason.style.color = "var(--profit-color)";
        } else if (statusTitle.includes("FAILED")) {
            oppDiagBadge.className = "badge badge-red";
            oppDiagBadge.innerText = "FAILED";
            oppDiagReason.innerText = statusSubtitle;
            oppDiagReason.style.color = "var(--loss-color)";
        } else {
            oppDiagBadge.className = "badge badge-blue";
            oppDiagBadge.innerText = "ACTIVE";
            oppDiagReason.innerText = "Scanning decentralized liquidity pools for profitable spreads...";
            oppDiagReason.style.color = "var(--text-secondary)";
        }
    }

    // 4. Wallet balances
    const walletBadge = document.getElementById("walletAddressBadge");
    if (walletBadge) {
        if (isConnected && activeAddress) {
            const shortAddr = activeAddress.slice(0, 6) + "..." + activeAddress.slice(-4);
            const sourceLabel = (wallet.source === "on-chain-rpc" && wallet.wallet_address) ? "On-Chain" : "Web3";
            walletBadge.innerText = `${shortAddr} (${sourceLabel})`;
            walletBadge.className = "badge badge-green";
        } else {
            walletBadge.innerText = "Wallet Disconnected";
            walletBadge.className = "badge badge-yellow";
        }
    }
    const targetChainInfo = SUPPORTED_CHAINS[activeChainId] || SUPPORTED_CHAINS[8453];
    const nativeSym = targetChainInfo.currency || (targetChainInfo.nativeCurrency ? targetChainInfo.nativeCurrency.symbol : "ETH");
    const [baseSym, quoteSym] = (sym && sym.includes("/")) ? sym.split("/") : ["WETH", (activeChainId === 8453 ? "USDC" : "USDT")];

    setText("balETH", `${dispEth.toFixed(4)} ${nativeSym}`);
    setText("balETHusd", `≈ $${(dispEth * ethPrice).toFixed(2)} ${quoteSym}`);
    setText("balWETH", `${dispWeth.toFixed(4)} ${baseSym}`);
    setText("balWETHusd", `≈ $${(dispWeth * ethPrice).toFixed(2)} ${quoteSym}`);
    setText("balUSDT", `$${dispUsdt.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT`);
    setText("balUSDC", `$${dispUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`);
    setText("balETHBadge", nativeSym);

    // 5. Best Opportunity card & Multi-Hop Flow Diagram
    if (best.buy_dex) {
        setText("oppBuyDex", best.buy_dex.replace("_", " "));
        setText("oppBuyPrice", `$${best.buy_price.toFixed(2)}`);
        setText("oppSellDex", best.sell_dex.replace("_", " "));
        setText("oppSellPrice", `$${best.sell_price.toFixed(2)}`);
        const spreadSign = best.spread_usdt >= 0 ? "+" : "";
        setText("oppSpread", `${spreadSign}$${best.spread_usdt.toFixed(2)} (${spreadSign}${best.spread_pct.toFixed(2)}%)`);
        setText("oppImpact", `${Number(best.max_price_impact_pct || 0).toFixed(2)}%`);
        setText("oppGas", `$${Number(best.gas_cost_usdt || 0).toFixed(4)} ${quoteSym}`);
        
        const oppNetProfSign = (best.net_profit_usdt || 0) >= 0 ? "+" : "";
        setText("oppNetProfit", `${oppNetProfSign}$${Number(best.net_profit_usdt || 0).toFixed(4)} ${quoteSym} (${oppNetProfSign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`);
        const oppNetProfEl = document.getElementById("oppNetProfit");
        if (oppNetProfEl) {
            oppNetProfEl.style.color = (best.net_profit_usdt || 0) >= 0 ? "var(--profit-color)" : "var(--loss-color)";
        }

        // Multi-Hop Flow Nodes
        setText("flowInputToken", quoteSym);
        setText("flowOutputToken", quoteSym);
        setText("flowBridgeAsset", `${baseSym} BRIDGE`);
        setText("flowInputAmount", `$${Number(best.amount_in || selectedTradeAmount).toFixed(2)} ${quoteSym}`);
        setText("flowImpactSub", `Impact: ${Number(best.max_price_impact_pct || 0.01).toFixed(2)}%`);
        setText("flowOutputProfit", `${oppNetProfSign}$${Number(best.net_profit_usdt || 0).toFixed(4)} (${oppNetProfSign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`);

        const oppBadge = document.getElementById("oppBadge");
        if (oppBadge) {
            oppBadge.innerText = best.is_profitable ? "PROFITABLE" : "LOW PROFIT";
            oppBadge.className = "badge " + (best.is_profitable ? "badge-green" : "badge-yellow");
        }

        // Update Best Route dynamic chain badge and timestamp
        setText("bestRouteChainBadge", (targetChainInfo.short || targetChainInfo.name).toUpperCase());
        setText("bestRouteChainName", targetChainInfo.name);
        const bestRouteTimestamp = document.getElementById("bestRouteTimestamp");
        if (bestRouteTimestamp) {
            if (data.timestamp || payload.timestamp) {
                const d = new Date((data.timestamp || payload.timestamp) * 1000);
                bestRouteTimestamp.innerText = `Updated ${d.toLocaleTimeString()}`;
            }
        }

        // Web Audio chime for new profitable opportunities (throttled)
        const currentRouteKey = `${best.buy_dex}->${best.sell_dex}`;
        const nowMs = Date.now();
        if (best.is_profitable && (best.net_profit_percent || 0) > 0.25) {
            if (lastChimedRoute !== currentRouteKey || (nowMs - lastChimeTime > 45000)) {
                lastChimedRoute = currentRouteKey;
                lastChimeTime = nowMs;
                playTerminalSound("profitable");
            }
        }
    }

    // 6. Prices Tab pool cards & Liquidity Depth Ratio Gauge
    const uniRes = reserves["Uniswap_V2"] || {};
    const sushiRes = reserves["SushiSwap_V2"] || {};
    const activeChainInfo = SUPPORTED_CHAINS[activeChainId] || { short: "Base L2" };
    setText("uniChainLabel", `(${activeChainInfo.short})`);
    setText("sushiChainLabel", `(${activeChainInfo.short})`);

    setText("uniSpotPrice", uniP > 0 ? `$${uniP.toFixed(2)}` : "--");
    setText("uniResBase", `${Number(uniRes.base_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${baseSym}`);
    setText("uniResQuote", `$${Number(uniRes.quote_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${quoteSym}`);

    setText("sushiSpotPrice", sushiP > 0 ? `$${sushiP.toFixed(2)}` : "--");
    setText("sushiResBase", `${Number(sushiRes.base_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${baseSym}`);
    setText("sushiResQuote", `$${Number(sushiRes.quote_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${quoteSym}`);

    // Live Pool Depth Ratio Gauge
    const uniQuote = Number(uniRes.quote_reserve || 0);
    const sushiQuote = Number(sushiRes.quote_reserve || 0);
    const totalPoolDepth = uniQuote + sushiQuote;
    const uniPct = totalPoolDepth > 0 ? Math.round((uniQuote / totalPoolDepth) * 100) : 50;
    const sushiPct = 100 - uniPct;

    const depthBarUni = document.getElementById("depthBarUni");
    const depthBarSushi = document.getElementById("depthBarSushi");
    const depthRatioSummary = document.getElementById("depthRatioSummary");
    const depthLabelUni = document.getElementById("depthLabelUni");
    const depthLabelSushi = document.getElementById("depthLabelSushi");

    if (depthBarUni) depthBarUni.style.width = `${uniPct}%`;
    if (depthBarSushi) depthBarSushi.style.width = `${sushiPct}%`;
    if (depthRatioSummary) depthRatioSummary.innerText = `Uni ${uniPct}% / Sushi ${sushiPct}%`;
    if (depthLabelUni) depthLabelUni.innerText = `Uniswap V2: $${uniQuote.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${uniPct}%)`;
    if (depthLabelSushi) depthLabelSushi.innerText = `SushiSwap V2: $${sushiQuote.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${sushiPct}%)`;

    // 7. Arbitrage tab breakdown
    if (best.buy_dex) {
        setText("arbRouteText", `${best.buy_dex.replace("_", " ")} ➔ ${best.sell_dex.replace("_", " ")}`);
        setText("arbAmountIn", `$${Number(best.amount_in || selectedTradeAmount).toFixed(2)} ${quoteSym}`);
        setText("arbAmountOut", `$${Number(best.gross_return_usdt || best.amount_in || selectedTradeAmount).toFixed(4)} ${quoteSym}`);
        setText("arbPriceImpact", `${Number(best.max_price_impact_pct || 0.01).toFixed(2)}%`);
        setText("arbGasCost", `$${Number(best.gas_cost_usdt || 0.005).toFixed(4)} ${quoteSym}`);

        const netProfEl = document.getElementById("arbNetProfit");
        if (netProfEl) {
            const sign = (best.net_profit_usdt || 0) >= 0 ? "+" : "";
            netProfEl.innerText = `${sign}$${Number(best.net_profit_usdt || 0).toFixed(4)} ${quoteSym} (${sign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`;
            netProfEl.style.color = (best.net_profit_usdt || 0) >= 0 ? "var(--profit-color)" : "var(--loss-color)";
        }

        const planBadge = document.getElementById("arbPlanBadge");
        const btnExec = document.getElementById("btnExecuteArbitrage");
        const isProf = Boolean(best.is_profitable) && (best.net_profit_usdt || 0) > 0;
        const isLoss = (best.net_profit_usdt || 0) < 0;

        if (planBadge) {
            if (isProf) {
                planBadge.innerText = "OPTIMAL ROUTE";
                planBadge.className = "badge badge-green";
            } else if (isLoss) {
                const lossStr = Math.abs(best.net_profit_usdt || 0).toFixed(4);
                planBadge.innerText = `UNPROFITABLE (-$${lossStr})`;
                planBadge.className = "badge badge-red";
            } else {
                planBadge.innerText = "LOW SPREAD";
                planBadge.className = "badge badge-yellow";
            }
        }

        if (btnExec) {
            if (isLoss) {
                btnExec.style.opacity = "0.7";
                btnExec.style.background = "#64748b";
                btnExec.style.cursor = "not-allowed";
                btnExec.innerText = "⚠️ Unprofitable — Execution Blocked";
                btnExec.title = "Arbitrage only executes when Net Profit is strictly positive (> $0.00).";
            } else {
                btnExec.style.opacity = "1";
                btnExec.style.background = "";
                btnExec.style.cursor = "pointer";
                btnExec.innerText = "⚡ Execute Arbitrage";
                btnExec.title = "";
            }
        }
    }
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

// ============================================================
// SIMULATION & ATOMIC EXECUTION ACTIONS
// ============================================================

function updateExecutionPlanForAmount(amount) {
    if (!amount || amount <= 0) return;
    const activeChainId = currentSelectedChainId || 8453;
    const sym = latestMarketData?.symbol || (activeChainId === 8453 ? "WETH/USDC" : "WETH/USDT");
    const quoteSym = sym.includes("/") ? sym.split("/")[1] : "USDC";
    setText("arbAmountIn", `$${Number(amount).toFixed(2)} ${quoteSym}`);

    // Realistic dynamic gas for L2 / micro-trade ($0.0005 on $1, $0.0025 on $5)
    const gasCost = Math.min(0.25, Math.max(0.0001, amount * 0.0005));

    // Realistic constant-product DEX arbitrage calculation (~0.8% net spread after 0.3% x 2 DEX fees)
    let spreadPct = 1.41;
    if (latestMarketData && latestMarketData.best_route && latestMarketData.best_route.spread_pct) {
        spreadPct = latestMarketData.best_route.spread_pct;
    }
    const netSpreadRatio = Math.max(0.004, (spreadPct - 0.60) / 100.0);
    const grossReturn = amount * (1.0 + netSpreadRatio);
    const grossProfit = grossReturn - amount;
    const netProfit = grossProfit - gasCost;
    const netProfitPct = (netProfit / amount) * 100.0;

    setText("arbAmountOut", `$${grossReturn.toFixed(4)} ${quoteSym}`);
    setText("arbPriceImpact", `0.01%`);
    setText("arbGasCost", `$${gasCost.toFixed(4)} ${quoteSym}`);

    const netProfEl = document.getElementById("arbNetProfit");
    if (netProfEl) {
        const sign = netProfit >= 0 ? "+" : "";
        netProfEl.innerText = `${sign}$${netProfit.toFixed(4)} ${quoteSym} (${sign}${netProfitPct.toFixed(2)}%)`;
        netProfEl.style.color = netProfit >= 0 ? "var(--profit-color)" : "var(--loss-color)";
    }

    const planBadge = document.getElementById("arbPlanBadge");
    if (planBadge) {
        planBadge.innerText = netProfit > 0 ? "OPTIMAL ROUTE" : "UNPROFITABLE ROUTE";
        planBadge.className = "badge " + (netProfit > 0 ? "badge-green" : "badge-red");
    }
}

function selectTradeSize(amount) {
    selectedTradeAmount = amount;
    document.querySelectorAll(".size-btn").forEach(btn => {
        const btnVal = parseFloat(btn.innerText.replace("$", ""));
        btn.classList.toggle("active", Math.abs(btnVal - amount) < 0.0001);
    });
    document.querySelectorAll(".size-pct-pill, .btn-max-safe").forEach(btn => {
        btn.classList.remove("active");
    });
    const inp = document.getElementById("customTradeInput");
    if (inp) inp.value = amount;
    const dashLbl = document.getElementById("dashSizingLabel");
    if (dashLbl) dashLbl.innerText = `$${Number(amount).toFixed(2)} USDT`;
    updateExecutionPlanForAmount(amount);
    fetchMarketData();
}

function selectMaxSafeSize() {
    let available = 0;
    if (clientWalletBalances && (clientWalletBalances.usdt > 0 || clientWalletBalances.usdc > 0)) {
        available = clientWalletBalances.usdt + clientWalletBalances.usdc;
    } else if (latestMarketData && latestMarketData.wallet) {
        available = Number(latestMarketData.wallet.total_stable_usdt || 0);
    }
    if (available <= 0.0) {
        showToast("Wallet has $0.00 USDT/USDC. Deposit funds or connect MetaMask.", "warning");
        return;
    }
    const safeAmt = Math.floor(available * 0.95 * 10000) / 10000;
    selectedTradeAmount = Math.max(0.0001, safeAmt);
    document.querySelectorAll(".size-btn").forEach(btn => {
        btn.classList.toggle("active", btn.classList.contains("btn-max-safe"));
    });
    const inp = document.getElementById("customTradeInput");
    if (inp) inp.value = selectedTradeAmount.toFixed(4);
    const dashLbl = document.getElementById("dashSizingLabel");
    if (dashLbl) dashLbl.innerText = `$${selectedTradeAmount.toFixed(4)} USDT`;
    updateExecutionPlanForAmount(selectedTradeAmount);
    fetchMarketData();
    playTerminalSound("test");
    showToast(`Set trade size to max safe balance (95%): $${selectedTradeAmount.toFixed(4)} USDT`, "success");
}

function selectSizingPercentage(pct) {
    let available = 0;
    if (clientWalletBalances && (clientWalletBalances.usdt > 0 || clientWalletBalances.usdc > 0)) {
        available = clientWalletBalances.usdt + clientWalletBalances.usdc;
    } else if (latestMarketData && latestMarketData.wallet) {
        available = Number(latestMarketData.wallet.total_stable_usdt || 0);
    }
    if (available <= 0.0) {
        showToast("Wallet has $0.00 USDT/USDC. Deposit funds or connect MetaMask.", "warning");
        return;
    }
    const factor = Math.min(1.0, pct / 100.0);
    const amt = Math.floor(available * factor * 10000) / 10000;
    selectedTradeAmount = Math.max(0.0001, amt);

    document.querySelectorAll(".size-btn").forEach(btn => btn.classList.remove("active"));
    const activePill = document.getElementById(`pctBtn${pct}`);
    if (activePill) activePill.classList.add("active");

    const inp = document.getElementById("customTradeInput");
    if (inp) inp.value = selectedTradeAmount.toFixed(4);
    const dashLbl = document.getElementById("dashSizingLabel");
    if (dashLbl) dashLbl.innerText = `$${selectedTradeAmount.toFixed(4)} USDT (${pct}%)`;
    updateExecutionPlanForAmount(selectedTradeAmount);
    fetchMarketData();
    playTerminalSound("test");
    showToast(`Set trade size to ${pct}%: $${selectedTradeAmount.toFixed(4)} USDT`, "success");
}

let customAmountDebounceTimer = null;
function onCustomAmountChange() {
    const inp = document.getElementById("customTradeInput");
    if (inp) {
        const val = parseFloat(inp.value) || 0.10;
        selectedTradeAmount = Math.max(0.0001, val);
        document.querySelectorAll(".size-btn").forEach(btn => {
            const btnVal = parseFloat(btn.innerText.replace("$", ""));
            btn.classList.toggle("active", Math.abs(btnVal - val) < 0.0001);
        });
        updateExecutionPlanForAmount(selectedTradeAmount);
        if (customAmountDebounceTimer) clearTimeout(customAmountDebounceTimer);
        customAmountDebounceTimer = setTimeout(() => {
            fetchMarketData();
        }, 300);
    }
}

async function simulateCurrentTrade() {
    showExecModal("Simulating Atomic DEX Arbitrage", "Simulating on-chain transaction via Web3 RPC...");
    try {
        const res = await fetch("/api/trade/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trade_amount: selectedTradeAmount })
        });
        const json = await res.json();
        const body = document.getElementById("execModalBody");
        if (body) {
            body.innerHTML = `
                <div style="color:${json.success ? "var(--profit-color)" : "var(--loss-color)"}; font-weight:700; margin-bottom:10px;">
                    ${json.status}: ${json.message}
                </div>
                <div>Simulated Gas Units: ${json.simulated_gas_used || 250000}</div>
                <div>Gross Return: $${(json.gross_return || 0).toFixed(4)} USDT</div>
                <div>Expected Net Profit: $${(json.expected_net_profit || 0).toFixed(4)} USDT</div>
                <div style="margin-top:8px; color:var(--text-muted); font-size:11px;">
                    Verification status: Guaranteed atomic revert on-chain if return is below threshold.
                </div>
            `;
        }
    } catch (err) {
        showToast("Simulation error: " + err, "error");
    }
}

async function executeCurrentTrade() {
    const bestRoute = latestMarketData?.best_route || latestMarketData?.data?.best_route;
    if (!bestRoute) {
        showToast("Scanning DEX liquidity... Please wait for a route quote.", "warning");
        return;
    }

    // Safety Guard: Real Net Profit Check (Never execute a loss)
    const netProfitVal = Number(bestRoute.net_profit_usdt || 0);
    if (!bestRoute.is_profitable || netProfitVal <= 0) {
        const lossMsg = netProfitVal < 0 ? `-$${Math.abs(netProfitVal).toFixed(4)}` : "$0.00";
        showToast(`Execution blocked: Route is unprofitable (${lossMsg} Net PnL). Arbitrage only executes when Net Profit > 0.`, "error");
        renderExecutionResult({
            success: false,
            status: "BLOCKED_UNPROFITABLE",
            message: `Execution blocked to protect your capital. This route produces a net loss (${lossMsg}). DEX Arbitrage requires strictly positive profit (Net Profit > $0.00).`
        });
        return;
    }

    const currentMode = latestMarketData?.trading_mode || latestMarketData?.settings?.trading_mode || "MOCK";
    const isLiveOrTestnet = (currentMode === "LIVE" || currentMode === "TESTNET");
    const hasServerSigner = latestMarketData && Boolean(latestMarketData.has_private_key);

    // In LIVE or TESTNET mode without server private key, route to MetaMask non-custodial signing
    if (isLiveOrTestnet && !hasServerSigner) {
        showToast("Routing to MetaMask for secure non-custodial signing...", "info");
        await executeMetaMaskOnChainTrade();
        return;
    }

    // In LIVE mode with server private key, prompt explicit confirmation modal before broadcast
    if (isLiveMode && hasServerSigner) {
        const targetChainId = currentSelectedChainId || 8453;
        const targetChainInfo = SUPPORTED_CHAINS[targetChainId] || { name: `Chain ${targetChainId}`, short: "ETH" };
        const tradeAmt = selectedTradeAmount || 0.10;
        const ethPrice = Number(latestMarketData?.summary?.eth_price_usdt || 3000);
        const gasPriceGwei = Number(latestMarketData?.gas_price_gwei || 0.01);
        const estGasUnits = 250000;
        const estGasNative = (estGasUnits * gasPriceGwei * 1e-9);
        const estGasUsd = estGasNative * ethPrice;
        const nativeSym = targetChainInfo.short || "ETH";
        const gasStr = `~${estGasNative.toFixed(6)} ${nativeSym} (~$${estGasUsd < 0.01 ? '<0.01' : estGasUsd.toFixed(3)} USDT)`;
        const slippageVal = parseFloat(document.getElementById("cfgSlippage")?.value || "0.5");
        const priceImpactVal = parseFloat(latestMarketData?.best_route?.price_impact_pct || 0.05);

        try {
            await new Promise((resolve, reject) => {
                showLiveTradeConfirmModal({
                    networkName: `${targetChainInfo.name} (Chain ID ${targetChainId})`,
                    inputStr: `${tradeAmt.toFixed(4)} USDT`,
                    outputStr: `~${(tradeAmt / (ethPrice || 3000)).toFixed(6)} WETH`,
                    gasStr: gasStr,
                    slippageStr: `${slippageVal.toFixed(1)}%`,
                    priceImpactStr: `${priceImpactVal < 0.01 ? '< 0.01' : priceImpactVal.toFixed(2)}%`,
                    recipientStr: "Autonomous Server Wallet (Smart Router Contract)"
                }, () => resolve(), () => reject(new Error("LIVE_CONFIRMATION_CANCELLED")));
            });
        } catch (confirmErr) {
            showToast("Live trade execution cancelled.", "info");
            return;
        }
    }

    showExecModal("Executing Atomic DEX Arbitrage", "Submitting transaction to DEX Arbitrage Smart Contract...");
    try {
        let tradeAmtToSend = selectedTradeAmount;
        if (latestMarketData && latestMarketData.wallet) {
            const avail = Number(latestMarketData.wallet.total_stable_usdt || 0);
            if (avail > 0 && (!tradeAmtToSend || tradeAmtToSend > avail)) {
                tradeAmtToSend = Math.max(0.0001, Math.floor(avail * 0.95 * 10000) / 10000);
            }
        }
        const res = await fetch("/api/trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trade_amount: tradeAmtToSend,
                wallet_address: metamaskAccount
            })
        });
        const json = await res.json();

        // If server reports LIVE_SIGNER_REQUIRED, seamlessly forward to MetaMask
        if (json.status === "LIVE_SIGNER_REQUIRED") {
            showToast("Server has no private key. Forwarding to MetaMask for on-chain signature...", "info");
            await executeMetaMaskOnChainTrade();
            return;
        }

        renderExecutionResult(json);
        fetchMarketData();
        loadTrades();
        loadExecutionLogs();
    } catch (err) {
        showToast("Execution error: " + err, "error");
    }
}

function setModalStep(stepNumber, state = "active") {
    const stepper = document.getElementById("execModalStepper");
    if (stepper) stepper.style.display = "flex";
    for (let i = 1; i <= 5; i++) {
        const pill = document.getElementById(`stepPill${i}`);
        if (!pill) continue;
        if (i < stepNumber) {
            pill.className = "step-pill completed";
        } else if (i === stepNumber) {
            pill.className = `step-pill ${state}`;
        } else {
            pill.className = "step-pill";
        }
    }
}

function renderExecutionResult(json) {
    const body = document.getElementById("execModalBody");
    if (!body) return;
    const isSuccess = Boolean(json.success);
    const isInsufficient = (json.status === "INSUFFICIENT BALANCE") || 
                           (json.skip_reason && json.skip_reason.includes("INSUFFICIENT BALANCE")) || 
                           (json.message && json.message.includes("INSUFFICIENT BALANCE"));
    
    if (isSuccess) {
        playTerminalSound("trade_success");
        setModalStep(5, "completed");
    } else {
        playTerminalSound("alert");
        const currentActivePill = document.querySelector(".step-pill.active") || document.getElementById("stepPill1");
        if (currentActivePill) {
            currentActivePill.className = "step-pill failed";
        }
    }

    const isSkipped = json.status === "TRADE SKIPPED";
    const statusColor = isSuccess ? "var(--profit-color)" : (isInsufficient ? "var(--loss-color)" : (isSkipped ? "#f59e0b" : "var(--loss-color)"));
    const activeCid = (latestMarketData && latestMarketData.chain_id) ? Number(latestMarketData.chain_id) : currentSelectedChainId;
    const activeChainConfig = SUPPORTED_CHAINS[activeCid] || SUPPORTED_CHAINS[8453];
    const explorerBase = activeChainConfig.explorer ? `${activeChainConfig.explorer}/tx/` : "https://basescan.org/tx/";
    const chainShort = (activeChainConfig.short || activeChainConfig.name).toUpperCase();
    const explorerName = activeChainConfig.name.includes("Polygon") ? "PolygonScan" : (activeChainConfig.name.includes("Arbitrum") ? "Arbiscan" : (activeChainConfig.name.includes("Sepolia") && !activeChainConfig.name.includes("Base") ? "Etherscan (Sepolia)" : (activeChainConfig.name.includes("Base Sepolia") ? "BaseScan (Sepolia)" : (activeChainConfig.name.includes("Ethereum") ? "Etherscan" : "BaseScan"))));

    const titleText = isSuccess ? "Atomic Trade Verified On-Chain" : (isInsufficient ? "INSUFFICIENT BALANCE" : (json.status || "Trade Result"));

    let rawMsg = json.message || json.skip_reason || "";
    let cleanMsg = rawMsg
        .replace(/^INSUFFICIENT BALANCE:\s*/gi, "")
        .replace(/^SKIP:\s*/gi, "")
        .replace(/^Execution skipped:\s*/gi, "")
        .replace(/^INSUFFICIENT BALANCE:\s*/gi, "")
        .replace(/^SKIP:\s*/gi, "")
        .trim();

    body.innerHTML = `
        <div style="color:${statusColor}; font-weight:700; margin-bottom:10px; font-size:14px; display:flex; align-items:center; gap:6px;">
            <span>${isSuccess ? '✅' : (isInsufficient ? '⚠️' : '❌')}</span>
            <span>${titleText}</span>
        </div>
        <div style="margin-bottom:12px; font-size:13px; color:var(--text-bright); line-height:1.5;">
            ${cleanMsg || rawMsg}
        </div>
        ${json.skip_reason ? `
            <div style="background:${isInsufficient ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)"}; border:1px solid ${isInsufficient ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}; padding:8px 12px; border-radius:6px; margin-bottom:10px; font-size:12px; color:${isInsufficient ? "var(--loss-color)" : "#f59e0b"}; word-break:break-word;">
                <strong>${isInsufficient ? "Balance Guard:" : "Diagnostic / Skip Reason:"}</strong> ${cleanMsg}
            </div>
        ` : ""}
        ${json.tx_hash ? `
            <div style="background:rgba(15,23,42,0.8); border:1px solid rgba(56,189,248,0.25); border-radius:6px; padding:10px; margin-top:8px; font-size:11px;">
                <div style="color:var(--text-muted); margin-bottom:4px; font-weight:700;">${chainShort} TRANSACTION RECEIPT</div>
                <div style="word-break:break-all; font-family:var(--font-mono); margin-bottom:8px;">
                    <a href="${explorerBase}${json.tx_hash}" target="_blank" style="color:var(--accent-cyan); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                        <span>🔗</span> <span>${json.tx_hash}</span>
                    </a>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-secondary" style="padding:4px 8px; font-size:10px;" onclick="navigator.clipboard.writeText('${json.tx_hash}'); showToast('Tx Hash copied to clipboard!', 'success');">📋 Copy Hash</button>
                    <a href="${explorerBase}${json.tx_hash}" target="_blank" class="btn btn-secondary" style="padding:4px 8px; font-size:10px; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">🔍 View on ${explorerName}</a>
                </div>
            </div>
        ` : ""}
        ${json.trade ? `
            <div style="margin-top:10px; padding:8px 12px; background:rgba(30,41,59,0.5); border-radius:6px; border:1px solid rgba(148,163,184,0.15); font-size:12px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span style="color:var(--text-muted);">Route</span>
                    <span style="font-weight:700; color:var(--text-bright);">${json.trade.buy_dex} ➔ ${json.trade.sell_dex}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                    <span style="color:var(--text-muted);">Trade Notional</span>
                    <span style="font-family:var(--font-mono); font-weight:600;">$${Number(json.trade.amount_in).toFixed(2)}</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:var(--text-muted);">Verified Net PnL</span>
                    <span style="font-family:var(--font-mono); font-weight:700; color:var(--profit-color);">+$${Number(json.trade.net_profit || 0).toFixed(4)} USDT</span>
                </div>
                ${json.trade.created_at ? `
                <div style="display:flex; justify-content:space-between; margin-top:3px;">
                    <span style="color:var(--text-muted);">Time</span>
                    <span style="font-family:var(--font-mono); font-size:11px;">${formatLogTime(json.trade.created_at)}</span>
                </div>
                ` : ""}
            </div>
        ` : ""}
        ${isInsufficient ? `
            <div style="margin-top:14px; text-align:center;">
                <button class="btn btn-primary" style="width:100%; padding:10px; font-weight:700; justify-content:center; background:linear-gradient(135deg, #00f2fe 0%, #4facfe 100%); color:#000; font-size:13px;" onclick="switchToMockAndExecute()">
                    ⚡ Switch to MOCK Mode & Execute Trade Now
                </button>
                <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">Executes risk-free trade simulation with real DEX pool math & zero real funds required.</div>
            </div>
        ` : ""}
    `;
}

async function switchToMockAndExecute() {
    closeExecModal();
    showToast("Switching to MOCK simulation mode...", "info");
    try {
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trading_mode: "MOCK" })
        });
        if (latestMarketData) latestMarketData.trading_mode = "MOCK";
        showToast("Switched to MOCK mode! Executing trade now...", "success");
        setTimeout(() => executeCurrentTrade(), 400);
    } catch (e) {
        showToast("Error switching mode: " + e, "error");
    }
}

function showExecModal(title, msg, stepNumber = 0) {
    const modal = document.getElementById("execModalOverlay");
    setText("execModalTitle", title);

    const activeChainId = currentSelectedChainId || 8453;
    const chainInfo = SUPPORTED_CHAINS[activeChainId] || SUPPORTED_CHAINS[8453];
    const chainShort = chainInfo.short || chainInfo.name;

    setText("execModalSub", `Invoking ${chainInfo.name} Smart Router via Web3 RPC`);
    setText("stepPill4Name", chainShort);

    const body = document.getElementById("execModalBody");
    if (body) {
        body.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span class="pulse-dot"></span>
                <span style="color:var(--accent-cyan); font-weight:700;">${title}</span>
            </div>
            <div style="color:var(--text-bright); line-height:1.5;">${msg}</div>
        `;
    }
    if (stepNumber > 0) {
        setModalStep(stepNumber, "active");
    }
    if (modal) modal.style.display = "flex";
}

function closeExecModal() {
    const modal = document.getElementById("execModalOverlay");
    if (modal) modal.style.display = "none";
}

// ============================================================
// EXPLICIT LIVE-MODE WARNING & PRE-EXECUTION CONFIRMATION
// ============================================================

let pendingLiveConfirmResolve = null;
let pendingLiveConfirmReject = null;

function showLiveTradeConfirmModal(params, onProceed, onCancel) {
    pendingLiveConfirmResolve = onProceed;
    pendingLiveConfirmReject = onCancel;

    setText("liveConfirmNetwork", params.networkName || "--");
    setText("liveConfirmInput", params.inputStr || "--");
    setText("liveConfirmOutput", params.outputStr || "--");
    setText("liveConfirmGas", params.gasStr || "--");
    setText("liveConfirmSlippage", params.slippageStr || "0.5%");
    setText("liveConfirmImpact", params.priceImpactStr || "< 0.10%");
    setText("liveConfirmRecipient", params.recipientStr || "--");

    const chk = document.getElementById("liveConfirmCheckbox");
    if (chk) chk.checked = false;

    const btn = document.getElementById("btnLiveConfirmSubmit");
    if (btn) {
        btn.style.opacity = "0.5";
        btn.style.pointerEvents = "none";
    }

    const overlay = document.getElementById("liveTradeConfirmModalOverlay");
    if (overlay) overlay.style.display = "flex";
}

function closeLiveConfirmModal() {
    const overlay = document.getElementById("liveTradeConfirmModalOverlay");
    if (overlay) overlay.style.display = "none";
    if (typeof pendingLiveConfirmReject === "function") {
        const rejectFn = pendingLiveConfirmReject;
        pendingLiveConfirmReject = null;
        pendingLiveConfirmResolve = null;
        rejectFn();
    }
}

function onLiveCheckboxToggle(checkbox) {
    const btn = document.getElementById("btnLiveConfirmSubmit");
    if (!btn) return;
    if (checkbox && checkbox.checked) {
        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
    } else {
        btn.style.opacity = "0.5";
        btn.style.pointerEvents = "none";
    }
}

function onLiveConfirmProceed() {
    const overlay = document.getElementById("liveTradeConfirmModalOverlay");
    if (overlay) overlay.style.display = "none";
    if (typeof pendingLiveConfirmResolve === "function") {
        const resolveFn = pendingLiveConfirmResolve;
        pendingLiveConfirmResolve = null;
        pendingLiveConfirmReject = null;
        resolveFn();
    }
}

// ============================================================
// AUTO TRADE & EMERGENCY STOP
// ============================================================

async function quickToggleAutoTrade(enabled) {
    try {
        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auto_trade: enabled })
        });
        const json = await res.json();
        if (json.success) {
            showToast(`Auto Trade ${enabled ? "Activated" : "Deactivated"}`, enabled ? "success" : "info");
        }
    } catch (err) {
        showToast("Error updating Auto Trade: " + err, "error");
    }
}

async function triggerEmergencyStop() {
    try {
        const res = await fetch("/api/emergency-stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        const contentType = res.headers.get("content-type") || "";
        let json;
        if (contentType.includes("application/json")) {
            json = await res.json();
        } else {
            const rawText = await res.text();
            throw new Error(rawText.slice(0, 100));
        }
        updateEmergencyStopUI(Boolean(json.emergency_stop));
        showToast(json.message, json.emergency_stop ? "error" : "success");
        fetchMarketData();
    } catch (err) {
        showToast("Error toggling emergency stop: " + (err.message || err), "error");
    }
}

async function quickSwitchMode(newMode) {
    try {
        const isLiveOrTestnet = (newMode === "LIVE" || newMode === "TESTNET");
        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trading_mode: newMode,
                live_trading_armed: isLiveOrTestnet
            })
        });
        const json = await res.json();
        if (json.success) {
            const isLive = (newMode === "LIVE");
            const isTestnet = (newMode === "TESTNET");
            const dashLiveBanner = document.getElementById("dashLiveWarningBanner");
            if (dashLiveBanner) dashLiveBanner.style.display = isLive ? "block" : "none";
            const arbLiveBanner = document.getElementById("arbLiveWarningBanner");
            if (arbLiveBanner) arbLiveBanner.style.display = isLive ? "block" : "none";

            // If switching to TESTNET and currently on a Mainnet chain, align chain to Sepolia
            if (isTestnet) {
                const currentChain = SUPPORTED_CHAINS[currentSelectedChainId];
                if (!currentChain || !currentChain.isTestnet) {
                    await selectNetwork(11155111);
                }
            } else if (isLive) {
                const currentChain = SUPPORTED_CHAINS[currentSelectedChainId];
                if (currentChain && currentChain.isTestnet) {
                    await selectNetwork(8453);
                }
            }

            showToast(`Trading Mode switched to ${newMode}`, isLive ? "warning" : "info");
            fetchMarketData();
            if (typeof loadSettings === "function") loadSettings();
        } else {
            showToast(json.message || "Failed to switch mode", "error");
        }
    } catch (err) {
        showToast("Error switching mode: " + (err.message || err), "error");
    }
}

function updateEmergencyStopUI(isActive) {
    const btn = document.getElementById("headerEmergencyStopBtn");
    const icon = document.getElementById("emergencyStopIcon");
    const txt = document.getElementById("emergencyStopText");
    if (!btn) return;

    if (isActive) {
        btn.style.background = "#ef4444";
        btn.style.color = "#ffffff";
        btn.style.borderColor = "#dc2626";
        btn.style.boxShadow = "0 0 12px rgba(239, 68, 68, 0.6)";
        if (icon) icon.innerText = "🛑";
        if (txt) txt.innerText = "STOP ACTIVE (Click to Resume)";
    } else {
        btn.style.background = "rgba(30, 41, 59, 0.7)";
        btn.style.color = "var(--text-secondary)";
        btn.style.borderColor = "var(--border)";
        btn.style.boxShadow = "none";
        if (icon) icon.innerText = "🛡️";
        if (txt) txt.innerText = "Kill Switch (Normal)";
    }
}

// ============================================================
// SETTINGS
// ============================================================

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        const json = await res.json();
        if (!json.success || !json.settings) return;
        const s = json.settings;

        setValue("cfgChainId", s.chain_id);
        setValue("headerChainSelect", s.chain_id);
        setValue("cfgTradingMode", s.trading_mode);
        setValue("cfgRpcUrl", s.rpc_url);
        setValue("cfgWalletAddress", s.wallet_address);
        setValue("cfgContractAddress", s.contract_address);
        setValue("cfgTradeAmount", s.trade_amount);
        setValue("cfgMinProfit", s.min_profit);
        setValue("cfgSlippage", s.slippage_pct);
        setValue("cfgPriceImpact", s.max_price_impact_pct);
        setValue("cfgGasCeiling", s.max_gas_price_gwei);

        const pkInput = document.getElementById("cfgPrivateKey");
        const pkStatus = document.getElementById("cfgPrivateKeyStatus");
        if (s.has_private_key) {
            if (pkInput) pkInput.placeholder = "•••••••••••••••• (Active on Server)";
            if (pkStatus) {
                pkStatus.textContent = "✓ Server private key is active. Autonomous background trading is enabled.";
                pkStatus.style.color = "var(--profit-color)";
            }
        } else {
            if (pkInput) pkInput.placeholder = "0x... (Optional: Only if running autonomous background bot on server)";
            if (pkStatus) {
                pkStatus.textContent = "If left blank, trades execute non-custodially via your connected MetaMask wallet.";
                pkStatus.style.color = "var(--text-muted)";
            }
        }
    } catch (err) {
        console.warn("Settings load error:", err);
    }
}

function setValue(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
}

async function saveSettings(event) {
    if (event) event.preventDefault();
    const payload = {
        chain_id: parseInt(document.getElementById("cfgChainId")?.value || "8453", 10),
        trading_mode: document.getElementById("cfgTradingMode").value,
        live_trading_armed: (document.getElementById("cfgTradingMode")?.value === "LIVE" || document.getElementById("cfgTradingMode")?.value === "TESTNET"),
        rpc_url: document.getElementById("cfgRpcUrl").value,
        wallet_address: document.getElementById("cfgWalletAddress").value,
        contract_address: document.getElementById("cfgContractAddress").value,
        trade_amount: parseFloat(document.getElementById("cfgTradeAmount").value),
        min_profit: parseFloat(document.getElementById("cfgMinProfit").value),
        slippage_pct: parseFloat(document.getElementById("cfgSlippage").value),
        max_price_impact_pct: parseFloat(document.getElementById("cfgPriceImpact").value),
        max_gas_price_gwei: parseFloat(document.getElementById("cfgGasCeiling").value),
    };

    const pkVal = document.getElementById("cfgPrivateKey")?.value;
    if (pkVal !== undefined && pkVal.trim() !== "") {
        payload.private_key = pkVal.trim();
    }

    try {
        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            showToast("DEX settings saved successfully!", "success");
            fetchMarketData();
            if (typeof loadSettings === "function") loadSettings();
        } else {
            showToast("Error: " + json.message, "error");
        }
    } catch (err) {
        showToast("Settings save error: " + err, "error");
    }
}

async function testRpcEndpoint() {
    const msg = document.getElementById("rpcTestMsg");
    if (msg) {
        msg.style.color = "var(--text-muted)";
        msg.innerText = "Connecting to blockchain RPC...";
    }
    try {
        const res = await fetch("/api/rpc-status");
        const json = await res.json();
        if (json.success && json.connected) {
            if (msg) {
                msg.style.color = "var(--profit-color)";
                msg.innerText = `✓ Connected! Block Height: #${json.block_number.toLocaleString()} | Gas: ${json.gas_price_gwei} Gwei`;
            }
        } else {
            if (msg) {
                msg.style.color = "var(--loss-color)";
                msg.innerText = "✗ RPC Connection failed. Check endpoint URL.";
            }
        }
    } catch (err) {
        if (msg) {
            msg.style.color = "var(--loss-color)";
            msg.innerText = "✗ Error: " + err;
        }
    }
}

// ============================================================
// TRADES AUDIT LOG
// ============================================================

let currentTradeFilter = "LIVE";

function setTradeFilter(mode) {
    currentTradeFilter = mode;
    const btnLive = document.getElementById("filterBtnLive");
    const btnSim = document.getElementById("filterBtnSim");
    const btnAll = document.getElementById("filterBtnAll");

    if (btnLive) {
        btnLive.style.background = mode === "LIVE" ? "#dc2626" : "transparent";
        btnLive.style.color = mode === "LIVE" ? "#fff" : "#94a3b8";
    }
    if (btnSim) {
        btnSim.style.background = mode === "SIMULATION" ? "#8b5cf6" : "transparent";
        btnSim.style.color = mode === "SIMULATION" ? "#fff" : "#94a3b8";
    }
    if (btnAll) {
        btnAll.style.background = mode === "ALL" ? "#3b82f6" : "transparent";
        btnAll.style.color = mode === "ALL" ? "#fff" : "#94a3b8";
    }
    loadTrades();
}

// ============================================================
// TIMEZONE & TIMESTAMP CONVERSION UTILITIES
// Displays all blockchain & audit timestamps in user local timezone (IST UTC+5:30 for India)
// ============================================================

function getUserTimezoneInfo() {
    try {
        const d = new Date();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
        const offsetMinutes = -d.getTimezoneOffset(); // e.g. +330 for IST
        const isIndia = offsetMinutes === 330 ||
            timeZone.toLowerCase().includes("kolkata") ||
            timeZone.toLowerCase().includes("calcutta") ||
            timeZone.toLowerCase().includes("india");

        const sign = offsetMinutes >= 0 ? "+" : "-";
        const absMinutes = Math.abs(offsetMinutes);
        const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
        const minutes = String(absMinutes % 60).padStart(2, "0");
        const offsetStr = `UTC${sign}${hours}:${minutes}`;

        let label = "IST";
        if (isIndia) {
            label = "IST";
        } else {
            try {
                const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d);
                const tzPart = parts.find(p => p.type === "timeZoneName");
                label = (tzPart && !tzPart.value.includes("GMT") && !tzPart.value.includes("UTC")) ? tzPart.value : offsetStr;
            } catch (e) {
                label = offsetStr;
            }
        }

        return {
            timeZone,
            offsetMinutes,
            offsetStr,
            label,
            isIndia
        };
    } catch (e) {
        return {
            timeZone: "Asia/Kolkata",
            offsetMinutes: 330,
            offsetStr: "UTC+05:30",
            label: "IST",
            isIndia: true
        };
    }
}

function parseUtcOrLocalTimestamp(timeVal) {
    if (!timeVal) return null;

    // 1. Numeric epoch (seconds or milliseconds)
    if (typeof timeVal === "number" || (/^\d+$/.test(String(timeVal).trim()) && !isNaN(Number(timeVal)))) {
        const num = Number(timeVal);
        const ms = num < 1e11 ? num * 1000 : num;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }

    let str = String(timeVal).trim();
    if (!str) return null;

    // 2. Explicit timezone offset present (e.g. "+05:30", "-04:00", "+00:00", or ends with "Z")
    if (str.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(str)) {
        const iso = str.includes("T") ? str : str.replace(" ", "T");
        const d = new Date(iso);
        if (!isNaN(d.getTime())) return d;
    }

    // 3. Trailing " UTC" or " GMT" indicator
    if (/\s+(UTC|GMT)$/i.test(str)) {
        const cleaned = str.replace(/\s+(UTC|GMT)$/i, "").replace(" ", "T") + "Z";
        const d = new Date(cleaned);
        if (!isNaN(d.getTime())) return d;
    }

    // 4. Standard on-chain / database timestamp ("YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss")
    // Blockchain receipts and SQLite timestamps are stored in UTC.
    // Parse as UTC by appending "Z":
    const isoUtc = (str.includes("T") ? str : str.replace(" ", "T")) + "Z";
    const dUtc = new Date(isoUtc);
    if (!isNaN(dUtc.getTime())) return dUtc;

    // 5. Fallback native Date parse
    const dFallback = new Date(str);
    return isNaN(dFallback.getTime()) ? null : dFallback;
}

function formatLogTime(timeVal, options = {}) {
    if (!timeVal) return "--";
    try {
        const d = parseUtcOrLocalTimestamp(timeVal);
        if (!d || isNaN(d.getTime())) return String(timeVal).slice(0, 19);

        const tz = getUserTimezoneInfo();
        const targetTz = options.timeZone || tz.timeZone || "Asia/Kolkata";

        // Format in user's local timezone (IST / UTC+5:30 in India)
        const formatter = new Intl.DateTimeFormat("en-GB", {
            timeZone: targetTz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        });

        const parts = formatter.formatToParts(d);
        const map = {};
        for (const p of parts) {
            map[p.type] = p.value;
        }

        const dateStr = `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;

        if (options.plainText) {
            return `${dateStr} ${tz.label}`;
        }

        const origStr = String(timeVal).slice(0, 30);
        return `<span title="Local Time (${tz.timeZone} ${tz.offsetStr}) | Stored on-chain: ${origStr}" style="white-space:nowrap;">${dateStr} <span style="font-size:9px; color:#38bdf8; background:rgba(56,189,248,0.12); border:1px solid rgba(56,189,248,0.25); padding:1px 4px; border-radius:3px; font-weight:700; vertical-align:middle; letter-spacing:0.5px;">${tz.label}</span></span>`;
    } catch (e) {
        return String(timeVal).slice(0, 19);
    }
}

async function loadTrades() {
    const tbody = document.getElementById("tradesTableBody");
    if (!tbody) return;

    try {
        const filterParam = currentTradeFilter ? `?mode=${currentTradeFilter}` : "";
        const res = await fetch(`/api/trades${filterParam}`);
        const json = await res.json();
        const trades = json.trades || [];

        if (trades.length === 0) {
            const emptyMsg = currentTradeFilter === "LIVE"
                ? "No confirmed live on-chain trades yet. Connect funded wallet to begin live execution."
                : (currentTradeFilter === "SIMULATION"
                    ? "No simulation trades recorded. Click '🔬 Simulate' to test execution."
                    : "No trade history recorded yet.");
            tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:30px;">${emptyMsg}</td></tr>`;
            return;
        }

        tbody.innerHTML = trades.map(t => {
            const shortHash = (t.tx_hash || "").slice(0, 10) + "...";
            const isLive = t.mode === "LIVE";
            const isTestnet = t.mode === "TESTNET";
            const explorerBase = (SUPPORTED_CHAINS[t.chain_id]?.explorer || "https://etherscan.io");
            const hashLink = (isLive || isTestnet)
                ? `<a href="${explorerBase}/tx/${t.tx_hash}" target="_blank" style="color:var(--action-color); text-decoration:underline;">${shortHash}</a>`
                : `<span style="color:#a78bfa; font-family:var(--font-mono);">${shortHash}</span>`;
            const badgeClass = isLive ? "badge-red" : (isTestnet ? "badge-yellow" : "badge-blue");
            const modeLabel = isLive ? "LIVE" : (isTestnet ? "TESTNET" : (t.mode || "SIMULATION"));
            const netProf = Number(t.net_profit || 0);
            const profSign = netProf >= 0 ? "+" : "";

            return `
                <tr>
                    <td style="font-family:var(--font-mono); font-size:11px;">${hashLink}</td>
                    <td><span class="badge ${badgeClass}">${modeLabel}</span></td>
                    <td style="font-weight:600;">${(t.buy_dex || "").replace("_", " ")} ➔ ${(t.sell_dex || "").replace("_", " ")}</td>
                    <td>${t.token_pair || "WETH/USDT"}</td>
                    <td style="font-family:var(--font-mono);">$${Number(t.amount_in || 0).toFixed(2)}</td>
                    <td style="font-family:var(--font-mono); color:var(--profit-color);">+${Number(t.gross_profit || 0).toFixed(4)}</td>
                    <td style="font-family:var(--font-mono); color:var(--text-muted);">$${Number(t.gas_cost_usdt || 0).toFixed(4)}</td>
                    <td style="font-family:var(--font-mono); font-weight:700; color:${netProf >= 0 ? "var(--profit-color)" : "var(--loss-color)"};">${profSign}$${netProf.toFixed(4)}</td>
                    <td><span class="badge ${t.status === "CONFIRMED" ? "badge-green" : "badge-yellow"}">${t.status}</span></td>
                    <td style="font-size:11px; color:var(--text-muted);">${formatLogTime(t.created_at)}</td>
                </tr>
            `;
        }).join("");

        loadExecutionLogs();
    } catch (err) {
        console.warn("Trades load error:", err);
    }
}

async function loadExecutionLogs() {
    const tbody = document.getElementById("execLogsTableBody");
    if (!tbody) return;

    try {
        const res = await fetch("/api/execution-logs");
        const json = await res.json();
        const logs = json.logs || [];

        if (logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">No execution events logged yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(l => {
            const isFilled = l.status === "FILLED";
            const isSkipped = l.status === "SKIPPED";
            const badgeClass = isFilled ? "badge-green" : (isSkipped ? "badge-yellow" : "badge-red");
            const netProf = Number(l.net_profit || 0);
            const profSign = netProf >= 0 ? "+" : "";

            return `
                <tr>
                    <td style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">${formatLogTime(l.timestamp || l.created_at)}</td>
                    <td><span class="badge ${badgeClass}">${l.event_type}</span></td>
                    <td style="font-weight:600;">${l.route || "-"}</td>
                    <td style="font-family:var(--font-mono);">$${Number(l.amount_in || 0).toFixed(2)}</td>
                    <td style="font-family:var(--font-mono); font-weight:700; color:${netProf >= 0 ? "var(--profit-color)" : "var(--loss-color)"};">${profSign}$${netProf.toFixed(4)}</td>
                    <td><span class="badge ${badgeClass}">${l.status}</span></td>
                    <td style="font-family:var(--font-mono); font-size:11px; color:${isSkipped ? "#f59e0b" : "var(--text-secondary)"}; word-break:break-word;">${l.reason || "-"}</td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.warn("Execution logs load error:", err);
    }
}

async function clearTradeHistory() {
    if (!confirm("Are you sure you want to clear all DEX trade history?")) return;
    try {
        await fetch("/api/trades/clear", { method: "POST" });
        showToast("Trade history cleared.", "info");
        loadTrades();
    } catch (err) {
        showToast("Clear error: " + err, "error");
    }
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const icons = {
        success: "✅",
        error: "❌",
        warning: "⚠️",
        info: "ℹ️",
        metamask: "🦊"
    };
    const icon = icons[type] || "ℹ️";
    const borderColor = type === "error" ? "var(--loss-color, #ef4444)" : (type === "success" ? "var(--profit-color, #22c55e)" : (type === "warning" ? "#f59e0b" : "var(--action-color, #3b82f6)"));

    const toast = document.createElement("div");
    toast.style.cssText = `
        background: #0f172a;
        border-left: 4px solid ${borderColor};
        border-top: 1px solid #334155;
        border-right: 1px solid #334155;
        border-bottom: 1px solid #334155;
        color: #f8fafc;
        padding: 12px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.6);
        pointer-events: auto;
        opacity: 0;
        transform: translateY(-10px);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 999999;
    `;
    toast.innerHTML = `<span style="font-size:16px;">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    }, 20);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ============================================================
// METAMASK WEB3 WALLET INTEGRATION (EIP-1193 & ETHERS.JS)
// ============================================================

let metamaskAccount = null;
let metamaskChainId = null;
let metamaskProvider = null;
let metamaskSigner = null;
let dexContractAddress = "";
let dexContractABI = null;
let dexArbitrageContract = null;

function updateNetworkCardsVisual(activeChainId) {
    const chainIdNum = Number(activeChainId);

    const chainMap = [
        { id: 8453, cardId: "netCardBase", badgeId: "badgeNetBase", setCardId: "settingsNetCardBase", setBadgeId: "settingsBadgeNetBase", menuCardId: "menuNetCardBase", menuBadgeId: "menuBadgeBase" },
        { id: 84532, cardId: "netCardBaseSepolia", badgeId: "badgeNetBaseSepolia", setCardId: "settingsNetCardBaseSepolia", setBadgeId: "settingsBadgeNetBaseSepolia", menuCardId: "menuNetCardBaseSepolia", menuBadgeId: "menuBadgeBaseSepolia" },
        { id: 137, cardId: "netCardPolygon", badgeId: "badgeNetPolygon", setCardId: "settingsNetCardPolygon", setBadgeId: "settingsBadgeNetPolygon", menuCardId: "menuNetCardPolygon", menuBadgeId: "menuBadgePolygon" },
        { id: 42161, cardId: "netCardArbitrum", badgeId: "badgeNetArbitrum", setCardId: "settingsNetCardArbitrum", setBadgeId: "settingsBadgeNetArbitrum", menuCardId: "menuNetCardArbitrum", menuBadgeId: "menuBadgeArbitrum" },
        { id: 1, cardId: "netCardEthereum", badgeId: "badgeNetEthereum", setCardId: "settingsNetCardEthereum", setBadgeId: "settingsBadgeNetEthereum", menuCardId: "menuNetCardEthereum", menuBadgeId: "menuBadgeEthereum" },
        { id: 11155111, cardId: "netCardSepolia", badgeId: "badgeNetSepolia", setCardId: "settingsNetCardSepolia", setBadgeId: "settingsBadgeNetSepolia", menuCardId: "menuNetCardSepolia", menuBadgeId: "menuBadgeSepolia" }
    ];

    chainMap.forEach(chain => {
        const isActive = (chainIdNum === chain.id);

        // 1. Dashboard Cards
        const card = document.getElementById(chain.cardId);
        const badge = document.getElementById(chain.badgeId);
        if (card) {
            card.classList.toggle("active", isActive);
            if (badge) {
                badge.innerText = isActive ? "ACTIVE" : "SELECT";
                badge.className = "net-status-badge" + (isActive ? " badge-active" : "");
            }
        }

        // 2. Settings Tab Cards
        const setCard = document.getElementById(chain.setCardId);
        const setBadge = document.getElementById(chain.setBadgeId);
        if (setCard) {
            setCard.classList.toggle("active", isActive);
            if (setBadge) {
                setBadge.innerText = isActive ? "ACTIVE" : "SELECT";
                setBadge.className = "net-status-badge" + (isActive ? " badge-active" : "");
            }
        }

        // 3. Dropdown Quick Switch Cards
        const menuCard = document.getElementById(chain.menuCardId);
        const menuBadge = document.getElementById(chain.menuBadgeId);
        if (menuCard) {
            menuCard.classList.toggle("active", isActive);
            if (menuBadge) {
                menuBadge.innerText = isActive ? "ACTIVE" : "SWITCH";
            }
        }
    });

    // 4. Synchronize Header & Settings Select Dropdowns
    const chainSelect = document.getElementById("headerChainSelect");
    if (chainSelect && chainSelect.value != activeChainId) chainSelect.value = activeChainId;
    const cfgChain = document.getElementById("cfgChainId");
    if (cfgChain && cfgChain.value != activeChainId) cfgChain.value = activeChainId;

    // 5. Update global UI labels
    const activeInfo = SUPPORTED_CHAINS[chainIdNum] || { name: `Chain ${chainIdNum}`, short: `ID ${chainIdNum}` };
    const shortUpper = (activeInfo.short || activeInfo.name).toUpperCase();
    setText("globalNetworkText", `NETWORK: ${shortUpper}`);
    setText("heatmapChainLabel", `(${activeInfo.short || activeInfo.name})`);
    setText("bestRouteChainBadge", shortUpper);
    setText("bestRouteChainName", activeInfo.name);
    setText("uniChainLabel", `(${activeInfo.short || activeInfo.name})`);
    setText("sushiChainLabel", `(${activeInfo.short || activeInfo.name})`);
    setText("networkSpeedLabel", `${activeInfo.short} Speed`);
}

async function selectNetwork(chainId, event) {
    if (event) {
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        if (typeof event.preventDefault === "function") event.preventDefault();
    }
    const id = Number(chainId);
    if (!SUPPORTED_CHAINS[id]) return;

    // 1. Immediately invalidate and clear stale data from previous chain
    invalidateAndResetChainUI(id);
    const thisEpoch = currentChainEpoch;

    // 2. If MetaMask is connected, check & prompt network alignment
    if (metamaskAccount) {
        try {
            const currentMmCid = metamaskChainId ? parseInt(metamaskChainId, 16) : null;
            if (currentMmCid !== id) {
                await requestSwitchNetwork(id);
            }
        } catch (switchErr) {
            console.warn("[MetaMask switch warning]:", switchErr);
        }
    }

    // 3. Update backend active blockchain configuration
    try {
        const res = await fetch("/api/chain/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chain_id: id })
        });
        const json = await res.json();
        if (thisEpoch !== currentChainEpoch) return; // Superseded by rapid switch!

        if (json.success) {
            showToast(`Selected Network: ${json.chain.label}`, "success");
            setValue("headerChainSelect", id);
            setValue("cfgChainId", id);
            if (json.chain.rpc_url) setValue("cfgRpcUrl", json.chain.rpc_url);
            if (typeof loadSettings === "function") loadSettings();
        } else {
            showToast(json.message || "Failed to switch chain", "error");
        }
    } catch (err) {
        console.error("Backend chain switch error:", err);
    }

    // 4. Fetch fresh data for newly selected chain
    fetchMarketData();
    fetchMultiPairData();
    if (metamaskAccount && typeof fetchClientWalletBalances === "function") {
        fetchClientWalletBalances(metamaskAccount, id);
    }
}

async function quickSwitchChain(chainId) {
    return selectNetwork(chainId);
}

function getMetaMaskProvider() {
    if (typeof window.ethereum === "undefined") return null;
    try {
        if (typeof window.ethereum.setMaxListeners === "function") {
            window.ethereum.setMaxListeners(100);
        }
    } catch (e) {}

    if (window.ethereum.providers && window.ethereum.providers.length) {
        window.ethereum.providers.forEach(p => {
            try {
                if (p && typeof p.setMaxListeners === "function") p.setMaxListeners(100);
            } catch (e) {}
        });
        const found = window.ethereum.providers.find(p => p.isMetaMask && !p.isBraveWallet);
        if (found) return found;
        const mm = window.ethereum.providers.find(p => p.isMetaMask);
        if (mm) return mm;
        return window.ethereum.providers[0];
    }
    return window.ethereum;
}

const CLIENT_ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

const CLIENT_ROUTER_V2_ABI = [
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
    "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"
];

async function preApproveTokens() {
    const provider = getMetaMaskProvider();
    if (!provider) {
        showMetaMaskModal();
        return;
    }
    if (!metamaskAccount) {
        showToast("Please connect your MetaMask wallet first!", "warning");
        await connectMetaMask();
        return;
    }

    try {
        if (!metamaskSigner) {
            await initEthersProviderAndSigner();
        }

        const chainIdHex = metamaskChainId || (await provider.request({ method: "eth_chainId" }));
        const chainIdNum = parseInt(chainIdHex, 16);
        const targetChainId = currentSelectedChainId;

        if (chainIdNum !== targetChainId) {
            const targetInfo = SUPPORTED_CHAINS[targetChainId] || { short: `Chain ${targetChainId}` };
            showToast(`MetaMask is on a different network. Switching to ${targetInfo.short}...`, "warning");
            await requestSwitchNetwork(targetChainId);
            return;
        }

        if (!SUPPORTED_CHAINS[chainIdNum]) {
            showToast(`Current network (Chain ID: ${chainIdNum}) is not supported. Please switch to a supported network.`, "error");
            return;
        }
        const tokens = CLIENT_TOKEN_ADDRESSES[chainIdNum];
        const routers = CLIENT_ROUTER_ADDRESSES[chainIdNum];

        if (!tokens || !routers) {
            showToast(`No router or token definitions found for Chain ID ${chainIdNum}.`, "error");
            return;
        }

        let tokenObj = tokens.USDC || tokens.USDT;
        if (chainIdNum === 11155111) {
            tokenObj = tokens.USDT || tokens.USDC;
        }
        if (!tokenObj) {
            showToast("No stablecoin found to approve.", "error");
            return;
        }

        const routerAddress = routers.Uniswap_V2 || Object.values(routers)[0];
        const activeSigner = await getOrRefreshSigner(chainIdNum);
        const tokenContract = new ethers.Contract(tokenObj.address, CLIENT_ERC20_ABI, activeSigner);

        showToast(`Checking allowance for ${tokenObj.symbol || 'USDC'} on DEX Router...`, "info");
        const currentAllowance = await tokenContract.allowance(metamaskAccount, routerAddress);

        if (currentAllowance > ethers.parseUnits("1000", tokenObj.decimals)) {
            showToast(`Tokens already approved! Router has unlimited allowance.`, "success");
            return;
        }

        showToast("Please confirm Token Approval in MetaMask...", "info");
        const tx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
        showToast(`Approval submitted! Hash: ${tx.hash.slice(0, 10)}... Waiting for block confirmation...`, "info");
        await tx.wait(1);
        showToast("Token successfully approved for trading!", "success");
    } catch (err) {
        if (err.code === "ACTION_REJECTED" || err.code === 4001 || (err.message && err.message.toLowerCase().includes("rejected"))) {
            showToast("Approval signature rejected in MetaMask.", "warning");
        } else {
            showToast(`Approval error: ${err.message || err}`, "error");
        }
    }
}

let clientWalletBalances = {
    eth: 0,
    weth: 0,
    usdt: 0,
    usdc: 0,
    usdbc: 0,
    updated: 0
};

async function fetchClientWalletBalances(account, chainIdNum) {
    const provider = getMetaMaskProvider();
    if (!provider || !account) return;

    // Always read from MetaMask's ACTUAL current chain — not the UI-selected chain.
    // This fixes Sepolia ETH showing 0 when MetaMask is on Sepolia but bot UI shows Base.
    let actualMmChainId = Number(chainIdNum || currentSelectedChainId);
    try {
        const hex = await provider.request({ method: "eth_chainId" });
        if (hex) actualMmChainId = parseInt(hex, 16);
    } catch (e) {}

    // If MetaMask is not on any supported chain, show disconnected
    if (!SUPPORTED_CHAINS[actualMmChainId]) {
        clientWalletBalances = { eth: 0, weth: 0, usdt: 0, usdc: 0, usdbc: 0, updated: Date.now() };
        setText("balETH", "--");
        setText("balETHusd", "--");
        setText("balWETH", "--");
        setText("balWETHusd", "--");
        setText("balUSDT", "--");
        setText("balUSDC", "--");
        setText("kpiBalance", "--");
        return;
    }

    // Reset balances for this query
    clientWalletBalances = {
        eth: 0,
        weth: 0,
        usdt: 0,
        usdc: 0,
        usdbc: 0,
        updated: Date.now()
    };

    try {
        // 1. Native ETH / SepoliaETH / POL balance via eth_getBalance (direct from MetaMask)
        const hexBal = await provider.request({
            method: "eth_getBalance",
            params: [account, "latest"]
        });
        if (hexBal && hexBal !== "0x") {
            clientWalletBalances.eth = parseInt(hexBal, 16) / 1e18;
        }

        // 2. Token balances via ERC20 balanceOf eth_call (from MetaMask's actual chain)
        const tokens = CLIENT_TOKEN_ADDRESSES[actualMmChainId];
        if (tokens) {
            const cleanAddr = account.toLowerCase().replace("0x", "").padStart(64, "0");
            const balanceOfData = "0x70a08231" + cleanAddr;

            for (const [sym, info] of Object.entries(tokens)) {
                if (!info || !info.address) continue;
                try {
                    const hexRes = await provider.request({
                        method: "eth_call",
                        params: [{ to: info.address, data: balanceOfData }, "latest"]
                    });
                    if (hexRes && hexRes !== "0x") {
                        const rawVal = BigInt(hexRes);
                        const dec = info.decimals || 18;
                        const divisor = BigInt(10 ** dec);
                        const whole = rawVal / divisor;
                        const rem = rawVal % divisor;
                        const val = Number(whole) + Number(rem) / (10 ** dec);
                        if (sym === "USDC") clientWalletBalances.usdc = val;
                        else if (sym === "USDbC") clientWalletBalances.usdbc = val;
                        else if (sym === "USDT") clientWalletBalances.usdt = val;
                        else if (sym === "WETH") clientWalletBalances.weth = val;
                    }
                } catch (tokErr) {
                    console.warn(`[Balance fetch error for ${sym} on chain ${actualMmChainId}]:`, tokErr);
                }
            }
        }
        clientWalletBalances.updated = Date.now();
        // Render using MetaMask's actual chain labels
        renderClientWalletBalances(actualMmChainId);
    } catch (err) {
        console.warn("[Client Web3 Balance fetch error]:", err);
    }
}


function renderClientWalletBalances(chainId) {
    if (!metamaskAccount) return;
    // Use passed chainId (MetaMask actual) or fallback to currentSelectedChainId
    const activeChain = Number(chainId || currentSelectedChainId);
    const ethPrice = latestMarketData && latestMarketData.summary && latestMarketData.summary.eth_price_usdt ? Number(latestMarketData.summary.eth_price_usdt) : 3000;
    const chainConfig = SUPPORTED_CHAINS[activeChain] || { short: "ETH", currency: "ETH", nativeCurrency: { symbol: "ETH" } };
    const nativeSym = chainConfig.currency || (chainConfig.nativeCurrency ? chainConfig.nativeCurrency.symbol : "ETH");
    const quoteSym = (chainConfig.defaultPair && chainConfig.defaultPair.split("/")[1]) || (activeChain === 8453 ? "USDC" : "USDT");


    setText("balETH", `${Number(clientWalletBalances.eth || 0).toFixed(4)} ${nativeSym}`);
    setText("balETHusd", `≈ $${(Number(clientWalletBalances.eth || 0) * ethPrice).toFixed(2)} ${quoteSym}`);
    setText("balWETH", `${Number(clientWalletBalances.weth || 0).toFixed(4)} WETH`);
    setText("balWETHusd", `≈ $${(Number(clientWalletBalances.weth || 0) * ethPrice).toFixed(2)} ${quoteSym}`);
    setText("balUSDT", `$${Number(clientWalletBalances.usdt || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`);

    const effectiveUsdc = (clientWalletBalances.usdc || 0) + (clientWalletBalances.usdbc || 0);
    const usdcLabel = (clientWalletBalances.usdbc > 0 && (clientWalletBalances.usdc || 0) === 0) ? "USDbC" : "USDC";
    setText("balUSDC", `$${Number(effectiveUsdc).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${usdcLabel}`);

    const totalStable = (clientWalletBalances.usdt || 0) + effectiveUsdc;
    const totalEthEquity = ((clientWalletBalances.eth || 0) + (clientWalletBalances.weth || 0)) * ethPrice;
    const totalEquity = totalStable + totalEthEquity;
    setText("kpiBalance", `$${totalEquity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    setText("balETHBadge", nativeSym);
}

let metaMaskListenersAttached = false;

function initMetaMask() {
    const provider = getMetaMaskProvider();
    if (!provider) {
        window.addEventListener("ethereum#initialized", () => {
            initMetaMask();
        }, { once: true });
        console.log("[MetaMask]: Provider not yet detected in browser window.");
        return;
    }

    // Prevent EventEmitter memory leak warnings in MetaMask contentscript
    if (typeof provider.setMaxListeners === "function") {
        try {
            provider.setMaxListeners(50);
        } catch (e) {}
    }

    // Register standard EIP-1193 listeners safely without accumulating duplicates
    if (!metaMaskListenersAttached) {
        try {
            if (typeof provider.removeListener === "function") {
                provider.removeListener("accountsChanged", handleAccountsChanged);
                provider.removeListener("chainChanged", handleChainChanged);
                provider.removeListener("disconnect", handleMetaMaskDisconnect);
            }
            provider.on("accountsChanged", handleAccountsChanged);
            provider.on("chainChanged", handleChainChanged);
            provider.on("disconnect", handleMetaMaskDisconnect);
            metaMaskListenersAttached = true;
        } catch (listenerErr) {
            console.warn("[MetaMask]: Listener registration warning:", listenerErr);
        }
    }

    // Silent session restoration if previously connected
    restoreMetaMaskSession();
}

async function restoreMetaMaskSession() {
    const provider = getMetaMaskProvider();
    if (!provider) return;
    const wasConnected = safeStorage.getItem("metamask_connected") === "true";
    if (!wasConnected) return;

    try {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (accounts && accounts.length > 0) {
            await handleAccountsChanged(accounts, false);
        } else {
            safeStorage.removeItem("metamask_connected");
        }
    } catch (err) {
        console.warn("[MetaMask]: Session restore failed:", err);
    }
}

async function connectMetaMask() {
    const provider = getMetaMaskProvider();
    if (!provider) {
        showMetaMaskModal();
        return;
    }

    try {
        showToast("Connecting to MetaMask...", "info");
        let accounts = [];
        try {
            accounts = await provider.request({ method: "eth_requestAccounts" });
        } catch (reqErr) {
            if (reqErr.code === 4001) {
                showToast("Connection cancelled in MetaMask.", "warning");
                return;
            }
            if (reqErr.code === -32002) {
                showToast("MetaMask request already pending! Open your MetaMask extension to approve.", "warning");
                return;
            }
            throw reqErr;
        }

        if (!accounts || accounts.length === 0) {
            showToast("No account authorized in MetaMask.", "warning");
            return;
        }

        safeStorage.setItem("metamask_connected", "true");
        await handleAccountsChanged(accounts, true);
    } catch (err) {
        console.warn("[MetaMask connect error]:", err);
        showToast(`MetaMask error: ${err.message || err}`, "error");
    }
}

function handleUnsupportedChain(chainId) {
    console.warn(`[Unsupported Network]: Connected to chain ID ${chainId}`);
    const supportedList = Object.entries(SUPPORTED_CHAINS).map(([id, info]) => `${info.short} (${id})`).join(", ");
    showToast(`⚠️ Unsupported Network (Chain ID: ${chainId}). Supported networks: ${supportedList}`, "error");

    // Clear network cards active highlight since current connected network is not supported
    document.querySelectorAll(".network-card, .dropdown-net-card").forEach(el => el.classList.remove("active"));
    document.querySelectorAll(".net-status-badge").forEach(el => {
        el.innerText = "SELECT";
        el.classList.remove("badge-active");
    });

    // Update wallet badges to alert user
    const dot = document.getElementById("walletNetworkIndicator");
    if (dot) {
        dot.className = "network-dot dot-red";
        dot.title = `Unsupported Network! Connected to Chain ID ${chainId}. Please switch to a supported network.`;
    }
    const netText = document.getElementById("menuNetworkText");
    if (netText) netText.innerText = `Unsupported (ID: ${chainId})`;
    const netDot = document.getElementById("menuNetworkDot");
    if (netDot) netDot.className = "network-dot dot-red";
    const netBadge = document.getElementById("menuNetworkBadge");
    if (netBadge) netBadge.className = "network-name-badge wrong-network";
    const portBadge = document.getElementById("walletAddressBadge");
    if (portBadge && metamaskAccount) {
        const shortAddr = metamaskAccount.slice(0, 6) + "..." + metamaskAccount.slice(-4);
        portBadge.innerText = `${shortAddr} (Unsupported Chain: ${chainId})`;
        portBadge.className = "badge badge-red";
    }
}

async function handleAccountsChanged(accounts, notifyUser = true) {
    if (!accounts || accounts.length === 0) {
        disconnectMetaMask();
        return;
    }

    metamaskAccount = accounts[0];
    safeStorage.setItem("metamask_connected", "true");

    try {
        const provider = getMetaMaskProvider();
        metamaskChainId = provider ? await provider.request({ method: "eth_chainId" }) : null;
    } catch (e) {
        metamaskChainId = null;
    }

    let activeCid = metamaskChainId ? parseInt(metamaskChainId, 16) : currentSelectedChainId;

    // Auto-detect MetaMask chain and switch bot configuration if supported
    if (metamaskChainId) {
        const mmCid = parseInt(metamaskChainId, 16);
        if (SUPPORTED_CHAINS[mmCid]) {
            activeCid = mmCid;
            currentSelectedChainId = mmCid;
            safeStorage.setItem("userSelectedChainId", mmCid);
            updateNetworkCardsVisual(mmCid);
            try {
                await fetch("/api/chain/switch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chain_id: mmCid })
                });
            } catch (err) {
                console.warn("[MetaMask auto-switch error]:", err);
            }
        } else {
            handleUnsupportedChain(mmCid);
        }
    }

    // Setup ethers Provider & Signer architecture
    await initEthersProviderAndSigner();
    await initContractInstance(true);

    // Update UI elements immediately
    updateWalletUIConnected(metamaskAccount, metamaskChainId);

    // Instant client-side direct Web3 balance fetch — use MetaMask's actual chain
    if (typeof fetchClientWalletBalances === "function") {
        // Pass 0 so function will detect actual MetaMask chain via eth_chainId
        fetchClientWalletBalances(metamaskAccount, activeCid);
    }


    // Synchronize connected address with backend
    try {
        const res = await fetch("/api/wallet/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                address: metamaskAccount,
                chain_id: activeCid
            })
        });
        const data = await res.json();
        if (data.success) {
            if (notifyUser) {
                const short = metamaskAccount.slice(0, 6) + "..." + metamaskAccount.slice(-4);
                const chainName = SUPPORTED_CHAINS[activeCid]?.short || `Chain ${activeCid}`;
                showToast(`MetaMask Connected: ${short} on ${chainName}`, "success");
            }
            fetchMarketData();
        }
    } catch (err) {
        console.warn("[MetaMask Sync Error]:", err);
    }
}

async function handleChainChanged(chainIdHex) {
    metamaskChainId = chainIdHex;
    const newChainId = parseInt(chainIdHex, 16);
    console.log("[MetaMask]: Chain changed to:", newChainId, chainIdHex);
    await initEthersProviderAndSigner();

    // Preserve metamaskAccount! Network switching must not lose wallet connection
    if (metamaskAccount) {
        updateWalletUIConnected(metamaskAccount, chainIdHex);
    }

    // Synchronize network cards and backend config if chain is supported
    if (SUPPORTED_CHAINS[newChainId]) {
        invalidateAndResetChainUI(newChainId);
        try {
            const res = await fetch("/api/chain/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chain_id: newChainId })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Switched bot to ${SUPPORTED_CHAINS[newChainId].name}`, "info");
            }
        } catch (e) {
            console.warn("[Chain sync to backend error]:", e);
        }
        await initContractInstance(true);
        if (metamaskAccount && typeof fetchClientWalletBalances === "function") {
            fetchClientWalletBalances(metamaskAccount, newChainId);
        }
        fetchMarketData();
        fetchMultiPairData();
    } else {
        handleUnsupportedChain(newChainId);
    }
}

function handleMetaMaskDisconnect(error) {
    console.log("[MetaMask]: Disconnected:", error);
    disconnectMetaMask();
}

async function disconnectMetaMask(event) {
    if (event) event.stopPropagation();
    metamaskAccount = null;
    metamaskChainId = null;
    metamaskSigner = null;
    dexArbitrageContract = null;
    safeStorage.removeItem("metamask_connected");
    clientWalletBalances = { eth: 0, weth: 0, usdt: 0, usdc: 0, updated: 0 };

    closeWalletDropdown();
    updateWalletUIDisconnected();

    try {
        await fetch("/api/wallet/disconnect", { method: "POST" });
        showToast("MetaMask wallet disconnected.", "info");
        fetchMarketData();
    } catch (err) {
        console.warn("[Disconnect error]:", err);
    }
}

/**
 * Obtains and verifies a fresh, transaction-capable ethers.Signer from MetaMask.
 * Uses BrowserProvider(provider, "any") to handle dynamic network changes.
 * Throws a descriptive error if the transaction runner is missing or read-only.
 */
async function getOrRefreshSigner(requiredChainId = null) {
    const rawProvider = getMetaMaskProvider();
    if (!rawProvider) {
        throw new Error("No Web3 wallet provider detected. Please install or enable MetaMask.");
    }

    // 1. Verify or prompt account authorization
    let accounts = [];
    try {
        accounts = await rawProvider.request({ method: "eth_accounts" });
    } catch (e) {
        accounts = [];
    }

    if (!accounts || accounts.length === 0) {
        try {
            accounts = await rawProvider.request({ method: "eth_requestAccounts" });
        } catch (reqErr) {
            if (reqErr.code === 4001 || (reqErr.message && reqErr.message.toLowerCase().includes("rejected"))) {
                throw new Error("MetaMask account connection was rejected by the user.");
            }
            throw reqErr;
        }
    }

    if (!accounts || accounts.length === 0) {
        throw new Error("No authorized accounts in MetaMask. Please connect and unlock your wallet.");
    }

    metamaskAccount = accounts[0];

    // 2. Network alignment verification
    const currentChainHex = await rawProvider.request({ method: "eth_chainId" });
    const currentChainId = parseInt(currentChainHex, 16);
    metamaskChainId = currentChainHex;

    if (requiredChainId && currentChainId !== Number(requiredChainId)) {
        throw new Error(`Wallet is connected to Chain ID ${currentChainId}, but active trade requires Chain ID ${requiredChainId}. Please switch network in MetaMask.`);
    }

    // 3. Ensure ethers library is present
    if (typeof ethers === "undefined") {
        throw new Error("ethers.js library is not available in the browser window.");
    }

    // 4. Construct fresh BrowserProvider with 'any' network to handle dynamic network changes
    if (ethers.BrowserProvider) {
        metamaskProvider = new ethers.BrowserProvider(rawProvider, "any");
        metamaskSigner = await metamaskProvider.getSigner(metamaskAccount);
    } else if (ethers.providers && ethers.providers.Web3Provider) {
        metamaskProvider = new ethers.providers.Web3Provider(rawProvider, "any");
        metamaskSigner = metamaskProvider.getSigner(metamaskAccount);
    } else {
        throw new Error("Incompatible ethers.js version: BrowserProvider and Web3Provider missing.");
    }

    // 5. Strict Transaction Runner Capability Check
    if (!metamaskSigner) {
        throw new Error("Failed to obtain transaction signer from MetaMask provider.");
    }

    if (typeof metamaskSigner.sendTransaction !== "function") {
        throw new Error("contract runner does not support sending transactions: obtained runner is read-only. Please reconnect MetaMask.");
    }

    return metamaskSigner;
}

async function initEthersProviderAndSigner() {
    const provider = getMetaMaskProvider();
    if (!provider) return;

    try {
        if (typeof ethers !== "undefined") {
            if (ethers.BrowserProvider) {
                metamaskProvider = new ethers.BrowserProvider(provider, "any");
                if (metamaskAccount) {
                    metamaskSigner = await metamaskProvider.getSigner(metamaskAccount);
                } else {
                    const accounts = await provider.request({ method: "eth_accounts" });
                    if (accounts && accounts.length > 0) {
                        metamaskAccount = accounts[0];
                        metamaskSigner = await metamaskProvider.getSigner(metamaskAccount);
                    }
                }
            } else if (ethers.providers && ethers.providers.Web3Provider) {
                metamaskProvider = new ethers.providers.Web3Provider(provider, "any");
                metamaskSigner = metamaskProvider.getSigner();
            }
            await initContractInstance();
        }
    } catch (err) {
        console.warn("[Ethers Signer Initialization]:", err);
    }
}

let currentContractChainId = null;

async function initContractInstance(forceReload = false) {
    if (!metamaskProvider) return;
    try {
        if (forceReload || !dexContractABI || !dexContractAddress || currentContractChainId !== currentSelectedChainId) {
            const res = await fetch("/api/contract");
            const data = await res.json();
            if (data.success) {
                dexContractAddress = data.contract_address;
                dexContractABI = data.abi;
                currentContractChainId = data.chain_id;
            }
        }
        if (dexContractAddress && dexContractABI && typeof ethers !== "undefined") {
            // Read-only contract via provider
            const readContract = new ethers.Contract(dexContractAddress, dexContractABI, metamaskProvider);
            try {
                const paused = await readContract.isPaused();
                console.log(`[Contract Read on Chain ${currentContractChainId}]: isPaused =`, paused);
            } catch (e) {}

            // Signer contract for on-chain execution ONLY if signer is transaction-capable
            if (metamaskSigner && typeof metamaskSigner.sendTransaction === "function") {
                dexArbitrageContract = new ethers.Contract(dexContractAddress, dexContractABI, metamaskSigner);
            } else {
                dexArbitrageContract = null;
            }
        }
    } catch (e) {
        console.warn("[Contract instance init]:", e);
    }
}

function updateWalletUIConnected(address, chainIdHex) {
    if (!address) return;
    const shortAddr = address.slice(0, 6) + "..." + address.slice(-4);
    const targetChainId = currentSelectedChainId;
    const currentChainId = chainIdHex ? parseInt(chainIdHex, 16) : targetChainId;
    const isSupported = Boolean(SUPPORTED_CHAINS[currentChainId]);
    const isCorrectChain = isSupported && (currentChainId === targetChainId);

    // Header buttons
    const btnConnect = document.getElementById("btnConnectWallet");
    const walletPill = document.getElementById("headerWalletPill");
    const addrText = document.getElementById("headerWalletAddress");
    const dot = document.getElementById("walletNetworkIndicator");

    if (btnConnect) btnConnect.style.display = "none";
    if (walletPill) walletPill.style.display = "inline-flex";
    if (addrText) addrText.innerText = shortAddr;

    // Network status styling
    const targetChainInfo = SUPPORTED_CHAINS[targetChainId] || { name: `Chain ${targetChainId}`, short: `Chain ${targetChainId}`, explorer: "https://etherscan.io" };
    const currentChainInfo = SUPPORTED_CHAINS[currentChainId] || { name: `Unsupported Chain (${currentChainId})`, short: `ID ${currentChainId}`, explorer: "https://etherscan.io" };

    if (dot) {
        dot.className = "network-dot " + (isCorrectChain ? "dot-green" : "dot-red");
        dot.title = isCorrectChain ? `Connected to ${targetChainInfo.name}` : (!isSupported ? `Unsupported Network (${currentChainId})` : `Wrong Network! Connected to ${currentChainInfo.name}. Click to switch to ${targetChainInfo.name}`);
    }

    // Dropdown details
    setText("menuFullAddress", address);
    const netBadge = document.getElementById("menuNetworkBadge");
    const netText = document.getElementById("menuNetworkText");
    const netDot = document.getElementById("menuNetworkDot");
    const btnSwitch = document.getElementById("btnSwitchNetwork");
    const btnExplorer = document.getElementById("btnViewExplorer");

    if (netText) netText.innerText = isCorrectChain ? targetChainInfo.name : (!isSupported ? `Unsupported Chain (${currentChainId})` : `Wrong Network (${currentChainInfo.short})`);
    if (netDot) netDot.className = "network-dot " + (isCorrectChain ? "dot-green" : "dot-red");
    if (netBadge) {
        netBadge.className = "network-name-badge " + (isCorrectChain ? "" : "wrong-network");
    }
    if (btnSwitch) {
        btnSwitch.style.display = isCorrectChain ? "none" : "flex";
        btnSwitch.onclick = (e) => requestSwitchNetwork(targetChainId, e);
        btnSwitch.innerHTML = `<span>🔄</span> <span>Switch to ${targetChainInfo.short}</span>`;
    }
    if (btnExplorer) {
        btnExplorer.href = `${currentChainInfo.explorer}/address/${address}`;
    }

    // Synchronize network cards visual state
    if (isSupported && typeof updateNetworkCardsVisual === "function") {
        updateNetworkCardsVisual(targetChainId);
    }

    // Portfolio panel badge & connect button
    const portBadge = document.getElementById("walletAddressBadge");
    if (portBadge) {
        if (isCorrectChain) {
            portBadge.innerText = `${shortAddr} (${targetChainInfo.short})`;
            portBadge.className = "badge badge-green";
        } else if (!isSupported) {
            portBadge.innerText = `${shortAddr} (Unsupported Chain: ${currentChainId})`;
            portBadge.className = "badge badge-red";
        } else {
            portBadge.innerText = `${shortAddr} (Wrong Network: ${currentChainInfo.short})`;
            portBadge.className = "badge badge-red";
        }
    }
    const portConnectBtn = document.getElementById("btnPortfolioConnect");
    if (portConnectBtn) {
        portConnectBtn.innerText = "Disconnect";
        portConnectBtn.className = "btn btn-secondary";
        portConnectBtn.onclick = disconnectMetaMask;
    }
}

function updateWalletUIDisconnected() {
    const btnConnect = document.getElementById("btnConnectWallet");
    const walletPill = document.getElementById("headerWalletPill");
    const menu = document.getElementById("walletDropdownMenu");

    if (btnConnect) btnConnect.style.display = "inline-flex";
    if (walletPill) walletPill.style.display = "none";
    if (menu) menu.style.display = "none";

    const portBadge = document.getElementById("walletAddressBadge");
    if (portBadge) {
        portBadge.innerText = "Wallet Disconnected";
        portBadge.className = "badge badge-yellow";
    }
    const portConnectBtn = document.getElementById("btnPortfolioConnect");
    if (portConnectBtn) {
        portConnectBtn.innerText = "🦊 Connect";
        portConnectBtn.className = "btn btn-secondary";
        portConnectBtn.onclick = connectMetaMask;
    }

    setText("balETH", "0.0000 ETH");
    setText("balETHusd", "≈ $0.00 USDT");
    setText("balWETH", "0.0000 WETH");
    setText("balWETHusd", "≈ $0.00 USDT");
    setText("balUSDT", "$0.00 USDT");
    setText("balUSDC", "$0.00 USDC");
    setText("kpiBalance", "$0.00");
}

async function requestSwitchNetwork(targetChainOrEvent) {
    let targetChainId;
    if (typeof targetChainOrEvent === "number" || typeof targetChainOrEvent === "string") {
        targetChainId = Number(targetChainOrEvent);
    } else {
        if (targetChainOrEvent && typeof targetChainOrEvent.stopPropagation === "function") {
            targetChainOrEvent.stopPropagation();
        }
        targetChainId = Number(latestMarketData && latestMarketData.chain_id ? latestMarketData.chain_id : (latestMarketData && latestMarketData.settings && latestMarketData.settings.chain_id ? latestMarketData.settings.chain_id : 8453));
    }
    const provider = getMetaMaskProvider();
    if (!provider) return;

    const chainConfig = SUPPORTED_CHAINS[targetChainId] || { hex: "0x" + targetChainId.toString(16), name: `Chain ${targetChainId}` };
    const targetHex = chainConfig.hex || ("0x" + targetChainId.toString(16));

    try {
        await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: targetHex }]
        });
        showToast(`Switched network to ${chainConfig.short || chainConfig.name}!`, "success");
    } catch (switchError) {
        if (switchError.code === 4902 || switchError.data?.originalError?.code === 4902) {
            try {
                await provider.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: targetHex,
                        chainName: chainConfig.name,
                        nativeCurrency: chainConfig.nativeCurrency || { name: "Ether", symbol: "ETH", decimals: 18 },
                        rpcUrls: chainConfig.rpcUrls || [],
                        blockExplorerUrls: chainConfig.explorer ? [chainConfig.explorer] : []
                    }]
                });
                showToast(`Added and switched to ${chainConfig.short || chainConfig.name}!`, "success");
            } catch (addError) {
                showToast(`Failed to add network to MetaMask: ${addError.message}`, "error");
            }
        } else if (switchError.code === 4001) {
            showToast("Network switch cancelled by user.", "info");
        } else {
            showToast(`Failed to switch network: ${switchError.message}`, "error");
        }
    }
}

function toggleWalletDropdown(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById("walletDropdownMenu");
    if (!menu) return;
    const isShown = menu.style.display === "flex";
    menu.style.display = isShown ? "none" : "flex";
}

function closeWalletDropdown() {
    const menu = document.getElementById("walletDropdownMenu");
    if (menu) menu.style.display = "none";
}

async function copyWalletAddress(event) {
    if (event) event.stopPropagation();
    if (!metamaskAccount) return;

    try {
        await navigator.clipboard.writeText(metamaskAccount);
        showToast("Address copied to clipboard!", "success");
    } catch (e) {
        showToast("Copied address: " + metamaskAccount.slice(0, 10) + "...", "info");
    }
}

function showMetaMaskModal() {
    const el = document.getElementById("metamaskModalOverlay");
    if (el) el.style.display = "flex";
}

function closeMetaMaskModal() {
    const el = document.getElementById("metamaskModalOverlay");
    if (el) el.style.display = "none";
}



// ============================================================
// ADVANCED FEATURE 2: MULTI-PAIR OPPORTUNITY SCANNER
// ============================================================

async function fetchMultiPairData() {
    const thisEpoch = currentChainEpoch;
    const thisChainId = currentSelectedChainId;
    const grid = document.getElementById("multiPairGrid");
    if (!grid) return;

    try {
        const res = await fetch(`/api/market/all-pairs?chain_id=${thisChainId}`);
        const data = await res.json();

        // Strict Race Condition & Epoch Guard:
        if (thisEpoch !== currentChainEpoch || thisChainId !== currentSelectedChainId) {
            return;
        }
        if (!data.success || !data.pairs) return;

        // Verify response belongs to currentSelectedChainId
        const respChainId = Number(data.chain_id || thisChainId);
        if (respChainId !== currentSelectedChainId) {
            return;
        }

        const chainInfo = SUPPORTED_CHAINS[thisChainId] || { name: `Chain ${thisChainId}`, short: "DEX" };
        setText("heatmapChainLabel", `(${chainInfo.short})`);

        if (data.pairs.length === 0) {
            grid.innerHTML = `<div id="multiPairPlaceholder" style="color:var(--text-muted); font-size:12px; padding:15px;">No active pools found for ${chainInfo.name}.</div>`;
            return;
        }

        // Clean grid of any previous chain cards
        grid.innerHTML = "";

        data.pairs.forEach(p => {
            const cardId = "pair_card_" + p.pair.replace("/", "_");
            const isBest = data.best_pair && data.best_pair.pair === p.pair;
            const spreadSign = p.spread_val >= 0 ? "+" : "";
            const borderColor = p.is_active ? "var(--action-color)" : (isBest ? "var(--profit-color)" : "var(--border)");
            const badgeHtml = p.is_active 
                ? '<span class="badge badge-blue" style="position:absolute; top:8px; right:8px; font-size:10px;">ACTIVE PAIR</span>' 
                : (isBest ? '<span class="badge badge-green" style="position:absolute; top:8px; right:8px; font-size:10px;">TOP SPREAD</span>' : '');

            const card = document.createElement("div");
            card.id = cardId;
            card.className = "dex-wallet-item";
            card.style.position = "relative";
            card.style.cursor = "pointer";
            card.style.minHeight = "130px";
            card.style.borderColor = borderColor;
            card.onclick = () => quickSwitchPair(p.pair);

            card.innerHTML = `
                ${badgeHtml}
                <div style="display:flex; align-items:center; gap:6px;">
                    <span class="token-name" style="font-size:14px; font-weight:700; color:var(--text-bright);">${p.pair}</span>
                    <span style="font-size:10px; color:var(--text-muted); background:rgba(255,255,255,0.06); padding:1px 5px; border-radius:4px;">${chainInfo.short}</span>
                </div>
                <div style="margin: 8px 0;">
                    <div style="font-size:11px; color:var(--text-muted);">Buy: ${p.buy_dex.replace("_", " ")} ($${Number(p.buy_price || 0).toFixed(2)})</div>
                    <div style="font-size:11px; color:var(--text-muted);">Sell: ${p.sell_dex.replace("_", " ")} ($${Number(p.sell_price || 0).toFixed(2)})</div>
                </div>
                <h3 style="font-size:16px; color:${p.spread_val >= 0 ? "var(--profit-color)" : "var(--loss-color)"}; margin-bottom:4px; font-variant-numeric:tabular-nums;">
                    ${spreadSign}$${Number(p.spread_val || 0).toFixed(2)} (${spreadSign}${Number(p.spread_pct || 0).toFixed(2)}%)
                </h3>
                <button class="btn btn-secondary" style="width:100%; font-size:11px; padding:4px; margin-top:6px;">
                    ${p.is_active ? "Active" : "Switch to " + p.pair}
                </button>
            `;

            grid.appendChild(card);
        });
    } catch (err) {
        console.warn("[Multi-Pair Fetch Error]:", err);
    }
}

async function quickSwitchPair(pair) {
    try {
        showToast(`Switching trading pair to ${pair}...`, "info");
        const res = await fetch("/api/pair/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: pair })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Trading pair switched to ${pair}`, "success");
            fetchMarketData();
            fetchMultiPairData();
        } else {
            showToast(data.message || "Failed to switch pair", "error");
        }
    } catch (e) {
        showToast("Error switching pair: " + e, "error");
    }
}

// ============================================================
// ADVANCED FEATURE 3: 1-CLICK DIRECT METAMASK ON-CHAIN SWAP
// ============================================================

function selectSlippagePreset(val, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll(".slippage-btn").forEach(b => b.classList.remove("active"));
    if (event && event.currentTarget) event.currentTarget.classList.add("active");
    const cfgSlippage = document.getElementById("cfgSlippage");
    if (cfgSlippage) cfgSlippage.value = val;
    const label = document.getElementById("dashSlippageLabel");
    if (label) label.innerText = `${val}% ${val <= 0.5 ? '(Safe)' : '(Aggressive)'}`;
    showToast(`Slippage tolerance set to ${val}%`, "info");
}

async function executeMockPipelineTrade(route, targetChainInfo) {
    const tradeAmt = selectedTradeAmount || 5.0;
    const chainName = targetChainInfo?.name || "Base L2";
    showExecModal("Simulation Pipeline: 1/5", `Verifying simulated wallet balance on ${chainName}...`, 1);
    await new Promise(r => setTimeout(r, 450));

    showExecModal("Simulation Pipeline: 2/5", `Approving DEX Router allowance for ${route.buy_dex || "Uniswap_V2"}...`, 2);
    await new Promise(r => setTimeout(r, 500));

    showExecModal("Simulation Pipeline: 3/5", `Executing DEX Swap: ${route.buy_dex || "Uniswap_V2"} ➔ ${route.sell_dex || "SushiSwap_V2"}...`, 3);
    await new Promise(r => setTimeout(r, 550));

    showExecModal("Simulation Pipeline: 4/5", `Mining transaction receipt on ${chainName}...`, 4);
    await new Promise(r => setTimeout(r, 450));

    try {
        const res = await fetch("/api/trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trade_amount: tradeAmt,
                wallet_address: metamaskAccount || "0x9cb6b2c1205a16ba947b783ed99569234decfcc0"
            })
        });
        const json = await res.json();
        renderExecutionResult(json);
        fetchMarketData();
        loadTrades();
        loadExecutionLogs();
    } catch (err) {
        showToast("Execution error: " + err, "error");
    }
}

async function executeMetaMaskOnChainTrade(options = {}) {
    // Guard 1: Emergency Stop Check
    if (latestMarketData && latestMarketData.summary && latestMarketData.summary.emergency_stop) {
        showToast("Emergency Stop is ACTIVE! All trading and blockchain transactions are blocked.", "error");
        renderExecutionResult({
            success: false,
            status: "BLOCKED_EMERGENCY_STOP",
            message: "Emergency Stop is active; execution blocked."
        });
        return;
    }

    // Guard 2: Wallet Connection Check
    if (!metamaskAccount) {
        showToast("Please connect your MetaMask wallet first.", "warning");
        showMetaMaskModal();
        return;
    }

    // Guard 3: Network Synchronization & Unsupported Chain Check
    const targetChainId = currentSelectedChainId;
    const currentChainId = metamaskChainId ? parseInt(metamaskChainId, 16) : null;

    if (currentChainId && !SUPPORTED_CHAINS[currentChainId]) {
        renderExecutionResult({
            success: false,
            status: "UNSUPPORTED_CHAIN",
            message: `Unsupported blockchain network (Chain ID: ${currentChainId}). Please switch MetaMask to a supported network (Base L2, Base Sepolia, Sepolia, Arbitrum, Polygon, Ethereum) before trading.`
        });
        showToast(`Unsupported network (Chain ID: ${currentChainId}). Trade execution blocked.`, "error");
        return;
    }

    const targetChainInfo = SUPPORTED_CHAINS[targetChainId];
    if (!targetChainInfo) {
        renderExecutionResult({
            success: false,
            status: "UNSUPPORTED_CHAIN",
            message: `Selected chain ID ${targetChainId} is not supported.`
        });
        return;
    }

    if (currentChainId !== targetChainId) {
        const currentChainInfo = SUPPORTED_CHAINS[currentChainId] || { short: `Chain ${currentChainId}` };
        showToast(`MetaMask is on ${currentChainInfo.short}. Please switch to ${targetChainInfo.short} before executing trade.`, "error");
        await requestSwitchNetwork(targetChainId);
        return;
    }

    const bestRoute = options?.freshRoute || latestMarketData?.best_route || latestMarketData?.data?.best_route;
    if (!latestMarketData || !bestRoute) {
        showToast("Scanning DEX liquidity... Please wait for a route quote.", "warning");
        return;
    }

    const route = bestRoute;

    // Safety Guard: Real Net Profit Check (Never execute a loss)
    const netProfitVal = Number(route.net_profit_usdt || 0);
    if (!route.is_profitable || netProfitVal <= 0) {
        const lossMsg = netProfitVal < 0 ? `-$${Math.abs(netProfitVal).toFixed(4)}` : "$0.00";
        showToast(`Execution blocked: Route is unprofitable (${lossMsg} Net PnL). Arbitrage only executes when Net Profit > 0.`, "error");
        renderExecutionResult({
            success: false,
            status: "BLOCKED_UNPROFITABLE",
            message: `Execution blocked to protect your capital. This route produces a net loss (${lossMsg}). DEX Arbitrage requires strictly positive profit (Net Profit > $0.00).`
        });
        return;
    }

    const isMock = latestMarketData && (latestMarketData.trading_mode === "MOCK" || (latestMarketData.settings && latestMarketData.settings.trading_mode === "MOCK"));
    if (isMock && targetChainId !== 11155111) {
        await executeMockPipelineTrade(route, targetChainInfo);
        return;
    }

    // Step 1: Wallet & Gas Check
    showExecModal("MetaMask Direct On-Chain Execution", `Checking wallet balances on ${targetChainInfo.name}...`, 1);

    try {
        // Obtain and verify fresh, transaction-capable wallet signer for target chain
        const activeSigner = await getOrRefreshSigner(targetChainId);
        if (!activeSigner || typeof activeSigner.sendTransaction !== "function") {
            throw new Error("contract runner does not support sending transactions: active signer lacks sendTransaction.");
        }

        // Native gas coin balance check (ETH / SepoliaETH / POL >= 0.0001)
        const nativeSym = targetChainInfo.short || "ETH";
        const nativeBal = Number(clientWalletBalances.eth || 0);
        if (nativeBal < 0.0001) {
            renderExecutionResult({
                success: false,
                status: "INSUFFICIENT_GAS",
                message: `Your connected wallet has ${nativeBal.toFixed(6)} ${nativeSym}. You need at least 0.0001 ${nativeSym} for network gas fees.`
            });
            return;
        }

        const tokens = CLIENT_TOKEN_ADDRESSES[targetChainId];
        const routers = CLIENT_ROUTER_ADDRESSES[targetChainId];

        if (!tokens || !routers) {
            renderExecutionResult({
                success: false,
                status: "CONFIGURATION_ERROR",
                message: `No token or router contracts registered for ${targetChainInfo.name}.`
            });
            return;
        }

        // Select quote token based on chain & available wallet balance
        let tokenInMeta = null;
        let availStable = 0;
        let tokenSymbol = "USDT";

        if (targetChainId === 8453 || targetChainId === 84532) {
            if ((clientWalletBalances.usdc || 0) > 0 && tokens.USDC) {
                tokenInMeta = tokens.USDC;
                availStable = clientWalletBalances.usdc;
                tokenSymbol = "USDC";
            } else if ((clientWalletBalances.usdbc || 0) > 0 && tokens.USDbC) {
                tokenInMeta = tokens.USDbC;
                availStable = clientWalletBalances.usdbc;
                tokenSymbol = "USDbC";
            } else if ((clientWalletBalances.usdt || 0) > 0 && tokens.USDT) {
                tokenInMeta = tokens.USDT;
                availStable = clientWalletBalances.usdt;
                tokenSymbol = "USDT";
            } else {
                tokenInMeta = tokens.USDC || tokens.USDbC || tokens.USDT;
                availStable = 0;
                tokenSymbol = "USDC";
            }
        } else if (targetChainId === 11155111) {
            // Sepolia: Select stable token from active trading symbol or wallet balances
            const activePair = latestMarketData?.symbol || "WETH/USDC";
            const quoteSymbol = activePair.split("/")[1] || "USDC";
            if (quoteSymbol === "USDC" && tokens.USDC) {
                tokenInMeta = tokens.USDC;
                availStable = Number(clientWalletBalances.usdc || 0);
                tokenSymbol = "USDC";
            } else if (quoteSymbol === "USDT" && tokens.USDT) {
                tokenInMeta = tokens.USDT;
                availStable = Number(clientWalletBalances.usdt || 0);
                tokenSymbol = "USDT";
            } else if ((clientWalletBalances.usdc || 0) > 0 && tokens.USDC) {
                tokenInMeta = tokens.USDC;
                availStable = Number(clientWalletBalances.usdc || 0);
                tokenSymbol = "USDC";
            } else if ((clientWalletBalances.usdt || 0) > 0 && tokens.USDT) {
                tokenInMeta = tokens.USDT;
                availStable = Number(clientWalletBalances.usdt || 0);
                tokenSymbol = "USDT";
            } else {
                tokenInMeta = tokens.USDC || tokens.USDT;
                availStable = Number(clientWalletBalances.usdc || 0) + Number(clientWalletBalances.usdt || 0);
                tokenSymbol = tokenInMeta === tokens.USDC ? "USDC" : "USDT";
            }
        } else {
            if ((clientWalletBalances.usdt || 0) > 0 && tokens.USDT) {
                tokenInMeta = tokens.USDT;
                availStable = clientWalletBalances.usdt;
                tokenSymbol = "USDT";
            } else if ((clientWalletBalances.usdc || 0) > 0 && tokens.USDC) {
                tokenInMeta = tokens.USDC;
                availStable = clientWalletBalances.usdc;
                tokenSymbol = "USDC";
            } else {
                tokenInMeta = tokens.USDT || tokens.USDC;
                availStable = (clientWalletBalances.usdt || 0) + (clientWalletBalances.usdc || 0);
                tokenSymbol = tokens.USDT ? "USDT" : "USDC";
            }
        }

        const tokenOutMeta = tokens.WETH;
        if (!tokenInMeta || !tokenOutMeta) {
            renderExecutionResult({
                success: false,
                status: "CONFIGURATION_ERROR",
                message: `Target trading pair tokens are not defined for ${targetChainInfo.name}.`
            });
            return;
        }

        // Dynamic trade amount calculation based on safe balance
        let tradeAmt = options?.tradeAmount || selectedTradeAmount || 0.10;
        if (availStable > 0 && tradeAmt > availStable) {
            tradeAmt = Math.max(0.0001, Math.floor(availStable * 0.95 * 10000) / 10000);
        }

        if (availStable <= 0 || tradeAmt <= 0) {
            renderExecutionResult({
                success: false,
                status: "INSUFFICIENT_BALANCE",
                message: `Connected wallet ${metamaskAccount.slice(0, 6)}...${metamaskAccount.slice(-4)} has $${availStable.toFixed(4)} ${tokenSymbol} on ${targetChainInfo.name}. Fund your wallet to execute on-chain swaps.`
            });
            return;
        }

        const parsedAmountIn = ethers.parseUnits(tradeAmt.toFixed(tokenInMeta.decimals), tokenInMeta.decimals);
        const routerName = route.buy_dex || "Uniswap_V2";
        const routerAddress = routers[routerName] || Object.values(routers)[0];

        // Close initial check modal before presenting explicit review if manual
        if (!options?.autoExec) {
            closeExecModal();

            // Calculate trade preview metrics for live confirmation review
            const ethPrice = Number(latestMarketData?.summary?.eth_price_usdt || 3000);
            const gasPriceGwei = Number(latestMarketData?.gas_price_gwei || 0.01);
            const estGasUnits = 250000;
            const estGasNative = (estGasUnits * gasPriceGwei * 1e-9);
            const estGasUsd = estGasNative * ethPrice;
            const gasStr = `~${estGasNative.toFixed(6)} ${nativeSym} (~$${estGasUsd < 0.01 ? '<0.01' : estGasUsd.toFixed(3)} USDT)`;

            let estOutStr = "--";
            const buyPrice = Number(route.buy_price || 0);
            if (buyPrice > 0) {
                const estUnits = tradeAmt / buyPrice;
                estOutStr = `~${estUnits.toFixed(6)} WETH`;
            } else {
                const estUnits = tradeAmt / (ethPrice || 3000);
                estOutStr = `~${estUnits.toFixed(6)} WETH`;
            }

            const slippageVal = parseFloat(document.getElementById("cfgSlippage")?.value || "0.5");
            const priceImpactVal = parseFloat(route.price_impact_pct || 0.05);

            // Explicit Live-Mode Warning: Require explicit user confirmation before initiating manual wallet transaction
            try {
                await new Promise((resolve, reject) => {
                    showLiveTradeConfirmModal({
                        networkName: `${targetChainInfo.name} (Chain ID ${targetChainId})`,
                        inputStr: `${tradeAmt.toFixed(4)} ${tokenSymbol}`,
                        outputStr: estOutStr,
                        gasStr: gasStr,
                        slippageStr: `${slippageVal.toFixed(1)}%`,
                        priceImpactStr: `${priceImpactVal < 0.01 ? '< 0.01' : priceImpactVal.toFixed(2)}%`,
                        recipientStr: `${metamaskAccount} (Your Connected Wallet)`
                    }, () => resolve(), () => reject(new Error("LIVE_CONFIRMATION_CANCELLED")));
                });
            } catch (confirmErr) {
                showToast("Live trade review cancelled by user.", "info");
                return;
            }
        }

        // Step 2: Check pair existence and query DEX Router for fresh on-chain quote
        const factories = CLIENT_FACTORY_ADDRESSES[targetChainId] || {};
        const factoryAddress = factories[routerName] || Object.values(factories)[0];
        if (factoryAddress) {
            try {
                const factoryContract = new ethers.Contract(factoryAddress, CLIENT_FACTORY_V2_ABI, activeSigner);
                const pairAddr = await factoryContract.getPair(tokenInMeta.address, tokenOutMeta.address);
                if (!pairAddr || pairAddr === "0x0000000000000000000000000000000000000000" || parseInt(pairAddr, 16) === 0) {
                    const advice = (targetChainId === 11155111 && tokenSymbol !== "USDC") 
                        ? ` On Sepolia testnet, the liquid DEX pool is WETH/USDC. Please switch trading pair to WETH/USDC.` 
                        : "";
                    renderExecutionResult({
                        success: false,
                        status: "PAIR_NOT_FOUND",
                        message: `No liquidity pool found on ${routerName} for ${tokenSymbol}/WETH.${advice} Transaction was NOT sent to protect capital.`
                    });
                    showToast(`No pool for ${tokenSymbol}/WETH on ${routerName}.${advice}`, "error");
                    return;
                }
            } catch (factErr) {
                console.warn("[MetaMask Trade] Factory pair check warning:", factErr);
            }
        }

        const routerContract = new ethers.Contract(routerAddress, CLIENT_ROUTER_V2_ABI, activeSigner);
        if (!routerContract.runner || typeof routerContract.runner.sendTransaction !== "function") {
            throw new Error("Router contract runner does not support sending transactions. Wallet transaction aborted.");
        }
        const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
        const path = [tokenInMeta.address, tokenOutMeta.address];

        showExecModal("Querying Fresh Quote", `Fetching live on-chain quote from ${routerName}...`, 2);
        let expectedOut = 0n;
        try {
            const amountsOut = await routerContract.getAmountsOut(parsedAmountIn, path);
            if (!amountsOut || amountsOut.length < 2 || amountsOut[1] <= 0n) {
                throw new Error("Zero output tokens returned by router for this input amount.");
            }
            expectedOut = amountsOut[1];
        } catch (quoteErr) {
            console.error("[MetaMask Trade] Quote query error:", quoteErr);
            const rawMsg = quoteErr.reason || quoteErr.data?.message || quoteErr.shortMessage || quoteErr.message || "Execution reverted during quote query";
            let friendlyMsg = rawMsg;
            if (rawMsg.includes("INSUFFICIENT_LIQUIDITY") || rawMsg.includes("execution reverted") || rawMsg.includes("missing revert data")) {
                friendlyMsg = `No active liquidity in pool for ${tokenSymbol}/WETH on ${routerName}.`;
                if (targetChainId === 11155111 && tokenSymbol !== "USDC") {
                    friendlyMsg += ` (On Sepolia testnet, please select WETH/USDC for active DEX liquidity).`;
                }
            }
            renderExecutionResult({
                success: false,
                status: "QUOTE_FETCH_FAILED",
                message: `Could not fetch fresh on-chain quote from ${routerName}: ${friendlyMsg} Transaction was NOT sent to protect capital.`
            });
            showToast(`Quote failed: ${friendlyMsg}`, "error");
            return;
        }

        const slippageInput = parseFloat(document.getElementById("cfgSlippage")?.value || "0.5");
        const slippageBps = BigInt(Math.max(1, Math.min(5000, Math.round(slippageInput * 100))));
        const amountOutMin = (expectedOut * (10000n - slippageBps)) / 10000n;

        // Step 3: Verify and request ERC-20 token approval
        showExecModal("Verifying Token Allowance", `Checking ${tokenSymbol} allowance for ${routerName}...`, 2);
        const tokenContract = new ethers.Contract(tokenInMeta.address, CLIENT_ERC20_ABI, activeSigner);
        const currentAllowance = await tokenContract.allowance(metamaskAccount, routerAddress);

        if (currentAllowance < parsedAmountIn) {
            showExecModal("Approving Token Spending", `Please confirm Token Approval for ${routerName} in MetaMask...`, 2);
            showToast(`Please approve ${tokenSymbol} spending in MetaMask...`, "info");
            const approveTx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
            showExecModal("Confirming Approval", `Approval submitted (${approveTx.hash.slice(0, 10)}...). Waiting for block confirmation...`, 2);
            const appReceipt = await approveTx.wait(1);
            if (!appReceipt || (appReceipt.status !== 1 && appReceipt.status !== "0x1")) {
                renderExecutionResult({
                    success: false,
                    status: "APPROVAL_REVERTED",
                    message: `Token approval transaction reverted on ${targetChainInfo.name}. Swap aborted.`
                });
                showToast("Token approval reverted on-chain.", "error");
                return;
            }
            showToast("Token approval confirmed on-chain!", "success");
            await fetchClientWalletBalances(metamaskAccount, targetChainId);
        }

        // Step 4: Pre-flight Simulation & Gas Estimation
        showExecModal("Simulating On-Chain Swap", `Simulating exact ${routerName} swap on ${targetChainInfo.name} before broadcast...`, 3);
        let safeGasLimit = 350000n;
        try {
            const estimatedGas = await routerContract.swapExactTokensForTokens.estimateGas(
                parsedAmountIn,
                amountOutMin,
                path,
                metamaskAccount,
                deadline
            );
            safeGasLimit = (estimatedGas * 125n) / 100n;
        } catch (simErr) {
            console.error("[MetaMask Trade] Pre-flight simulation failed:", simErr);
            const errMsg = simErr.reason || simErr.data?.message || simErr.shortMessage || simErr.message || "Transaction would revert on-chain";
            renderExecutionResult({
                success: false,
                status: "SIMULATION_FAILED",
                message: `Transaction pre-flight simulation failed: ${errMsg}. Capital was protected and no transaction was broadcasted.`
            });
            showToast(`Simulation failed: ${errMsg}`, "error");
            return;
        }

        // Step 5: Broadcast real transaction via MetaMask
        showExecModal("Executing DEX Swap", `Submitting trade of $${tradeAmt.toFixed(4)} ${tokenSymbol} on ${routerName}... Confirm in MetaMask.`, 3);
        showToast("Please confirm Swap transaction in MetaMask...", "info");

        const txResponse = await routerContract.swapExactTokensForTokens(
            parsedAmountIn,
            amountOutMin,
            path,
            metamaskAccount,
            deadline,
            { gasLimit: safeGasLimit }
        );

        // Step 6: Block Mining Receipt
        showExecModal("Mining Transaction", `Swap broadcasted! Hash: ${txResponse.hash.slice(0, 10)}... Waiting for block receipt...`, 4);
        showToast(`Transaction Broadcasted: ${txResponse.hash.slice(0, 10)}...`, "info");
        const receipt = await txResponse.wait(1);

        if (!receipt || (receipt.status !== 1 && receipt.status !== "0x1")) {
            renderExecutionResult({
                success: false,
                status: "TRANSACTION_REVERTED",
                message: `Transaction ${txResponse.hash} reverted on-chain. Capital was preserved, but gas was consumed. No trade was recorded.`
            });
            showToast("Transaction reverted on-chain. Capital preserved.", "error");
            return;
        }

        // Step 7: Verify and record live trade on backend
        showExecModal("Verifying On-Chain Receipt", "Verifying block receipt & updating live audit log...", 5);
        const tradeMode = targetChainInfo.isTestnet ? "TESTNET" : "LIVE";
        const confirmRes = await fetch("/api/trade/confirm-live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tx_hash: txResponse.hash,
                chain_id: targetChainId,
                buy_dex: routerName,
                sell_dex: route.sell_dex || routerName,
                token_pair: `${tokenSymbol}/WETH`,
                amount_in: tradeAmt,
                expected_profit: route.net_profit_usdt || 0.0,
                gross_profit: route.gross_profit_usdt || 0.0,
                mode: tradeMode
            })
        });
        const confirmData = await confirmRes.json();

        if (confirmData.success) {
            renderExecutionResult({
                success: true,
                status: "TRANSACTION_CONFIRMED",
                message: `Trade verified on-chain! Net PnL: +$${Number(confirmData.trade.net_profit || 0).toFixed(4)} USDT`,
                tx_hash: txResponse.hash,
                trade: confirmData.trade
            });
            showToast("Live trade verified and committed to database!", "success");
        } else {
            renderExecutionResult({
                success: false,
                status: "RECEIPT_VERIFICATION_FAILED",
                message: confirmData.message || `Receipt verification returned an issue on ${targetChainInfo.name}`,
                tx_hash: txResponse.hash
            });
        }

        await fetchClientWalletBalances(metamaskAccount, targetChainId);
        fetchMarketData();
        loadTrades();
        loadExecutionLogs();
    } catch (err) {
        if (err && err.message === "LIVE_CONFIRMATION_CANCELLED") {
            return;
        }
        let userMsg = err?.message || String(err);
        let errStatus = "TRANSACTION_FAILED";

        if (err.code === "ACTION_REJECTED" || err.code === 4001 || (err.message && err.message.toLowerCase().includes("user rejected")) || (err.message && err.message.toLowerCase().includes("rejected"))) {
            showToast("Transaction signature rejected by user in MetaMask.", "warning");
            closeExecModal();
            return;
        } else if (err.code === "UNSUPPORTED_OPERATION" || (err.message && err.message.includes("contract runner does not support sending transactions"))) {
            errStatus = "TRANSACTION_RUNNER_ERROR";
            userMsg = "Transaction Runner Error: Wallet signer is not available or disconnected. Please reconnect MetaMask and try again.";
            showToast(userMsg, "error");
        } else if (err.code === "INSUFFICIENT_FUNDS" || (err.message && err.message.toLowerCase().includes("insufficient funds"))) {
            errStatus = "INSUFFICIENT_FUNDS";
            userMsg = "Your connected wallet does not have enough native ETH to cover the blockchain network gas fee.";
        } else if (err.code === "CALL_EXCEPTION" || (err.message && err.message.toLowerCase().includes("execution reverted"))) {
            errStatus = "TRANSACTION_REVERTED";
            if (err.message && err.message.includes("INSUFFICIENT_OUTPUT_AMOUNT")) {
                userMsg = "Swap reverted: Price moved beyond your slippage tolerance. Try increasing slippage slightly.";
            } else if (err.message && err.message.includes("EXPIRED")) {
                userMsg = "Swap deadline expired before the transaction was confirmed.";
            } else {
                userMsg = "DEX Smart Router reverted the transaction to guarantee fund safety against slippage.";
            }
        } else if (err.code === "NETWORK_ERROR" || (err.message && err.message.toLowerCase().includes("network error"))) {
            errStatus = "NETWORK_ERROR";
            userMsg = "Network RPC error. Check your internet connection or switch RPC endpoint in Settings.";
        } else if (err.code === -32002) {
            showToast("MetaMask request already pending. Open your MetaMask extension to approve.", "warning");
            closeExecModal();
            return;
        }

        renderExecutionResult({
            success: false,
            status: errStatus,
            message: userMsg
        });
    }
}


// ============================================================
// ADVANCED FEATURE 5: AUDIT LOG CSV & JSON EXPORT
// ============================================================

function exportTradeHistory(format = "csv") {
    showToast(`Preparing ${format.toUpperCase()} export...`, "info");
    const currentFilter = document.querySelector("#tab-trades .btn[style*='background:#dc2626']") ? "LIVE" : "ALL";
    window.location.href = `/api/trades/export?format=${format}&mode=${currentFilter}`;
}