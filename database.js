const { DateTime } = require('luxon');
const sqlite3 = require('sqlite3').verbose();

const DBSOURCE = "database.db";

const db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
        console.error(err.message);
        throw err;
    } else {
        console.log('Connected to SQLite database');
    }
});

function getCurrentTime() {
    return DateTime.now().setZone('Asia/Dhaka').toFormat('yyyy-MM-dd HH:mm:ss');
}

const addTransaction = async (uid, status, message) => {
    const currentTime = getCurrentTime();
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO transactions (uid, status, message, created, updated) VALUES (?, ?, ?, ?, ?)`;
        db.run(sql, [uid, status, message, currentTime, currentTime], function(err) {
            if (err) {
                reject(err.message);
            } else {
                resolve(this.lastID);
            }
        });
    });
};

const updateTransaction = async (uid, status, message, extra) => {
    const currentTime = getCurrentTime();
    return new Promise((resolve, reject) => {
        const sql = `UPDATE transactions SET status = ?, message = ?, extra = ?, updated = ? WHERE uid = ?`;
        db.run(sql, [status, message, extra, currentTime, uid], function(err) {
            if (err) {
                reject(err.message);
            } else {
                resolve(this.changes);
            }
        });
    });
};

const findTransaction = async (uid) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM transactions WHERE uid = ?`;
        db.get(sql, [uid], (err, row) => {
            if (err) {
                reject(err.message);
            } else {
                resolve(row);
            }
        });
    });
};

module.exports = { addTransaction, updateTransaction, findTransaction };
