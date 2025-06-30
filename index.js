console.log('index.js started'); // DEBUG: index.js script started
const mineflayer = require("mineflayer")
const fs = require('fs')
const https = require('https')
const http = require('http')

let bot = null;
let reconnectAttempts = 0;
let isConnecting = false;
let reconnectTimeout = null;
let keepAliveInterval = null;
let lastSuccessfulConnection = null;
let escalationTimeout = null;
let lastDisconnectTime = null;

// Logger proxy
function sendLog(message, type = 'INFO') {
    const payload = JSON.stringify({ message, type });
    const options = {
        hostname: 'localhost',
        port: 6969,
        path: '/log',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 1000 // 1 second timeout for quick fallback
    };
    const req = http.request(options, res => {
        // DEBUG: Log response status
        // console.log('sendLog response status:', res.statusCode);
    });
    req.on('error', (err) => {
        // Fallback to console.log if logger server is not available
        console.log(`[FALLBACK LOG] [${type}] ${message}`);
    });
    req.on('timeout', () => {
        req.abort();
        console.log(`[FALLBACK LOG] [${type}] ${message}`);
    });
    req.write(payload);
    req.end();
}

// Webhook notification
function sendWebhookNotification(title, message, isError = false, isEscalated = false) {
    let notificationConfig;
    try {
        notificationConfig = JSON.parse(fs.readFileSync('notification_config.json', 'utf8'));
    } catch (error) {
        sendLog('Failed to load notification config: ' + error.message, 'ERROR');
        return;
    }

    if (!notificationConfig.notifications_enabled) return;

    const targetWebhook = isEscalated ? notificationConfig.escalated_webhook_url : notificationConfig.webhook_url;
    if (!targetWebhook) return;

    const color = isEscalated ? 16711680 : (isError ? 15158332 : 3066993);

    const payload = JSON.stringify({
        embeds: [{
            title: isEscalated ? `🚨 ${title}` : title,
            description: (isEscalated ? '🚨 ESCALATED ALERT 🚨\n' : '') + message,
            color: color,
            timestamp: new Date().toISOString(),
            fields: [
                { name: "Bot Name", value: bot ? bot.username : "Unknown", inline: true },
                { name: "Reconnect Attempts", value: reconnectAttempts.toString(), inline: true },
                { name: "Alert Type", value: isEscalated ? "ESCALATED" : "NORMAL", inline: true }
            ]
        }]
    });

    const url = new URL(targetWebhook);
    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = (url.protocol === 'https:' ? https : http).request(options, res => {
        sendLog(`Notification sent (${res.statusCode})`, 'NOTIFICATION');
    });

    req.on('error', err => {
        sendLog(`Failed to send notification: ${err.message}`, 'ERROR');
    });

    req.write(payload);
    req.end();
}

function sendStatusNotification(message, isError = false, isEscalated = false) {
    const timestamp = new Date().toLocaleString();
    const status = isEscalated ? '🚨 ESCALATED BOT ALERT' : (isError ? '❌ BOT ERROR' : '✅ BOT STATUS');
    sendLog(message, isEscalated ? 'ESCALATED' : (isError ? 'ERROR' : 'STATUS'));
    sendWebhookNotification(status, `${message}\n\nTime: ${timestamp}`, isError, isEscalated);
}

function scheduleEscalatedAlert() {
    if (escalationTimeout) clearTimeout(escalationTimeout);

    escalationTimeout = setTimeout(() => {
        if (!bot || !bot.entity) {
            sendStatusNotification(`Bot has been disconnected for over 1 minute!\nReconnection attempts: ${reconnectAttempts}`, true, true);
            const repeatingAlert = setInterval(() => {
                if (!bot || !bot.entity) {
                    sendStatusNotification(`Bot still disconnected after ${Math.floor((Date.now() - new Date(lastDisconnectTime).getTime()) / 60000)} minutes!\nReconnection attempts: ${reconnectAttempts}`, true, true);
                } else {
                    clearInterval(repeatingAlert);
                }
            }, 300000);
        }
    }, 60000);
}

function cleanup() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (bot) {
        bot.removeAllListeners();
        if (bot.socket && !bot.socket.destroyed) bot.end();
        bot = null;
    }
    isConnecting = false;
}

function scheduleReconnect(reason = '') {
    if (isConnecting) {
        sendLog('Already attempting to connect, skipping...', 'WARNING');
        return;
    }

    if (reconnectAttempts === 0) {
        lastDisconnectTime = new Date().toISOString();
        scheduleEscalatedAlert();
    }

    const delay = 5000;
    reconnectAttempts++;
    sendStatusNotification(`Bot disconnected: ${reason}\nReconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts})`, true);
    reconnectTimeout = setTimeout(startBot, delay);
}

