const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { DateTime } = require('luxon');

const DBSOURCE = "database.db";
const db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) throw err;
});

cron.schedule('0 0 * * *', async () => {
    try {
        const asiaDhakaNow = DateTime.now().setZone('Asia/Dhaka');
        const thresholdTimeDhaka = asiaDhakaNow.minus({ hours: 72 });
        const thresholdTimeUTC = thresholdTimeDhaka.toUTC().toISO({ includeOffset: false });

        const sql = `DELETE FROM transactions WHERE datetime(created) < datetime(?, 'utc')`;
        db.run(sql, [thresholdTimeUTC], function(err) {
            if (err) {
                console.error(err.message);
            } else {
                console.log(`Deleted ${this.changes} transaction(s) created before ${thresholdTimeDhaka.toISO()}`);
            }
        });
    } catch (error) {
        console.error('Error executing cron job:', error);
    }
});

process.on('exit', () => {
    db.close((err) => {
        if (err) console.error(err.message);
    });
});
