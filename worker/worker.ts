import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

setInterval(async () => {
  try {
    await pool.query(
      "INSERT INTO users(email) VALUES($1)",
      [`user_${Date.now()}@test.com`]
    );

    console.log("Inserted user");
  } catch (err) {
    console.error("Worker error:", err);
  }
}, 5000);
