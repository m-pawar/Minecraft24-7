const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, fork } = require('child_process');

console.log('logger.js started');

// Ensure 'logs' folder exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Fork log worker
const logWorker = fork(path.join(__dirname, 'log_worker.js'));

let logWorkerReady = false;
logWorker.on('message', (msg) => {
    if (msg === 'ready') {
        logWorkerReady = true;
        console.log('[LOGGER] Log worker is ready');
    }
});

function fallbackLog(message, type = 'INFO') {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const logMessage = `[${timestamp}] [${type}] ${message}`;
    const filename = path.join(logsDir, `${timestamp.slice(0, 10).replace(/\//g, '-')}_fallback.log`);
    fs.appendFileSync(filename, logMessage + '\n');
    console.log('[FALLBACK LOG]', logMessage);
}

function log(message, type = 'INFO') {
    if (logWorkerReady) {
        logWorker.send({ message, type });
    } else {
        fallbackLog(message, type);
    }
}

// Log file cleanup: delete logs older than 7 days
function cleanupOldLogs(days = 7) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    fs.readdir(logsDir, (err, files) => {
        if (err) return console.error('[LOGGER] Failed to read logs directory:', err);
        files.forEach(file => {
            const filePath = path.join(logsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (stats.isFile() && stats.mtimeMs < cutoff) {
                    fs.unlink(filePath, err => {
                        if (!err) console.log('[LOGGER] Deleted old log file:', filePath);
                    });
                }
            });
        });
    });
}

// Call log cleanup on startup
cleanupOldLogs();

// HTTP server to receive logs from bot
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { message, type } = JSON.parse(body);
                log(message, type);
                res.end('OK');
            } catch (err) {
                fallbackLog('Invalid log payload: ' + err.message, 'ERROR');
                res.statusCode = 400;
                res.end('Bad Request');
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(6969, () => {
    log('Logger started on port 6969', 'INIT');
    let restarting = false;
    function startBot() {
        if (restarting) return;
        const botProcess = spawn('node', ['index.js'], {
            stdio: 'inherit',
        });
        botProcess.on('exit', (code, signal) => {
            log(`Bot process exited with code ${code}, signal ${signal}`, 'BOT');
            if (!restarting) {
                restarting = true;
                log('Restarting bot in 5 seconds...', 'BOT');
                setTimeout(() => {
                    restarting = false;
                    startBot();
                }, 5000);
            }
        });
        botProcess.on('error', (err) => {
            log(`Bot process failed to start: ${err.message}`, 'ERROR');
        });
    }
    startBot();
});
