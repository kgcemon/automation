const sqlite3 = require('sqlite3').verbose();
const dbPath = './database.db';
const db = new sqlite3.Database(dbPath);

// Migration query
const migration = `
  CREATE TABLE IF NOT EXISTS transactions (
                                            uid TEXT PRIMARY KEY,
                                            status TEXT CHECK(status IN ('processing', 'success', 'failed')),
    message TEXT,
    extra JSON,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`;

const runMigration = () => {
  db.exec(migration, (err) => {
    if (err) {
      console.error('Error executing migration:', err);
    } else {
      console.log('Migration executed successfully');

      // Verify the tables in the database
      db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, tables) => {
        if (err) {
          console.error('Error fetching tables:', err);
        } else {
          console.log('Tables in the database:', tables);
        }
      });
    }
  });
};

// Run migration
runMigration();

// Close connection after migration is done
db.close((err) => {
  if (err) {
    return console.error(err.message);
  }
  console.log('Closed the database connection.');
});
