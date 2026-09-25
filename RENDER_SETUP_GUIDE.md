# Render.com 24/7 Hosting Setup Guide

This guide walks you through deploying the DEX Arbitrage Bot to Render.com so it trades 24/7 autonomously using a single dedicated server wallet without needing any browser window open.

---

## Step 1: Create a Dedicated Trading Wallet
1. In MetaMask, click your account icon and choose **"Add account or hardware wallet"** -> **"Add a new account"** (e.g. name it `Render-Trading-Bot`).
2. Click **Account details** -> **"Show private key"**, type your password, and copy the private key string.
3. Copy your wallet's public address (e.g. `0x1234...`).
4. **Fund this dedicated wallet on Base Network**:
   - **Gas**: Send ~\$2 to \$5 worth of **ETH** on Base (gas fees on Base L2 are typically < \$0.005 per transaction).
   - **Trade Capital**: Send **USDT** or **USDC** (e.g. \$10 to \$50) on Base.

---

## Step 2: Deploy on Render.com
1. Go to [https://dashboard.render.com](https://dashboard.render.com).
2. Click **"New +"** in the top right -> choose **"Blueprint"** (or **"Web Service"**).
3. Connect your GitHub repository: `Testing-Bot` (or `krishnas0727/Testing-Bot`).
4. Render will read `render.yaml` automatically.
5. In the Environment configuration screen, Render will prompt you for the uncommitted secrets:
   - `WALLET_ADDRESS`: Paste your dedicated bot wallet address.
   - `PRIVATE_KEY`: Paste your exported private key (without sharing with anyone).
6. Click **"Apply"** or **"Create Web Service"**.
7. Wait ~2-3 minutes for the build and deployment to finish. Render will provide a live URL like:
   `https://dex-arbitrage-bot-xxxx.onrender.com`

---

## Step 3: Keep It Awake 24/7 (Prevent Free Tier Sleep)
Render's Free Web Service spins down to save resources if no HTTP requests arrive for 15 minutes. To ensure the background trading engine runs uninterrupted 24/7:

1. Go to [https://uptimerobot.com](https://uptimerobot.com) (100% Free).
2. Create an account and click **"Add New Monitor"**.
3. Configure the monitor:
   - **Monitor Type**: `HTTP(s)`
   - **Friendly Name**: `DEX Arbitrage Bot Health`
   - **URL (or IP)**: `https://<YOUR-RENDER-APP-NAME>.onrender.com/api/health`
   - **Monitoring Interval**: `Every 5 minutes`
4. Click **"Create Monitor"**.
5. UptimeRobot will ping `/api/health` every 5 minutes, preventing Render from going to sleep. Your background bot will trade 24/7!

---

## Step 4: Verification & Live Monitoring
1. Open your Render app URL in any mobile browser or desktop browser:
   `https://<YOUR-RENDER-APP-NAME>.onrender.com`
2. You will see:
   - **SECURITY & WEB3 EXECUTION DOCK**: Displays active network, Kill Switch, and MEV Shield.
   - **Live Opportunities & Latency Audit**: Real-time prices from Uniswap V2 and SushiSwap V2.
   - **Live Trades**: All simulated or executed on-chain trades logged with transaction hashes and net profit.
3. To stop trading at any time, click the **Kill Switch (Normal)** button in the header or set `EMERGENCY_STOP=true` in Render.
