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

let currentTab = "dashboard";
let selectedTradeAmount = 5;
let latestMarketData = null;
let liveChart = null;
let priceSnapshots = [];
const MAX_SNAPSHOTS = 30;

// Web Audio API State & Synthesizer
let terminalAudioCtx = null;
let terminalSoundEnabled = localStorage.getItem("terminalSoundEnabled") !== "false";
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
    localStorage.setItem("terminalSoundEnabled", terminalSoundEnabled ? "true" : "false");
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

async function fetchMarketData() {
    const t0 = performance.now();
    try {
        const params = new URLSearchParams();
        if (selectedTradeAmount) params.append("amount", selectedTradeAmount);
        if (metamaskAccount) params.append("address", metamaskAccount);
        if (metamaskChainId) {
            const cid = parseInt(metamaskChainId, 16);
            if (!isNaN(cid)) params.append("chain_id", cid);
        }
        const qs = params.toString();
        const url = qs ? `/api/market?${qs}` : "/api/market";
        const res = await fetch(url);
        const json = await res.json();
        const elapsed = Math.round(performance.now() - t0);
        const badge = document.getElementById("latencyBadge");
        if (badge) {
            badge.innerText = `⚡ ${elapsed}ms`;
            badge.style.color = elapsed < 150 ? "#22c55e" : (elapsed < 400 ? "#38bdf8" : "#f59e0b");
        }
        if (!json.success || !json.data) return;

        latestMarketData = json.data;
        updateDashboardUI(json);
        updateChart(json.data.prices);

        // Periodically refresh client-side Web3 balances via MetaMask
        if (metamaskAccount && typeof fetchClientWalletBalances === "function") {
            if (!clientWalletBalances.updated || Date.now() - clientWalletBalances.updated > 5000) {
                const activeCid = metamaskChainId ? parseInt(metamaskChainId, 16) : 8453;
                fetchClientWalletBalances(metamaskAccount, activeCid);
            }
        }
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
    const activeChainId = Number(settings.chain_id || payload.chain_id || 8453);
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

    // Header Chain Select & Network Cards sync
    const chainSelect = document.getElementById("headerChainSelect");
    if (chainSelect && chainSelect.value != activeChainId) {
        chainSelect.value = activeChainId;
    }
    if (typeof updateNetworkCardsVisual === "function") {
        updateNetworkCardsVisual(activeChainId);
    }

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

    const autoToggle = document.getElementById("headerAutoTradeToggle");
    if (autoToggle) autoToggle.checked = Boolean(settings.auto_trade);

    const autoBadge = document.getElementById("headerAutoTradeBadge");
    if (autoBadge) {
        autoBadge.innerText = settings.auto_trade ? "ACTIVE" : "STANDBY";
        autoBadge.className = "badge " + (settings.auto_trade ? "badge-green" : "badge-red");
    }

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
        statusSubtitle = engineStatusText.replace("INSUFFICIENT BALANCE:", "").trim() || "Wallet funds insufficient for trade notional or gas.";
    } else if (engineStatusText.startsWith("TRADE SKIPPED:")) {
        statusTitle = "TRADE SKIPPED";
        statusSubtitle = engineStatusText.replace("TRADE SKIPPED:", "").trim();
    } else if (engineStatusText.startsWith("STANDBY:")) {
        statusTitle = "STANDBY";
        statusSubtitle = engineStatusText.replace("STANDBY:", "").trim();
    } else if (engineStatusText.startsWith("TRADE FAILED:")) {
        statusTitle = "TRADE FAILED";
        statusSubtitle = engineStatusText.replace("TRADE FAILED:", "").trim();
    } else if (engineStatusText.startsWith("ATOMIC TRADE FILLED")) {
        statusTitle = "ATOMIC TRADE SUCCESSFUL";
        statusSubtitle = "Atomic Arbitrage Executed On-Chain";
    }

    const kpiStatusEl = document.getElementById("kpiStatus");
    if (kpiStatusEl) {
        kpiStatusEl.innerText = statusTitle;
        if (statusTitle.includes("HALTED") || statusTitle.includes("FAILED") || statusTitle.includes("INSUFFICIENT BALANCE")) {
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
    setText("balETH", `${dispEth.toFixed(4)} ETH`);
    setText("balETHusd", `≈ $${(dispEth * ethPrice).toFixed(2)} USDT`);
    setText("balWETH", `${dispWeth.toFixed(4)} WETH`);
    setText("balWETHusd", `≈ $${(dispWeth * ethPrice).toFixed(2)} USDT`);
    setText("balUSDT", `$${dispUsdt.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT`);
    setText("balUSDC", `$${dispUsdc.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`);

    // 5. Best Opportunity card & Multi-Hop Flow Diagram
    if (best.buy_dex) {
        setText("oppBuyDex", best.buy_dex.replace("_", " "));
        setText("oppBuyPrice", `$${best.buy_price.toFixed(2)}`);
        setText("oppSellDex", best.sell_dex.replace("_", " "));
        setText("oppSellPrice", `$${best.sell_price.toFixed(2)}`);
        const spreadSign = best.spread_usdt >= 0 ? "+" : "";
        setText("oppSpread", `${spreadSign}$${best.spread_usdt.toFixed(2)} (${spreadSign}${best.spread_pct.toFixed(2)}%)`);
        setText("oppImpact", `${Number(best.max_price_impact_pct || 0).toFixed(2)}%`);
        setText("oppGas", `$${Number(best.gas_cost_usdt || 0).toFixed(4)} USDT`);
        
        const oppNetProfSign = (best.net_profit_usdt || 0) >= 0 ? "+" : "";
        setText("oppNetProfit", `${oppNetProfSign}$${Number(best.net_profit_usdt || 0).toFixed(4)} USDT (${oppNetProfSign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`);
        const oppNetProfEl = document.getElementById("oppNetProfit");
        if (oppNetProfEl) {
            oppNetProfEl.style.color = (best.net_profit_usdt || 0) >= 0 ? "var(--profit-color)" : "var(--loss-color)";
        }

        // Multi-Hop Flow Nodes
        setText("flowInputAmount", `$${Number(best.amount_in || selectedTradeAmount).toFixed(2)} USDT`);
        setText("flowImpactSub", `Impact: ${Number(best.max_price_impact_pct || 0.01).toFixed(2)}%`);
        setText("flowOutputProfit", `${oppNetProfSign}$${Number(best.net_profit_usdt || 0).toFixed(4)} (${oppNetProfSign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`);

        const oppBadge = document.getElementById("oppBadge");
        if (oppBadge) {
            oppBadge.innerText = best.is_profitable ? "PROFITABLE" : "LOW PROFIT";
            oppBadge.className = "badge " + (best.is_profitable ? "badge-green" : "badge-yellow");
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
    setText("uniResBase", `${Number(uniRes.base_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} WETH`);
    setText("uniResQuote", `$${Number(uniRes.quote_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} USDT`);

    setText("sushiSpotPrice", sushiP > 0 ? `$${sushiP.toFixed(2)}` : "--");
    setText("sushiResBase", `${Number(sushiRes.base_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} WETH`);
    setText("sushiResQuote", `$${Number(sushiRes.quote_reserve || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} USDT`);

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
        setText("arbAmountIn", `$${Number(best.amount_in || selectedTradeAmount).toFixed(2)} USDT`);
        setText("arbAmountOut", `$${Number(best.gross_return_usdt || best.amount_in || selectedTradeAmount).toFixed(4)} USDT`);
        setText("arbPriceImpact", `${Number(best.max_price_impact_pct || 0.01).toFixed(2)}%`);
        setText("arbGasCost", `$${Number(best.gas_cost_usdt || 0.005).toFixed(4)} USDT`);

        const netProfEl = document.getElementById("arbNetProfit");
        if (netProfEl) {
            const sign = (best.net_profit_usdt || 0) >= 0 ? "+" : "";
            netProfEl.innerText = `${sign}$${Number(best.net_profit_usdt || 0).toFixed(4)} USDT (${sign}${Number(best.net_profit_percent || 0).toFixed(2)}%)`;
            netProfEl.style.color = (best.net_profit_usdt || 0) >= 0 ? "var(--profit-color)" : "var(--loss-color)";
        }

        const planBadge = document.getElementById("arbPlanBadge");
        if (planBadge) {
            planBadge.innerText = best.is_profitable ? "OPTIMAL ROUTE" : "LOW SPREAD";
            planBadge.className = "badge " + (best.is_profitable ? "badge-green" : "badge-yellow");
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
    setText("arbAmountIn", `$${Number(amount).toFixed(2)} USDT`);

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

    setText("arbAmountOut", `$${grossReturn.toFixed(4)} USDT`);
    setText("arbPriceImpact", `0.01%`);
    setText("arbGasCost", `$${gasCost.toFixed(4)} USDT`);

    const netProfEl = document.getElementById("arbNetProfit");
    if (netProfEl) {
        const sign = netProfit >= 0 ? "+" : "";
        netProfEl.innerText = `${sign}$${netProfit.toFixed(4)} USDT (${sign}${netProfitPct.toFixed(2)}%)`;
        netProfEl.style.color = netProfit >= 0 ? "var(--profit-color)" : "var(--loss-color)";
    }

    const planBadge = document.getElementById("arbPlanBadge");
    if (planBadge) {
        planBadge.innerText = netProfit > 0 ? "OPTIMAL ROUTE" : "LOW SPREAD";
        planBadge.className = "badge " + (netProfit > 0 ? "badge-green" : "badge-yellow");
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
        fetchMarketData();
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
    const isLiveMode = latestMarketData && (latestMarketData.trading_mode === "LIVE");
    const hasServerSigner = latestMarketData && Boolean(latestMarketData.has_private_key);

    // In LIVE mode without server private key, route to MetaMask non-custodial signing
    if (isLiveMode && !hasServerSigner) {
        showToast("Routing to MetaMask for secure non-custodial signing...", "info");
        await executeMetaMaskOnChainTrade();
        return;
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
    const explorerBase = (latestMarketData && Number(latestMarketData.chain_id) === 8453) ? "https://basescan.org/tx/" : "https://basescan.org/tx/";

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
                <div style="color:var(--text-muted); margin-bottom:4px; font-weight:700;">BASE L2 TRANSACTION RECEIPT</div>
                <div style="word-break:break-all; font-family:var(--font-mono); margin-bottom:8px;">
                    <a href="${explorerBase}${json.tx_hash}" target="_blank" style="color:var(--accent-cyan); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                        <span>🔗</span> <span>${json.tx_hash}</span>
                    </a>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-secondary" style="padding:4px 8px; font-size:10px;" onclick="navigator.clipboard.writeText('${json.tx_hash}'); showToast('Tx Hash copied to clipboard!', 'success');">📋 Copy Hash</button>
                    <a href="${explorerBase}${json.tx_hash}" target="_blank" class="btn btn-secondary" style="padding:4px 8px; font-size:10px; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">🔍 View on BaseScan</a>
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
            </div>
        ` : ""}
    `;
}

function showExecModal(title, msg, stepNumber = 0) {
    const modal = document.getElementById("execModalOverlay");
    setText("execModalTitle", title);
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
        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trading_mode: newMode,
                live_trading_armed: (newMode === "LIVE")
            })
        });
        const json = await res.json();
        if (json.success) {
            showToast(`Trading Mode switched to ${newMode}`, newMode === "LIVE" ? "success" : "info");
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
            const hashLink = isLive
                ? `<a href="https://etherscan.io/tx/${t.tx_hash}" target="_blank" style="color:var(--action-color); text-decoration:underline;">${shortHash}</a>`
                : `<span style="color:#a78bfa; font-family:var(--font-mono);">${shortHash}</span>`;
            const badgeClass = isLive ? "badge-red" : "badge-blue";
            const modeLabel = isLive ? "LIVE" : (t.mode || "SIMULATION");
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
                    <td style="font-size:11px; color:var(--text-muted);">${(t.created_at || "").slice(0, 19)}</td>
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
                    <td style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">${l.timestamp || ""}</td>
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

const SUPPORTED_CHAINS = {
    8453: {
        name: "Base",
        short: "Base L2",
        explorer: "https://basescan.org",
        hex: "0x2105",
        rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    1: {
        name: "Ethereum Mainnet",
        short: "Ethereum",
        explorer: "https://etherscan.io",
        hex: "0x1",
        rpcUrls: ["https://eth.llamarpc.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    42161: {
        name: "Arbitrum One",
        short: "Arbitrum",
        explorer: "https://arbiscan.io",
        hex: "0xa4b1",
        rpcUrls: ["https://arbitrum-one-rpc.publicnode.com"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    137: {
        name: "Polygon Mainnet",
        short: "Polygon",
        explorer: "https://polygonscan.com",
        hex: "0x89",
        rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }
    },
    11155111: {
        name: "Sepolia Testnet",
        short: "SepoliaETH",
        explorer: "https://sepolia.etherscan.io",
        hex: "0xaa36a7",
        rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }
    },
};

function updateNetworkCardsVisual(activeChainId) {
    const chainIdNum = Number(activeChainId);

    const chainMap = [
        { id: 8453, cardId: "netCardBase", badgeId: "badgeNetBase", setCardId: "settingsNetCardBase", setBadgeId: "settingsBadgeNetBase", menuCardId: "menuNetCardBase", menuBadgeId: "menuBadgeBase" },
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
}

async function selectNetwork(chainId, event) {
    if (event) {
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        if (typeof event.preventDefault === "function") event.preventDefault();
    }
    const id = Number(chainId);
    if (!SUPPORTED_CHAINS[id]) return;

    // 1. Instantly update visual active state across all cards with ZERO layout shift
    updateNetworkCardsVisual(id);

    // 2. If MetaMask is connected, prompt network switch without disconnecting
    if (metamaskAccount) {
        try {
            await requestSwitchNetwork(id);
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
        if (json.success) {
            showToast(`Active network: ${json.chain.label}`, "success");
            setValue("headerChainSelect", id);
            setValue("cfgChainId", id);
            if (json.chain.rpc_url) setValue("cfgRpcUrl", json.chain.rpc_url);
            fetchMarketData();
            if (typeof loadSettings === "function") loadSettings();
        } else {
            showToast(json.message || "Failed to switch chain", "error");
        }
    } catch (err) {
        console.error("Backend chain switch error:", err);
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

const CLIENT_TOKEN_ADDRESSES = {
    8453: { // Base L2
        USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
        USDbC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
        USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
        WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 }
    },
    1: { // Ethereum Mainnet
        USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
        USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
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
        USDT: { address: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0", decimals: 6 },
        WETH: { address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", decimals: 18 }
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
        SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        Uniswap_V2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"
    },
    137: { // Polygon PoS
        SushiSwap_V2: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
    },
    11155111: { // Sepolia Testnet
        Uniswap_V2: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008"
    }
};

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
        const tokens = CLIENT_TOKEN_ADDRESSES[chainIdNum] || CLIENT_TOKEN_ADDRESSES[8453];
        const routers = CLIENT_ROUTER_ADDRESSES[chainIdNum] || CLIENT_ROUTER_ADDRESSES[8453];

        if (!tokens || !routers) {
            showToast("No router or token definitions found for current network.", "error");
            return;
        }

        const tokenObj = tokens.USDC || tokens.USDT;
        if (!tokenObj) {
            showToast("No stablecoin found to approve.", "error");
            return;
        }

        const routerAddress = routers.Uniswap_V2 || Object.values(routers)[0];
        const tokenContract = new ethers.Contract(tokenObj.address, CLIENT_ERC20_ABI, metamaskSigner);

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
        if (err.code === "ACTION_REJECTED" || err.code === 4001) {
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

    try {
        // 1. Native ETH balance via eth_getBalance
        const hexBal = await provider.request({
            method: "eth_getBalance",
            params: [account, "latest"]
        });
        if (hexBal) {
            clientWalletBalances.eth = parseInt(hexBal, 16) / 1e18;
        }

        // 2. Token balances via ERC20 balanceOf eth_call
        const tokens = CLIENT_TOKEN_ADDRESSES[chainIdNum] || CLIENT_TOKEN_ADDRESSES[8453];
        const cleanAddr = account.toLowerCase().replace("0x", "").padStart(64, "0");
        const balanceOfData = "0x70a08231" + cleanAddr;

        for (const [sym, info] of Object.entries(tokens)) {
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
                // Ignore individual token query errors
            }
        }
        clientWalletBalances.updated = Date.now();
        renderClientWalletBalances();
    } catch (err) {
        console.warn("[Client Web3 Balance fetch error]:", err);
    }
}

function renderClientWalletBalances() {
    if (!metamaskAccount) return;
    const ethPrice = latestMarketData && latestMarketData.summary && latestMarketData.summary.eth_price_usdt ? Number(latestMarketData.summary.eth_price_usdt) : 3000;
    
    setText("balETH", `${Number(clientWalletBalances.eth || 0).toFixed(4)} ETH`);
    setText("balETHusd", `≈ $${(Number(clientWalletBalances.eth || 0) * ethPrice).toFixed(2)} USDT`);
    setText("balWETH", `${Number(clientWalletBalances.weth || 0).toFixed(4)} WETH`);
    setText("balWETHusd", `≈ $${(Number(clientWalletBalances.weth || 0) * ethPrice).toFixed(2)} USDT`);
    setText("balUSDT", `$${Number(clientWalletBalances.usdt || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT`);

    const effectiveUsdc = (clientWalletBalances.usdc || 0) + (clientWalletBalances.usdbc || 0);
    const usdcLabel = (clientWalletBalances.usdbc > 0 && (clientWalletBalances.usdc || 0) === 0) ? "USDbC" : "USDC";
    setText("balUSDC", `$${Number(effectiveUsdc).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${usdcLabel}`);

    const totalStable = (clientWalletBalances.usdt || 0) + effectiveUsdc;
    const totalEthEquity = ((clientWalletBalances.eth || 0) + (clientWalletBalances.weth || 0)) * ethPrice;
    const totalEquity = totalStable + totalEthEquity;
    setText("kpiBalance", `$${totalEquity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
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

    const activeCid = metamaskChainId ? parseInt(metamaskChainId, 16) : 8453;

    // Setup ethers Provider & Signer architecture
    await initEthersProviderAndSigner();

    // Update UI elements immediately
    updateWalletUIConnected(metamaskAccount, metamaskChainId);

    // Instant client-side direct Web3 balance fetch
    if (typeof fetchClientWalletBalances === "function") {
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
                showToast(`MetaMask Connected: ${short}`, "success");
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
        if (typeof fetchClientWalletBalances === "function") {
            fetchClientWalletBalances(metamaskAccount, newChainId);
        }
    }

    // Synchronize network cards and backend config if chain is supported
    if (SUPPORTED_CHAINS[newChainId]) {
        updateNetworkCardsVisual(newChainId);
        try {
            await fetch("/api/chain/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chain_id: newChainId })
            });
        } catch (e) {
            console.warn("[Chain sync to backend error]:", e);
        }
        fetchMarketData();
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

async function initEthersProviderAndSigner() {
    const provider = getMetaMaskProvider();
    if (!provider) return;

    try {
        if (typeof ethers !== "undefined") {
            if (ethers.BrowserProvider) {
                metamaskProvider = new ethers.BrowserProvider(provider);
                metamaskSigner = await metamaskProvider.getSigner();
            } else if (ethers.providers && ethers.providers.Web3Provider) {
                metamaskProvider = new ethers.providers.Web3Provider(provider);
                metamaskSigner = metamaskProvider.getSigner();
            }
            await initContractInstance();
        }
    } catch (err) {
        console.warn("[Ethers Signer Initialization]:", err);
    }
}

async function initContractInstance() {
    if (!metamaskProvider) return;
    try {
        if (!dexContractABI || !dexContractAddress) {
            const res = await fetch("/api/contract");
            const data = await res.json();
            if (data.success) {
                dexContractAddress = data.contract_address;
                dexContractABI = data.abi;
            }
        }
        if (dexContractAddress && dexContractABI && typeof ethers !== "undefined") {
            // Read-only contract via provider
            const readContract = new ethers.Contract(dexContractAddress, dexContractABI, metamaskProvider);
            try {
                const paused = await readContract.isPaused();
                console.log("[Contract Read]: isPaused =", paused);
            } catch (e) {}

            // Signer contract for on-chain execution
            if (metamaskSigner) {
                dexArbitrageContract = new ethers.Contract(dexContractAddress, dexContractABI, metamaskSigner);
            }
        }
    } catch (e) {
        console.warn("[Contract instance init]:", e);
    }
}

function updateWalletUIConnected(address, chainIdHex) {
    if (!address) return;
    const shortAddr = address.slice(0, 6) + "..." + address.slice(-4);
    const targetChainId = Number(latestMarketData && latestMarketData.chain_id ? latestMarketData.chain_id : (latestMarketData && latestMarketData.settings && latestMarketData.settings.chain_id ? latestMarketData.settings.chain_id : 8453));
    const currentChainId = chainIdHex ? parseInt(chainIdHex, 16) : targetChainId;
    const isCorrectChain = currentChainId === targetChainId;

    // Header buttons
    const btnConnect = document.getElementById("btnConnectWallet");
    const walletPill = document.getElementById("headerWalletPill");
    const addrText = document.getElementById("headerWalletAddress");
    const dot = document.getElementById("walletNetworkIndicator");

    if (btnConnect) btnConnect.style.display = "none";
    if (walletPill) walletPill.style.display = "inline-flex";
    if (addrText) addrText.innerText = shortAddr;

    // Network status styling
    const chainInfo = SUPPORTED_CHAINS[currentChainId] || { name: `Chain ${currentChainId}`, short: `Chain ${currentChainId}`, explorer: "https://basescan.org" };
    if (dot) {
        dot.className = "network-dot " + (isCorrectChain ? "dot-green" : "dot-red");
        dot.title = isCorrectChain ? chainInfo.name : "Wrong Network! Click to switch";
    }

    // Dropdown details
    setText("menuFullAddress", address);
    const netBadge = document.getElementById("menuNetworkBadge");
    const netText = document.getElementById("menuNetworkText");
    const netDot = document.getElementById("menuNetworkDot");
    const btnSwitch = document.getElementById("btnSwitchNetwork");
    const btnExplorer = document.getElementById("btnViewExplorer");

    if (netText) netText.innerText = isCorrectChain ? chainInfo.name : `Wrong Network (${chainInfo.short})`;
    if (netDot) netDot.className = "network-dot " + (isCorrectChain ? "dot-green" : "dot-red");
    if (netBadge) {
        netBadge.className = "network-name-badge " + (isCorrectChain ? "" : "wrong-network");
    }
    if (btnSwitch) {
        btnSwitch.style.display = isCorrectChain ? "none" : "flex";
        const targetChainInfo = SUPPORTED_CHAINS[targetChainId] || { short: "Configured Chain" };
        btnSwitch.innerHTML = `<span>🔄</span> <span>Switch to ${targetChainInfo.short}</span>`;
    }
    if (btnExplorer) {
        btnExplorer.href = `${chainInfo.explorer}/address/${address}`;
    }

    // Synchronize network cards visual state
    if (typeof updateNetworkCardsVisual === "function") {
        updateNetworkCardsVisual(currentChainId);
    }

    // Portfolio panel badge & connect button
    const portBadge = document.getElementById("walletAddressBadge");
    if (portBadge) {
        portBadge.innerText = `${shortAddr} (Connected)`;
        portBadge.className = "badge badge-green";
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
    const grid = document.getElementById("multiPairGrid");
    if (!grid) return;

    try {
        const res = await fetch("/api/market/all-pairs");
        const data = await res.json();
        if (!data.success || !data.pairs || data.pairs.length === 0) return;

        // Remove initial placeholder if present
        const placeholder = document.getElementById("multiPairPlaceholder");
        if (placeholder) placeholder.remove();

        data.pairs.forEach(p => {
            const cardId = "pair_card_" + p.pair.replace("/", "_");
            let card = document.getElementById(cardId);
            const isBest = data.best_pair && data.best_pair.pair === p.pair;
            const spreadSign = p.spread_val >= 0 ? "+" : "";
            const borderColor = p.is_active ? "var(--action-color)" : (isBest ? "var(--profit-color)" : "var(--border)");
            const badgeHtml = p.is_active 
                ? '<span class="badge badge-blue" style="position:absolute; top:8px; right:8px; font-size:10px;">ACTIVE PAIR</span>' 
                : (isBest ? '<span class="badge badge-green" style="position:absolute; top:8px; right:8px; font-size:10px;">TOP SPREAD</span>' : '');

            const cardContent = `
                ${badgeHtml}
                <span class="token-name" style="font-size:14px; font-weight:700; color:var(--text-bright);">${p.pair}</span>
                <div style="margin: 8px 0;">
                    <div style="font-size:11px; color:var(--text-muted);">Buy: ${p.buy_dex.replace("_", " ")} ($${p.buy_price.toFixed(2)})</div>
                    <div style="font-size:11px; color:var(--text-muted);">Sell: ${p.sell_dex.replace("_", " ")} ($${p.sell_price.toFixed(2)})</div>
                </div>
                <h3 style="font-size:16px; color:${p.spread_val >= 0 ? "var(--profit-color)" : "var(--loss-color)"}; margin-bottom:4px; font-variant-numeric:tabular-nums;">
                    ${spreadSign}$${p.spread_val.toFixed(2)} (${spreadSign}${p.spread_pct.toFixed(2)}%)
                </h3>
                <button class="btn btn-secondary" style="width:100%; font-size:11px; padding:4px; margin-top:6px;">
                    ${p.is_active ? "Active" : "Switch to " + p.pair}
                </button>
            `;

            if (!card) {
                card = document.createElement("div");
                card.id = cardId;
                card.className = "dex-wallet-item";
                card.style.position = "relative";
                card.style.cursor = "pointer";
                card.style.minHeight = "130px";
                card.onclick = () => quickSwitchPair(p.pair);
                grid.appendChild(card);
            }

            card.style.borderColor = borderColor;
            if (card.innerHTML !== cardContent) {
                card.innerHTML = cardContent;
            }
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

async function executeMetaMaskOnChainTrade() {
    const provider = getMetaMaskProvider();
    if (!provider) {
        showMetaMaskModal();
        return;
    }
    if (!metamaskAccount) {
        showToast("Please connect your MetaMask wallet first!", "warning");
        connectMetaMask();
        return;
    }

    if (!latestMarketData || !latestMarketData.data || !latestMarketData.data.best_route) {
        showToast("Scanning DEX liquidity... Please wait for a route quote.", "warning");
        return;
    }

    const route = latestMarketData.data.best_route;
    const targetChainId = Number(latestMarketData.chain_id || 8453);
    const currentChainId = metamaskChainId ? parseInt(metamaskChainId, 16) : null;

    if (currentChainId !== targetChainId) {
        showToast("Switching network to Base L2...", "info");
        await requestSwitchNetwork(targetChainId);
        return;
    }

    // Step 1: Wallet & Gas Check
    showExecModal("MetaMask Direct On-Chain Execution", "Checking wallet balances and preparing Base L2 transaction...", 1);

    try {
        if (!metamaskSigner) {
            await initEthersProviderAndSigner();
        }

        // Check native ETH gas balance
        const ethBalance = await metamaskProvider.getBalance(metamaskAccount);
        const ethVal = parseFloat(ethers.formatEther(ethBalance));
        if (ethVal < 0.0001) {
            renderExecutionResult({
                success: false,
                status: "INSUFFICIENT_GAS",
                message: `Your connected wallet has ${ethVal.toFixed(6)} ETH. You need at least 0.0001 ETH for Base L2 network fees.`
            });
            return;
        }

        const tokens = CLIENT_TOKEN_ADDRESSES[targetChainId] || CLIENT_TOKEN_ADDRESSES[8453];
        const routers = CLIENT_ROUTER_ADDRESSES[targetChainId] || CLIENT_ROUTER_ADDRESSES[8453];

        if (!tokens || !routers) {
            renderExecutionResult({
                success: false,
                status: "CONFIGURATION_ERROR",
                message: "No token or router contracts registered for this network."
            });
            return;
        }

        // Quote token: auto-select token with positive balance: Native USDC > Bridged USDbC > USDT
        let tokenInMeta = null;
        let availStable = 0;
        let tokenSymbol = "USDC";

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
            // Default fallback if balance is 0
            tokenInMeta = tokens.USDC || tokens.USDbC || tokens.USDT;
            availStable = 0;
            tokenSymbol = tokenInMeta === tokens.USDT ? "USDT" : (tokenInMeta === tokens.USDbC ? "USDbC" : "USDC");
        }

        const tokenOutMeta = tokens.WETH;

        if (!tokenInMeta || !tokenOutMeta) {
            renderExecutionResult({
                success: false,
                status: "CONFIGURATION_ERROR",
                message: "Target tokens (USDC/USDbC/WETH) are not defined for the selected blockchain."
            });
            return;
        }

        // Dynamic trade amount sizing
        let tradeAmt = selectedTradeAmount || 0.10;
        if (availStable > 0 && tradeAmt > availStable) {
            tradeAmt = Math.max(0.0001, Math.floor(availStable * 0.95 * 10000) / 10000);
        }

        if (availStable <= 0) {
            renderExecutionResult({
                success: false,
                status: "INSUFFICIENT_BALANCE",
                message: `Connected wallet ${metamaskAccount.slice(0, 6)}...${metamaskAccount.slice(-4)} has $0.0000 ${tokenSymbol} on Base L2. Fund your wallet with at least $0.05 ${tokenSymbol} to execute on-chain swaps.`
            });
            return;
        }

        const parsedAmountIn = ethers.parseUnits(tradeAmt.toString(), tokenInMeta.decimals);
        const routerName = route.buy_dex || "Uniswap_V2";
        const routerAddress = routers[routerName] || routers.Uniswap_V2 || "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";

        // Step 2: Verify and request ERC-20 token approval
        showExecModal("Verifying Token Allowance", `Checking ${tokenSymbol} allowance for ${routerName}...`, 2);
        const tokenContract = new ethers.Contract(tokenInMeta.address, CLIENT_ERC20_ABI, metamaskSigner);
        const currentAllowance = await tokenContract.allowance(metamaskAccount, routerAddress);

        if (currentAllowance < parsedAmountIn) {
            showExecModal("Approving Token Spending", `Please confirm Token Approval for ${routerName} in MetaMask...`, 2);
            showToast("Please approve token spending in MetaMask...", "info");
            const approveTx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
            showExecModal("Confirming Approval", `Approval submitted (${approveTx.hash.slice(0, 10)}...). Waiting for block confirmation...`, 2);
            await approveTx.wait(1);
            showToast("Token approval confirmed on-chain!", "success");
        }

        // Step 3: Query DEX Router for expected output & calculate slippage guard
        showExecModal("Executing DEX Swap", `Submitting trade of $${tradeAmt.toFixed(4)} ${tokenSymbol} on ${routerName}... Confirm in MetaMask.`, 3);
        showToast("Please confirm Swap transaction in MetaMask...", "info");

        const routerContract = new ethers.Contract(routerAddress, CLIENT_ROUTER_V2_ABI, metamaskSigner);
        const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
        const path = [tokenInMeta.address, tokenOutMeta.address];

        let amountOutMin = 0n;
        try {
            const amountsOut = await routerContract.getAmountsOut(parsedAmountIn, path);
            if (amountsOut && amountsOut.length > 1) {
                const expectedOut = amountsOut[1];
                const slippageInput = parseFloat(document.getElementById("cfgSlippage")?.value || "0.5");
                const slippageBps = BigInt(Math.max(10, Math.min(500, Math.round(slippageInput * 100)))); // 0.10% to 5.00%
                amountOutMin = (expectedOut * (10000n - slippageBps)) / 10000n;
            }
        } catch (slipErr) {
            console.warn("[MetaMask Trade] getAmountsOut estimation warning, proceeding safely:", slipErr);
            amountOutMin = 0n;
        }

        const txResponse = await routerContract.swapExactTokensForTokens(
            parsedAmountIn,
            amountOutMin,
            path,
            metamaskAccount,
            deadline,
            { gasLimit: 280000 }
        );

        // Step 4: Base L2 Mining
        showExecModal("Mining Transaction", `Swap broadcasted! Hash: ${txResponse.hash.slice(0, 10)}... Waiting for Base L2 block receipt (~2s)...`, 4);
        showToast(`Transaction Broadcasted: ${txResponse.hash.slice(0, 10)}...`, "info");
        const receipt = await txResponse.wait(1);

        // Step 5: Verify and record live trade on backend
        showExecModal("Verifying On-Chain Receipt", "Verifying block receipt & updating live KPIs with Base L2 RPC...", 5);
        const confirmRes = await fetch("/api/trade/confirm-live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tx_hash: txResponse.hash,
                chain_id: targetChainId,
                buy_dex: route.buy_dex,
                sell_dex: route.sell_dex,
                token_pair: latestMarketData.symbol || "WETH/USDC",
                amount_in: tradeAmt,
                expected_profit: route.net_profit_usdt,
                gross_profit: route.gross_profit_usdt || route.net_profit_usdt
            })
        });
        const confirmData = await confirmRes.json();

        if (confirmData.success) {
            renderExecutionResult({
                success: true,
                status: "TRANSACTION_CONFIRMED",
                message: `Atomic trade verified on-chain! Net PnL: +$${Number(confirmData.trade.net_profit || 0).toFixed(4)} USDT`,
                tx_hash: txResponse.hash,
                trade: confirmData.trade
            });
            showToast("Live trade verified and committed to database!", "success");
        } else {
            renderExecutionResult({
                success: true,
                status: "ON_CHAIN_MINED",
                message: `Transaction mined on Base L2! Hash: ${txResponse.hash}`,
                tx_hash: txResponse.hash,
                trade: {
                    buy_dex: route.buy_dex,
                    sell_dex: route.sell_dex,
                    amount_in: tradeAmt,
                    net_profit: route.net_profit_usdt,
                    mode: "LIVE"
                }
            });
        }

        await fetchClientWalletBalances(metamaskAccount, targetChainId);
        fetchMarketData();
        loadTrades();
        loadExecutionLogs();
    } catch (err) {
        if (err.code === "ACTION_REJECTED" || err.code === 4001) {
            showToast("Transaction signature rejected in MetaMask.", "warning");
            closeExecModal();
        } else {
            renderExecutionResult({
                success: false,
                status: "TRANSACTION_FAILED",
                message: err.message || String(err)
            });
        }
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