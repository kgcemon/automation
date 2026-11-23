const { DateTime } = require('luxon');

const ts = () => DateTime.now().setZone('Asia/Dhaka').toFormat('yyyy-MM-dd HH:mm:ss');
const out = (level, fn) => (...args) => fn(`[${ts()}] ${level}`, ...args);

module.exports = {
    info: out('INFO ', console.log),
    warn: out('WARN ', console.warn),
    error: out('ERROR', console.error),
};
