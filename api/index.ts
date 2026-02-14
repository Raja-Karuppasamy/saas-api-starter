import express from "express";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const app = express();
const PORT = 3000;

app.get("/health", async (_req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json({ status: "ok", db: result.rows[0] });
});

app.get("/users", async (_req, res) => {
  const users = await pool.query("SELECT * FROM users");
  res.json(users.rows);
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
app.get("/burn", (req, res) => {
  const end = Date.now() + 3000; // 3 seconds hard CPU

  while (Date.now() < end) {
    Math.sqrt(Math.random());
  }

  res.json({ ok: true });
});