function startKeepAlive() {
    keepAliveInterval = setInterval(() => {
        if (bot && bot.entity) {
            const actions = ['jump', 'sneak', 'sprint'];
            const action = actions[Math.floor(Math.random() * actions.length)];
            bot.setControlState(action, true);
            setTimeout(() => bot && bot.setControlState(action, false), 200);
        }
    }, 5000);
}

function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    let config;
    try {
        config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    } catch (err) {
        sendLog('Failed to read config: ' + err.message, 'ERROR');
        return;
    }

    bot = mineflayer.createBot({
        host: config.ip,
        port: parseInt(config.port),
        username: config.name,
        version: config.version || '1.16.5',
        auth: 'offline',
        checkTimeoutInterval: 30000,
        keepAlive: true,
        timeout: 30000
    });

    bot.on('spawn', () => {
        const isConnected = bot._client && bot._client.socket && !bot._client.socket.destroyed;
        if (!isConnected) {
            const msg = '⚠️ Bot triggered spawn, but socket is invalid. Server might be offline.';
            sendLog(msg, 'ERROR');
            sendStatusNotification('❌ Server appears to be offline or unreachable.', true, true);
            cleanup();
            scheduleReconnect('Server offline or invalid socket');
            return;
        }

        lastSuccessfulConnection = new Date();
        sendLog('✅ Bot successfully connected and spawned!', 'SUCCESS');
        if (escalationTimeout) clearTimeout(escalationTimeout);
        if (reconnectAttempts > 0) sendStatusNotification(`✅ Bot reconnected after ${reconnectAttempts} attempts.`, false);
        reconnectAttempts = 0;
        lastDisconnectTime = null;
        isConnecting = false;

        if (config.loginmsg) bot.chat(config.loginmsg);
        startKeepAlive();
    });

    bot.on('login', () => sendLog('Bot logged in!', 'LOGIN'));

    bot.on('health', () => {
        if (bot.food < 18) {
            const food = bot.inventory.items().find(item =>
                item.name.includes('bread') || item.name.includes('apple') ||
                item.name.includes('carrot') || item.name.includes('potato'));
            if (food) {
                bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
            }
        }
    });

    bot.on('end', reason => {
        sendLog(`Disconnected: ${reason}`, 'ERROR');
        cleanup();
        scheduleReconnect('Connection ended');
    });

    bot.on('disconnect', packet => {
        sendLog(`Disconnect packet: ${JSON.stringify(packet)}`, 'ERROR');
        cleanup();
        scheduleReconnect('Disconnect packet');
    });

    bot.on('kicked', reason => {
        sendLog(`Kicked: ${JSON.stringify(reason)}`, 'ERROR');
        const reasonStr = JSON.stringify(reason).toLowerCase();
        if (reasonStr.includes('banned') || reasonStr.includes('permanent') || reasonStr.includes('ban')) {
            sendStatusNotification('❌ Bot permanently banned. Stopping reconnect.', true);
            cleanup();
        } else {
            cleanup();
            scheduleReconnect('Kicked');
        }
    });

    bot.on('error', error => {
        const errStr = error.message.toLowerCase();
        sendLog(`Bot error: ${error.message}`, 'ERROR');
        if (errStr.includes('banned') || errStr.includes('blacklist')) {
            sendStatusNotification('❌ Ban-related error. Stopping reconnect.', true);
            cleanup();
        } else {
            cleanup();
            scheduleReconnect('Bot error');
        }
    });

    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        if (message.toLowerCase().includes(bot.username.toLowerCase())) {
            setTimeout(() => bot.chat('I am active and monitoring the server!'), 1000 + Math.random() * 2000);
        }
    });
}

process.on('SIGINT', () => {
    sendLog('SIGINT received, shutting down.', 'SHUTDOWN');
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    sendLog('SIGTERM received, shutting down.', 'SHUTDOWN');
    cleanup();
    process.exit(0);
});

process.on('uncaughtException', err => {
    sendLog(`Uncaught exception: ${err.message}`, 'ERROR');
    cleanup();
    scheduleReconnect('Uncaught exception');
});

process.on('unhandledRejection', (reason, promise) => {
    sendLog(`Unhandled rejection: ${reason}`, 'ERROR');
    cleanup();
    scheduleReconnect('Unhandled rejection');
});

startBot();
