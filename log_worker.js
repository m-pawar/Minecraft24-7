const fs = require('fs');
const path = require('path');

// Ensure 'logs' folder exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Get current hourly log filename
function getLogFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    return path.join(logsDir, `${year}-${month}-${day}_${hour}.log`);
}

// Write log entry to current hourly file
function writeLog(message, type = 'INFO') {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const logMessage = `[${timestamp}] [${type}] ${message}`;
    const logFile = getLogFileName();

    try {
        fs.appendFileSync(logFile, logMessage + '\n');
        // Optional DEBUG
        // console.log(`[LOG_WORKER] Wrote to ${logFile}`);
    } catch (err) {
        console.error('Failed to write log:', err);
    }
}

// Listen for messages from parent process
process.on('message', (data) => {
    if (data && data.message) {
        writeLog(String(data.message), data.type || 'INFO');
    }
});

// Notify parent that worker is ready
if (process.send) process.send('ready');
