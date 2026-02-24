import "dotenv/config";
import express from "express";
import pkg from "pg";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import Stripe from "stripe";
import OpenAI from "openai";


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-01-28.clover",
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();

/* ---------------- WEBHOOK (MUST BE FIRST) ---------------- */

app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err: any) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send("Webhook Error");
    }

    console.log("Webhook:", event.type);

    /* UPGRADE */
   if (event.type === "checkout.session.completed") {
  const session = event.data.object as any;

  const orgId = session.metadata.org_id;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  console.log("Upgrading org:", orgId, "subscription:", subscriptionId);

  await pool.query(
    `
    UPDATE orgs
    SET plan='pro',
        monthly_limit=100000,
        stripe_customer_id=$2,
        stripe_subscription_id=$3
    WHERE id=$1
    `,
    [orgId, customerId, subscriptionId]
  );
}

    /* DOWNGRADE */
    if (
  event.type === "customer.subscription.deleted" ||
  event.type === "invoice.payment_failed"
) {
  const obj = event.data.object as any;

  const subscriptionId =
    obj.id || obj.subscription;

  const { rows } = await pool.query(
    `SELECT id FROM orgs WHERE stripe_subscription_id=$1`,
    [subscriptionId]
  );

  if (rows.length) {
    const orgId = rows[0].id;

    console.log("Downgrading org:", orgId);

    await pool.query(
      `
      UPDATE orgs
      SET plan='free', monthly_limit=1000
      WHERE id=$1
      `,
      [orgId]
    );
  }
}


    res.json({ received: true });
  }
);

/* ---------------- NORMAL JSON AFTER WEBHOOK ---------------- */

app.use(express.json());

/* ---------------- HELPERS ---------------- */

function generateApiKey() {
  return "sk_" + crypto.randomBytes(24).toString("hex");
}

/* ---------------- RATE LIMIT ---------------- */

//app.use(
//  "/protected",
//  rateLimit({
//    windowMs: 60 * 1000,
//    max: 100,
//  })
//);

/* ---------------- AUTH ---------------- */

async function authMiddleware(req: any, res: any, next: any) {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const org = await pool.query(
    `
    SELECT o.id, o.monthly_limit
    FROM api_keys k
    JOIN orgs o ON o.id = k.org_id
    WHERE k.key = $1
    `,
    [apiKey]
  );

  if (!org.rows.length)
    return res.status(403).json({ error: "Invalid API key" });

  req.orgId = org.rows[0].id;
  req.limit = org.rows[0].monthly_limit;

  next();
}
app.get("/me", authMiddleware, async (req: any, res) => {
  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.plan,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];

  res.json({
    org_id: org.id,
    plan: org.plan,
    used: Number(org.used),
    limit: org.monthly_limit,
    remaining: org.monthly_limit - Number(org.used),
  });
});

