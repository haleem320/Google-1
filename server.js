/**
 * 🤖 Advanced Automated MEXC Futures Bot
 * 📈 Strategy: EMA 50/200 + MACD + ATR
 * 🛡️ Security System: Open Position Check + Automated Exchange-Side SL/TP
 * 💵 Risk Management: 5 USDT Margin with 12x Leverage (Total Position Value: 60 USDT)
 */

const axios = require('axios');
const crypto = require('crypto');

// 🔐 Load sensitive API credentials securely via Railway Environment Variables
const API_KEY = process.env.MEXC_API_KEY;
const SECRET_KEY = process.env.MEXC_SECRET_KEY;
const BASE_URL = "https://mexc.com"; // Live production endpoint

const SYMBOL = "BTC_USDT"; 
const LEVERAGE = 12;         // ⚡ 12x Leverage
const POSITION_VALUE = 60;   // 📊 60 USDT Total Position Value (5 USDT Margin * 12)

if (!API_KEY || !SECRET_KEY) {
    console.error("❌ Error: Please configure MEXC_API_KEY and MEXC_SECRET_KEY variables in Railway!");
    process.exit(1);
}

// 🛡️ Function to generate secure HMAC SHA256 Digital Signature
function generateSignature(timestamp, method, requestPath, queryString = "", body = "") {
    const message = timestamp + method + requestPath + queryString + body;
    return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex');
}

// 🌐 Secure wrapper function to transmit private API requests to the exchange
async function sendPrivateRequest(method, path, data = {}) {
    const timestamp = Date.now().toString();
    let body = method === "POST" ? JSON.stringify(data) : "";
    let query = method === "GET" ? new URLSearchParams(data).toString() : "";
    
    const signature = generateSignature(timestamp, method, path, query, body);
    const url = BASE_URL + path + (query ? "?" + query : "");

    try {
        const response = await axios({
            method: method,
            url: url,
            data: method === "POST" ? body : null,
            headers: {
                'MX-API-KEY': API_KEY,
                'Request-Time': timestamp,
                'Signature': signature,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Error in private API request (${path}):`, error.response ? error.response.data : error.message);
        return null;
    }
}

// 🔍 Security Check: Verify if there is already an active open position for the symbol
async function hasOpenPosition() {
    const path = "/api/v1/private/position/open_positions";
    const result = await sendPrivateRequest("GET", path, { symbol: SYMBOL });
    
    if (result && result.success && result.data && result.data.length > 0) {
        const position = result.data.find(p => p.symbol === SYMBOL);
        if (position && parseFloat(position.holdVol) > 0) {
            return true;
        }
    }
    return false;
}

// 📊 Fetch market candle data and calculate Technical Indicators
async function getMarketIndicators() {
    const path = "/api/v1/contract/kline/" + SYMBOL;
    const params = { interval: "Min15", limit: 300 }; 
    
    try {
        const url = BASE_URL + path + "?" + new URLSearchParams(params).toString();
        const response = await axios.get(url);
        if (!response.data || !response.data.success) return null;
        
        const klines = response.data.data;
        const closePrices = klines.map(k => parseFloat(k.close));

        const calculateEMA = (prices, period) => {
            let k = 2 / (period + 1);
            let ema = prices[0];
            for (let i = 1; i < prices.length; i++) {
                ema = prices[i] * k + ema * (1 - k);
            }
            return ema;
        };

        const ema50 = calculateEMA(closePrices, 50);
        const ema200 = calculateEMA(closePrices, 200);

        const ema12 = calculateEMA(closePrices, 12);
        const ema26 = calculateEMA(closePrices, 26);
        const macdLine = ema12 - ema26;
        const signalLine = calculateEMA([macdLine], 9); 

        let totalRange = 0;
        for (let i = klines.length - 14; i < klines.length; i++) {
            totalRange += (parseFloat(klines[i].high) - parseFloat(klines[i].low));
        }
        const atr = totalRange / 14;
        const currentPrice = closePrices[closePrices.length - 1];

        return { currentPrice, ema50, ema200, macdLine, signalLine, atr };
    } catch (error) {
        console.error("❌ Error fetching market indicators:", error.message);
        return null;
    }
}

// ⚡ Execute Trading Strategy and calculate exact dynamic order volume
async function executeStrategy() {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] Analyzing market conditions...`);
    
    // 🛡️ Security Check: Prevent over-exposure by avoiding duplicate positions
    const isBusy = await hasOpenPosition();
    if (isBusy) {
        console.log("⏳ An active BTC position already exists in your account. Skipping new order entry.");
        return;
    }

    const data = await getMarketIndicators();
    if (!data) return;

    const { currentPrice, ema50, ema200, macdLine, signalLine, atr } = data;

    const isBullishTrend = currentPrice > ema200 && ema50 > ema200;
    const isBearishTrend = currentPrice < ema200 && ema50 < ema200;

    // Dynamically calculate exact volume (Vol) to match precisely a 60 USDT contract value
    let calculatedVol = (POSITION_VALUE / currentPrice).toFixed(4); 
    const stopLossDistance = atr * 1.5; // Stop-Loss safety cushion based on 1.5x ATR volatility

    // ↗️ LONG Entry Trigger Conditions
    if (isBullishTrend && macdLine > signalLine) {
        const stopLossPrice = (currentPrice - stopLossDistance).toFixed(2);
        const takeProfitPrice = (currentPrice + (stopLossDistance * 1.5)).toFixed(2);

        console.log(`🚀 Triggering LONG position. Volume: ${calculatedVol} | SL: ${stopLossPrice} | TP: ${takeProfitPrice}`);
        
        const orderData = {
            symbol: SYMBOL,
            price: "0", 
            vol: calculatedVol, 
            leverage: LEVERAGE,
            side: 1,      // 1 = Long
            type: 1,      // 1 = Market Order
            openType: 1,  // 1 = Isolated Margin (Caps maximum risk to the 5 USDT margin entry)
            stopLoss: stopLossPrice,      // 🛡️ Attaches automated stop-loss directly to the exchange server
            takeProfit: takeProfitPrice   // 🛡️ Attaches automated take-profit directly to the exchange server
        };

        await sendPrivateRequest("POST", "/api/v1/private/order/submit", orderData);
    } 
    // ↘️ SHORT Entry Trigger Conditions
    else if (isBearishTrend && macdLine < signalLine) {
        const stopLossPrice = (currentPrice + stopLossDistance).toFixed(2);
        const takeProfitPrice = (currentPrice - (stopLossDistance * 1.5)).toFixed(2);

        console.log(`📉 Triggering SHORT position. Volume: ${calculatedVol} | SL: ${stopLossPrice} | TP: ${takeProfitPrice}`);
        
        const orderData = {
            symbol: SYMBOL,
            price: "0",
            vol: calculatedVol,
            leverage: LEVERAGE,
            side: 3,      // 3 = Short
            type: 1,
            openType: 1,
            stopLoss: stopLossPrice,      
            takeProfit: takeProfitPrice   
        };

        await sendPrivateRequest("POST", "/api/v1/private/order/submit", orderData);
    } else {
        console.log("⏳ Neutral market condition. Waiting for clear signal confluence...");
    }
}

// Bot automated execution cycle set to monitor the market once every 5 minutes
setInterval(executeStrategy, 5 * 60 * 1000);
executeStrategy(); // Initial instant execution on startup

// Basic internal HTTP webserver required to prevent Railway from crashing due to port binding timeouts
const http = require('http');
http.createServer((req, res) => { res.end("🤖 Trading Bot is Online and Operating!"); }).listen(process.env.PORT || 3000);