app.get("/usage", authMiddleware, async (req: any, res) => {
  const summary = await pool.query(
    `
    SELECT endpoint, COUNT(*) as count
    FROM usage_logs
    WHERE org_id = $1
      AND created_at > date_trunc('month', now())
    GROUP BY endpoint
    `,
    [req.orgId]
  );

  const total = await pool.query(
    `
    SELECT
      o.plan,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = total.rows[0];

  const byEndpoint: any = {};
  summary.rows.forEach((r) => {
    byEndpoint[r.endpoint] = Number(r.count);
  });

  res.json({
    plan: org.plan,
    limit: org.monthly_limit,
    used: Number(org.used),
    remaining: org.monthly_limit - Number(org.used),
    by_endpoint: byEndpoint,
  });
});
/* ---------------- ROUTES ---------------- */

app.get("/health", async (_req, res) => {
  const r = await pool.query("SELECT NOW()");
  res.json({ ok: true, db: r.rows[0] });
});

app.post("/orgs", async (req, res) => {
  const orgId = "org_" + crypto.randomBytes(6).toString("hex");
  const apiKey = generateApiKey();

  await pool.query(
    "INSERT INTO orgs(id,name,plan,monthly_limit) VALUES($1,$2,'free',1000)",
    [orgId, req.body?.name || null]
  );

  await pool.query("INSERT INTO api_keys(org_id,key) VALUES($1,$2)", [
    orgId,
    apiKey,
  ]);

  res.json({ org_id: orgId, api_key: apiKey });
});

/* PROTECTED */

app.get("/protected", authMiddleware, async (req, res) => {
  // 1. Get org + usage
  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.plan,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  // 2. Enforce quota
  if (used >= org.monthly_limit) {
    return res.status(402).json({
      error: "Monthly limit reached. Please upgrade.",
    });
  }

  // 3. Log usage
  await pool.query(
    `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1, '/protected')`,
    [req.orgId]
  );

  res.json({
    message: "Access granted",
    remaining: org.monthly_limit - used - 1,
  });
});


/* CHECKOUT */

app.post("/billing/checkout", async (req, res) => {
  const { orgId } = req.body;

  if (!orgId) return res.status(400).json({ error: "Missing orgId" });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",

    line_items: [
      {
        price: process.env.STRIPE_PRICE_ID!,
        quantity: 1,
      },
    ],

    success_url: "http://localhost:3000/success",
    cancel_url: "http://localhost:3000/cancel",

    metadata: {
      org_id: orgId,
    },
  });

  res.json({ url: session.url });
});
app.post("/billing/portal", authMiddleware, async (req, res) => {
  const orgId = req.orgId;

  // Find Stripe customer id from last checkout
  const result = await pool.query(
    `
    SELECT stripe_customer_id
    FROM orgs
    WHERE id = $1
    `,
    [orgId]
  );

  const customerId = result.rows[0]?.stripe_customer_id;

  if (!customerId) {
    return res.status(400).json({ error: "No Stripe customer found" });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: "http://localhost:3000",
  });

  res.json({ url: session.url });
});

app.post("/ai/text", authMiddleware, async (req: any, res) => {
  const { input } = req.body;

  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit) {
    return res.status(402).json({ error: "Monthly limit reached" });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input,
    });

     const output = response.output_text || "";

    await pool.query(
      `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
      [req.orgId, "/ai/text"]
    );

    res.json({
      output,
      remaining: org.monthly_limit - used - 1,
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/summarize", authMiddleware, async (req: any, res) => {
  const { input } = req.body;

  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit) {
    return res.status(402).json({ error: "Monthly limit reached" });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Summarize this clearly and concisely:\n\n${input}`,
    });

    const output = response.output_text || "";

    await pool.query(
      `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
      [req.orgId, "/ai/summarize"]
    );

    res.json({
      output,
      remaining: org.monthly_limit - used - 1,
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/classify", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT o.id, o.monthly_limit, COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit)
    return res.status(402).json({ error: "Monthly limit reached" });

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Classify this text into one clear category:\n\n${input}`,
    });

    const output = response.output_text || "";

    await pool.query(
      `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
      [req.orgId, "/ai/classify"]
    );

    res.json({
      output,
      remaining: org.monthly_limit - used - 1,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/keywords", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT o.monthly_limit, COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const used = Number(rows[0].used);
  const limit = rows[0].monthly_limit;

  if (used >= limit) return res.status(402).json({ error: "Monthly limit reached" });

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `Extract 5 important keywords from this:\n\n${input}`,
  });

  const output = response.output_text || "";

  await pool.query(
    `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
    [req.orgId, "/ai/keywords"]
  );

  res.json({ output, remaining: limit - used - 1 });
});

app.post("/ai/grammar", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT o.monthly_limit, COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const used = Number(rows[0].used);
  const limit = rows[0].monthly_limit;

  if (used >= limit) return res.status(402).json({ error: "Monthly limit reached" });

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `Fix grammar and improve clarity:\n\n${input}`,
  });

  const output = response.output_text || "";

  await pool.query(
    `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
    [req.orgId, "/ai/grammar"]
  );

  res.json({ output, remaining: limit - used - 1 });
});

app.post("/ai/extract", authMiddleware, async (req: any, res) => {
  const { input } = req.body;

  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit) {
    return res.status(402).json({ error: "Monthly limit reached" });
  }

  try {
    const response = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: [
    {
      role: "system",
      content:
        "You are a strict data extraction engine. Return ONLY valid minified JSON. Never use markdown. Never add explanations.",
    },
    {
      role: "user",
      content: `
Extract fields and return JSON with exactly these keys:
name, company, email, phone

If missing, use null.

Text:
${input}
`,
    },
  ],
});

      

const raw = response.output_text || "";

let parsed: any;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = raw;
}

    await pool.query(
  `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
  [req.orgId, "/ai/extract"]
);

res.json({
  output: parsed,
  remaining: org.monthly_limit - used - 1,
});
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/rewrite", authMiddleware, async (req: any, res) => {
  const { input } = req.body;

  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit) {
    return res.status(402).json({ error: "Monthly limit reached" });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Rewrite this professionally:\n\n${input}`,
    });

    const output = response.output_text || "";



    await pool.query(
      `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
      [req.orgId, "/ai/rewrite"]
    );

    res.json({
      output,
      remaining: org.monthly_limit - used - 1,
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/translate", authMiddleware, async (req: any, res) => {
  const { input, target = "English" } = req.body;

  if (!input) return res.status(400).json({ error: "Missing input" });

  const { rows } = await pool.query(
    `
    SELECT
      o.id,
      o.monthly_limit,
      COUNT(u.id) AS used
    FROM orgs o
    LEFT JOIN usage_logs u
      ON o.id = u.org_id
      AND u.created_at > date_trunc('month', now())
    WHERE o.id = $1
    GROUP BY o.id
    `,
    [req.orgId]
  );

  const org = rows[0];
  const used = Number(org.used);

  if (used >= org.monthly_limit) {
    return res.status(402).json({ error: "Monthly limit reached" });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Translate this into ${target}:\n\n${input}`,
    });

    const output = response.output_text || "";

    await pool.query(
      `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
      [req.orgId, "/ai/translate"]
    );

    res.json({
      output,
      remaining: org.monthly_limit - used - 1,
    });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});


/* UI */

app.get("/success", (_req, res) =>
  res.send("<h1>Payment successful</h1>")
);
app.get("/cancel", (_req, res) =>
  res.send("<h1>Payment cancelled</h1>")
);

/* START */

const PORT = Number(process.env.PORT) || 3000;


app.get("/", (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>QuickAI</title>
<style>
body {
  margin:0;
  font-family:system-ui,sans-serif;
  background:#0b0b0b;
  color:white;
  display:flex;
  justify-content:center;
  align-items:center;
  height:100vh;
}
.box {
  max-width:700px;
  padding:40px;
}
pre {
  background:#111;
  padding:12px;
  border-radius:6px;
}
button {
  background:#00ffb3;
  border:none;
  padding:10px 18px;
  border-radius:6px;
  cursor:pointer;
  margin-top:10px;
}
.price { color:#00ffb3; margin-top:20px; }
</style>
</head>

<body>
<div class="box">
<h1>QuickAI</h1>

<p>Drop-in AI APIs for indie builders. Ship features in minutes.</p>

<ul>
<li>/ai/summarize</li>
<li>/ai/rewrite</li>
<li>/ai/translate</li>
<li>/ai/extract</li>
<li>/ai/classify</li>
<li>/ai/keywords</li>
<li>/ai/grammar</li>
</ul>

<pre>curl -X POST /ai/summarize
-H "x-api-key: YOUR_KEY"
-d '{"input":"Hello world"}'</pre>

<div class="price">$19/month • 100k requests</div>

<button id="getKey">Get API Key</button>

<pre id="apiKeyBox" style="display:none"></pre>

<p style="opacity:.6;margin-top:30px">
Stripe billing • Usage tracking • Production ready
</p>

</div>

<script>
document.getElementById("getKey").onclick = async () => {
  const r = await fetch("/orgs",{method:"POST"});
  const d = await r.json();
  const box = document.getElementById("apiKeyBox");
  box.style.display="block";
  box.textContent="Your API Key:\\n\\n"+d.api_key;
};
</script>

</body>
</html>
`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("API running on port", PORT);
});