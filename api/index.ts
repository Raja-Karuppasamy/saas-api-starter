import "dotenv/config";
import express from "express";
import pkg from "pg";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import Stripe from "stripe";
import OpenAI from "openai";


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
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

  if (event.type === "checkout.session.completed") {
  const session = event.data.object as any;
  const orgId = session.metadata.org_id;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  // Determine plan from amount
  const amount = session.amount_total;
  let plan = "pro";
  let limit = 50000;

  if (amount >= 4900) {
    plan = "scale";
    limit = 200000;
  }

  console.log("Upgrading org:", orgId, "to:", plan);

  await pool.query(
    `
    UPDATE orgs
    SET plan=$2,
        monthly_limit=$3,
        stripe_customer_id=$4,
        stripe_subscription_id=$5
    WHERE id=$1
    `,
    [orgId, plan, limit, customerId, subscriptionId]
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

/* ---------------- USAGE HELPER ---------------- */

async function checkQuotaAndLog(req: any, res: any, endpoint: string) {
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
    res.status(402).json({ error: "Monthly limit reached. Please upgrade." });
    return null;
  }

  return { org, used };
}

async function logUsage(orgId: string, endpoint: string) {
  await pool.query(
    `INSERT INTO usage_logs(org_id, endpoint) VALUES ($1,$2)`,
    [orgId, endpoint]
  );
}

/* ---------------- INFO ROUTES ---------------- */

app.get("/health", async (_req, res) => {
  const r = await pool.query("SELECT NOW()");
  res.json({ ok: true, db: r.rows[0] });
});

app.get("/status", (_req, res) => {
  res.json({
    name: "QuickAI",
    version: "1.0.0",
    status: "operational",
  });
});

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
  const { rows } = await pool.query(
    `
    SELECT
      o.plan,
      o.monthly_limit,
      COUNT(u.id) AS used,
      COUNT(u.id) FILTER (WHERE u.endpoint IS NOT NULL) AS total
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
  const limit = Number(org.monthly_limit);
  const remaining = limit - used;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysElapsed =
    Math.max(
      1,
      Math.ceil((now.getTime() - startOfMonth.getTime()) / 86400000)
    );

  const averagePerDay = used / daysElapsed;

  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysLeftInMonth = Math.ceil(
    (endOfMonth.getTime() - now.getTime()) / 86400000
  );

  let estimatedDaysUntilLimit: any = null;

  if (averagePerDay > 0) {
    estimatedDaysUntilLimit = Math.floor(remaining / averagePerDay);
  }

  if (
    estimatedDaysUntilLimit &&
    estimatedDaysUntilLimit > daysLeftInMonth
  ) {
    estimatedDaysUntilLimit = "Safe for this billing cycle";
  }

  const endpointRows = await pool.query(
    `
    SELECT endpoint, COUNT(*)::int AS count
    FROM usage_logs
    WHERE org_id=$1
      AND created_at > date_trunc('month', now())
    GROUP BY endpoint
    `,
    [req.orgId]
  );

  const byEndpoint: any = {};
  endpointRows.rows.forEach((r) => (byEndpoint[r.endpoint] = r.count));

  res.json({
    plan: org.plan,
    limit,
    used,
    remaining,
    average_per_day: Number(averagePerDay.toFixed(2)),
    estimated_days_until_limit: estimatedDaysUntilLimit,
    by_endpoint: byEndpoint,
    warning:
      remaining < limit * 0.2 ? "Approaching monthly limit" : null,
  });
});

/* ---------------- ORG CREATION ---------------- */

app.post("/orgs", async (req, res) => {
  const orgId = "org_" + crypto.randomBytes(6).toString("hex");
  const apiKey = generateApiKey();

  await pool.query(
    "INSERT INTO orgs(id,name,plan,monthly_limit) VALUES($1,$2,'free',500)",
    [orgId, req.body?.name || null]
  );

  await pool.query("INSERT INTO api_keys(org_id,key) VALUES($1,$2)", [
    orgId,
    apiKey,
  ]);

  res.json({ org_id: orgId, api_key: apiKey });
});

/* ---------------- PROTECTED TEST ROUTE ---------------- */

app.get("/protected", authMiddleware, async (req: any, res) => {
  const quota = await checkQuotaAndLog(req, res, "/protected");
  if (!quota) return;

  await logUsage(req.orgId, "/protected");

  res.json({
    message: "Access granted",
    remaining: quota.org.monthly_limit - quota.used - 1,
  });
});

/* ---------------- BILLING ---------------- */

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

    success_url: "https://quickaiapi.com/success",
    cancel_url: "https://quickaiapi.com/cancel",

    metadata: {
      org_id: orgId,
    },
  });

  res.json({ url: session.url });
});

app.post("/billing/checkout/scale", async (req, res) => {
  const { orgId } = req.body;

  if (!orgId) return res.status(400).json({ error: "Missing orgId" });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price: process.env.STRIPE_PRICE_SCALE_ID!,
        quantity: 1,
      },
    ],
    success_url: "https://quickaiapi.com/success",
    cancel_url: "https://quickaiapi.com/cancel",
    metadata: {
      org_id: orgId,
    },
  });

  res.json({ url: session.url });
});

app.post("/billing/portal", authMiddleware, async (req: any, res) => {
  const orgId = req.orgId;

  const result = await pool.query(
    `SELECT stripe_customer_id FROM orgs WHERE id = $1`,
    [orgId]
  );

  const customerId = result.rows[0]?.stripe_customer_id;

  if (!customerId) {
    return res.status(400).json({ error: "No Stripe customer found" });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: "https://quickaiapi.com",
  });

  res.json({ url: session.url });
});

/* ---------------- AI ENDPOINTS ---------------- */

app.post("/ai/text", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/text");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/text");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/summarize", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/summarize");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Summarize this clearly and concisely:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/summarize");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/rewrite", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/rewrite");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Rewrite this professionally:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/rewrite");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/translate", authMiddleware, async (req: any, res) => {
  const { input, target = "English" } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/translate");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Translate this into ${target}:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/translate");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/extract", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/extract");
  if (!quota) return;

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
          content: `Extract fields and return JSON with exactly these keys:\nname, company, email, phone\n\nIf missing, use null.\n\nText:\n${input}`,
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

    await logUsage(req.orgId, "/ai/extract");

    res.json({ output: parsed, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/classify", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/classify");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Classify this text into one clear category:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/classify");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/keywords", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/keywords");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Extract 5 important keywords from this:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/keywords");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/grammar", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/grammar");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Fix grammar and improve clarity:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/grammar");

    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

/* ---------------- NEW AI ENDPOINTS ---------------- */

app.post("/ai/sentiment", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/sentiment");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "You are a sentiment analysis engine. Return ONLY valid JSON with keys: sentiment (positive/negative/neutral), confidence (0-1), reasoning (one sentence). No markdown." },
        { role: "user", content: input },
      ],
    });

    const raw = response.output_text || "";
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }

    await logUsage(req.orgId, "/ai/sentiment");
    res.json({ output: parsed, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/tldr", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/tldr");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Give a TL;DR in exactly one sentence. Be extremely concise:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/tldr");
    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/title", authMiddleware, async (req: any, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/title");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Generate 3 compelling titles/headlines for this content. Return as JSON array of strings. No markdown:\n\n${input}`,
    });

    const raw = response.output_text || "";
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }

    await logUsage(req.orgId, "/ai/title");
    res.json({ output: parsed, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/email", authMiddleware, async (req: any, res) => {
  const { input, tone = "professional" } = req.body;
  if (!input) return res.status(400).json({ error: "Missing input" });

  const quota = await checkQuotaAndLog(req, res, "/ai/email");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Write a ${tone} email based on these bullet points or notes. Include subject line. Format clearly:\n\n${input}`,
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/email");
    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/ai/qa", authMiddleware, async (req: any, res) => {
  const { input, question } = req.body;
  if (!input || !question) return res.status(400).json({ error: "Missing input or question" });

  const quota = await checkQuotaAndLog(req, res, "/ai/qa");
  if (!quota) return;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Answer the question based ONLY on the provided context. If the answer is not in the context, say so." },
        { role: "user", content: `Context:\n${input}\n\nQuestion:\n${question}` },
      ],
    });

    const output = response.output_text || "";
    await logUsage(req.orgId, "/ai/qa");
    res.json({ output, remaining: quota.org.monthly_limit - quota.used - 1 });
  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

/* ---------------- BILLING UI PAGES ---------------- */

app.get("/success", (_req, res) =>
  res.send("<h1>Payment successful! Your account has been upgraded.</h1><p><a href='https://quickaiapi.com'>Back to QuickAI</a></p>")
);
app.get("/cancel", (_req, res) =>
  res.send("<h1>Payment cancelled.</h1><p><a href='https://quickaiapi.com'>Back to QuickAI</a></p>")
);

/* ============================================================
   LANDING PAGE
   ============================================================ */

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QuickAI — Drop-in AI APIs for Indie Builders</title>
<meta name="description" content="Add AI features to your product in minutes. Summarize, rewrite, translate, extract, classify — all with one API key. $19/month for 100k requests."/>
<meta property="og:title" content="QuickAI — Drop-in AI APIs"/>
<meta property="og:description" content="Ship AI features in minutes, not weeks. 12 production-ready endpoints with built-in billing and usage tracking."/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://quickaiapi.com"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#050508;--surface:#0c0c12;--surface2:#13131d;--border:#1e1e2e;
  --text:#e2e2ef;--text-dim:#7a7a95;--accent:#00e89d;--accent2:#00c4ff;
  --accent-glow:rgba(0,232,157,0.15);--code-bg:#0a0a14;
  --font-display:'Outfit',sans-serif;--font-mono:'JetBrains Mono',monospace;
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--font-display);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}

nav{position:fixed;top:0;width:100%;z-index:100;backdrop-filter:blur(20px);background:rgba(5,5,8,0.85);border-bottom:1px solid var(--border)}
.nav-inner{max-width:1100px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:var(--font-mono);font-weight:700;font-size:18px;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.nav-links{display:flex;gap:28px;align-items:center}
.nav-links a{color:var(--text-dim);font-size:14px;font-weight:500;transition:color .2s}
.nav-links a:hover{color:var(--text)}
.nav-cta{background:var(--accent)!important;color:#050508!important;padding:8px 18px;border-radius:6px;font-weight:600;font-size:13px;transition:transform .2s,box-shadow .2s}
.nav-cta:hover{transform:translateY(-1px);box-shadow:0 4px 20px var(--accent-glow)}

.hero{padding:160px 24px 100px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:800px;height:800px;background:radial-gradient(circle,rgba(0,232,157,0.06) 0%,transparent 70%);pointer-events:none}
.hero-badge{display:inline-block;padding:6px 16px;border:1px solid var(--border);border-radius:100px;font-size:12px;font-weight:500;color:var(--text-dim);margin-bottom:28px;letter-spacing:0.5px;text-transform:uppercase}
.hero h1{font-size:clamp(38px,6vw,64px);font-weight:800;line-height:1.1;letter-spacing:-2px;margin-bottom:20px;max-width:700px;margin-left:auto;margin-right:auto}
.hero h1 .gradient{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{font-size:18px;color:var(--text-dim);max-width:520px;margin:0 auto 40px;font-weight:300;line-height:1.7}
.hero-cta{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#050508;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;transition:transform .2s,box-shadow .2s;border:none;cursor:pointer;font-family:var(--font-display)}
.hero-cta:hover{transform:translateY(-2px);box-shadow:0 8px 30px var(--accent-glow)}
.hero-sub{margin-top:16px;font-size:13px;color:var(--text-dim)}

.demo{max-width:1100px;margin:-20px auto 0;padding:0 24px;position:relative;z-index:2}
.demo-window{background:var(--code-bg);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.demo-bar{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface)}
.demo-dot{width:10px;height:10px;border-radius:50%}
.demo-dot:nth-child(1){background:#ff5f56}
.demo-dot:nth-child(2){background:#ffbd2e}
.demo-dot:nth-child(3){background:#27c93f}
.demo-title{margin-left:12px;font-family:var(--font-mono);font-size:12px;color:var(--text-dim)}
.demo-body{padding:24px;font-family:var(--font-mono);font-size:13px;line-height:2;overflow-x:auto}
.demo-body .c{color:#4a5568}
.demo-body .k{color:var(--accent2)}
.demo-body .s{color:var(--accent)}
.demo-body .r{color:#ffcb6b}

.endpoints{max-width:1100px;margin:0 auto;padding:120px 24px 80px}
.section-label{font-family:var(--font-mono);font-size:12px;color:var(--accent);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px}
.section-title{font-size:clamp(28px,4vw,42px);font-weight:700;letter-spacing:-1.5px;margin-bottom:16px}
.section-desc{color:var(--text-dim);font-size:16px;max-width:500px;margin-bottom:48px;font-weight:300}
.endpoint-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.ep{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;transition:border-color .3s,transform .2s}
.ep:hover{border-color:var(--accent);transform:translateY(-2px)}
.ep-method{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-glow);display:inline-block;padding:3px 8px;border-radius:4px;margin-bottom:10px}
.ep-path{font-family:var(--font-mono);font-size:15px;font-weight:600;margin-bottom:8px}
.ep-desc{font-size:13px;color:var(--text-dim);line-height:1.6}

.how{max-width:1100px;margin:0 auto;padding:80px 24px 100px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:48px}
.step{position:relative;padding:32px 24px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
.step-num{font-family:var(--font-mono);font-size:48px;font-weight:800;color:var(--accent);opacity:0.15;position:absolute;top:16px;right:20px}
.step h3{font-size:17px;font-weight:600;margin-bottom:8px}
.step p{font-size:13px;color:var(--text-dim);line-height:1.6}
.step code{font-family:var(--font-mono);background:var(--code-bg);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--accent)}

.pricing{max-width:1100px;margin:0 auto;padding:80px 24px 120px;text-align:center}
.price-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;margin-top:48px;max-width:700px;margin-left:auto;margin-right:auto}
.pc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:36px 28px;text-align:left;position:relative}
.pc.featured{border-color:var(--accent);box-shadow:0 0 40px var(--accent-glow)}
.pc .badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#050508;padding:4px 14px;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:0.5px}
.pc-name{font-size:14px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.pc-amount{font-size:42px;font-weight:800;letter-spacing:-2px;margin-bottom:4px}
.pc-amount span{font-size:16px;font-weight:400;color:var(--text-dim)}
.pc-desc{font-size:13px;color:var(--text-dim);margin-bottom:24px}
.pc-features{list-style:none;margin-bottom:28px}
.pc-features li{padding:8px 0;font-size:13px;color:var(--text-dim);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.pc-features li::before{content:'\\2713';color:var(--accent);font-weight:700;font-size:14px}
.pc-btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;transition:transform .2s,box-shadow .2s;font-family:var(--font-display)}
.pc-btn.primary{background:var(--accent);color:#050508}
.pc-btn.primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px var(--accent-glow)}
.pc-btn.secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
.pc-btn.secondary:hover{border-color:var(--accent)}

footer{border-top:1px solid var(--border);padding:40px 24px;text-align:center}
footer p{font-size:13px;color:var(--text-dim)}

.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:200;justify-content:center;align-items:center;backdrop-filter:blur(4px)}
.modal-overlay.active{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:36px;max-width:480px;width:90%;position:relative}
.modal h2{font-size:22px;font-weight:700;margin-bottom:8px}
.modal p{font-size:14px;color:var(--text-dim);margin-bottom:24px}
.modal input{width:100%;padding:12px 14px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--font-display);font-size:14px;margin-bottom:16px;outline:none}
.modal input:focus{border-color:var(--accent)}
.modal-btn{width:100%;padding:12px;background:var(--accent);color:#050508;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;font-family:var(--font-display)}
.modal-close{position:absolute;top:16px;right:16px;background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer}
.key-result{font-family:var(--font-mono);background:var(--code-bg);padding:16px;border-radius:8px;font-size:13px;word-break:break-all;margin-top:16px;border:1px solid var(--border)}

@media(max-width:768px){
  .nav-links a:not(.nav-cta){display:none}
  .steps{grid-template-columns:1fr}
  .endpoint-grid{grid-template-columns:1fr}
  .hero h1{font-size:32px;letter-spacing:-1px}
}
</style>
</head>

<body>

<nav>
<div class="nav-inner">
  <div class="logo">Quick<span>AI</span></div>
  <div class="nav-links">
    <a href="#endpoints">Endpoints</a>
    <a href="#pricing">Pricing</a>
    <a href="#how">How It Works</a>
    <a href="/docs">Docs</a>
    <a href="javascript:void(0)" class="nav-cta" onclick="openModal()">Get API Key</a>
  </div>
</div>
</nav>

<section class="hero">
  <div class="hero-badge">Built by ClearFix.co</div>
  <h1>Add <span class="gradient">AI features</span> to your product in minutes</h1>
  <p>12 production-ready endpoints. One API key. Built-in billing and usage tracking. Stop wrestling with OpenAI configs — just call our API.</p>
  <button class="hero-cta" onclick="openModal()">Get Your API Key &rarr;</button>
  <div class="hero-sub">Free tier: 1,000 requests/month &middot; No credit card required</div>
</section>

<section class="demo">
<div class="demo-window">
  <div class="demo-bar">
    <div class="demo-dot"></div><div class="demo-dot"></div><div class="demo-dot"></div>
    <span class="demo-title">terminal</span>
  </div>
  <div class="demo-body">
    <span class="c"># Summarize any text in one call</span><br>
    <span class="k">curl</span> -X POST https://quickaiapi.com<span class="s">/ai/summarize</span> \\<br>
    &nbsp;&nbsp;-H <span class="s">"x-api-key: sk_your_key"</span> \\<br>
    &nbsp;&nbsp;-H <span class="s">"Content-Type: application/json"</span> \\<br>
    &nbsp;&nbsp;-d <span class="s">'{"input":"Your long article text here..."}'</span><br><br>
    <span class="c"># Response</span><br>
    {<br>
    &nbsp;&nbsp;<span class="r">"output"</span>: <span class="s">"A concise summary of your text..."</span>,<br>
    &nbsp;&nbsp;<span class="r">"remaining"</span>: <span style="color:#c792ea">99842</span><br>
    }
  </div>
</div>
</section>

<section class="endpoints" id="endpoints">
  <div class="section-label">Endpoints</div>
  <div class="section-title">12 endpoints. One API key.</div>
  <div class="section-desc">Each endpoint does one thing well. All return JSON. All track usage automatically.</div>

  <div class="endpoint-grid">
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/summarize</div><div class="ep-desc">Condense long text into clear, concise summaries. Perfect for article previews, email digests, and content feeds.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/rewrite</div><div class="ep-desc">Rewrite text professionally. Turn casual messages into polished copy for emails, docs, and customer comms.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/translate</div><div class="ep-desc">Translate text to any language. Pass a target parameter. Supports 50+ languages out of the box.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/extract</div><div class="ep-desc">Pull structured data from unstructured text. Returns clean JSON with names, emails, phones, companies.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/classify</div><div class="ep-desc">Categorize text into clear labels. Great for support tickets, content moderation, and lead scoring.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/keywords</div><div class="ep-desc">Extract the 5 most important keywords from any text. Useful for SEO, tagging, and content discovery.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/grammar</div><div class="ep-desc">Fix grammar and improve clarity. Clean up user-generated content, form submissions, and support messages.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/sentiment</div><div class="ep-desc">Analyze sentiment as positive, negative, or neutral with confidence score. Perfect for reviews and feedback.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/tldr</div><div class="ep-desc">Ultra-short one-sentence summary. Built for Slack bots, notifications, and mobile previews.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/title</div><div class="ep-desc">Generate 3 compelling headlines from your content. Returns JSON array. Great for blogs and CMS tools.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/email</div><div class="ep-desc">Turn bullet points into a professional email with subject line. Supports tone parameter.</div></div>
    <div class="ep"><div class="ep-method">POST</div><div class="ep-path">/ai/qa</div><div class="ep-desc">Answer questions from provided context. Pass input + question. Built for docs, support, and knowledge bases.</div></div>
  </div>
</section>

<section class="how" id="how">
  <div class="section-label">How It Works</div>
  <div class="section-title">Three steps. Five minutes.</div>
  <div class="section-desc">No SDKs, no config files, no model management. Just HTTP.</div>

  <div class="steps">
    <div class="step">
      <div class="step-num">01</div>
      <h3>Get your API key</h3>
      <p>Create an org and receive your key instantly. No credit card, no OAuth. One POST: <code>POST /orgs</code></p>
    </div>
    <div class="step">
      <div class="step-num">02</div>
      <h3>Call any endpoint</h3>
      <p>Send a POST with your key in <code>x-api-key</code> header and your text in the body. Get JSON back in &lt;2 seconds.</p>
    </div>
    <div class="step">
      <div class="step-num">03</div>
      <h3>Ship your feature</h3>
      <p>Usage is tracked automatically. Upgrade to Pro when ready. Check <code>GET /usage</code> anytime for stats.</p>
    </div>
  </div>
</section>

<section class="pricing" id="pricing">
  <div class="section-label">Pricing</div>
  <div class="section-title">Simple. Predictable. No surprises.</div>
  <div class="section-desc" style="margin-left:auto;margin-right:auto">No per-token billing. No hidden fees. Just a flat monthly rate.</div>

  <div class="price-cards" style="max-width:1000px">
    <div class="pc">
      <div class="pc-name">Free</div>
      <div class="pc-amount">$0 <span>/month</span></div>
      <div class="pc-desc">For testing and side projects</div>
      <ul class="pc-features">
        <li>500 requests/month</li>
        <li>All 12 AI endpoints</li>
        <li>API key auth</li>
        <li>Usage tracking</li>
      </ul>
      <button class="pc-btn secondary" onclick="openModal()">Get Free Key</button>
    </div>
    <div class="pc featured">
      <div class="badge">MOST POPULAR</div>
      <div class="pc-name">Pro</div>
      <div class="pc-amount">$19 <span>/month</span></div>
      <div class="pc-desc">For production apps</div>
      <ul class="pc-features">
        <li>50,000 requests/month</li>
        <li>All 12 AI endpoints</li>
        <li>Per-endpoint analytics</li>
        <li>Priority support</li>
        <li>Stripe billing portal</li>
      </ul>
      <button class="pc-btn primary" onclick="openModal()">Start Pro</button>
    </div>
    <div class="pc">
      <div class="pc-name">Scale</div>
      <div class="pc-amount">$49 <span>/month</span></div>
      <div class="pc-desc">For apps with real traffic</div>
      <ul class="pc-features">
        <li>200,000 requests/month</li>
        <li>All 12 AI endpoints</li>
        <li>Per-endpoint analytics</li>
        <li>Priority support</li>
        <li>Stripe billing portal</li>
      </ul>
      <button class="pc-btn secondary" onclick="openModal()">Start Scale</button>
    </div>
  </div>
</section>

<footer>
  <p>Built by <a href="https://clearfix.co" target="_blank">ClearFix.co</a> &middot; <a href="/status">API Status</a> &middot; <a href="/health">Health Check</a></p>
</footer>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <h2>Get Your API Key</h2>
    <p>Enter your app or company name. Your key will be generated instantly.</p>
    <div id="modal-form">
      <input type="text" id="orgName" placeholder="Your app name (e.g. MyStartup)"/>
      <button class="modal-btn" onclick="getKey()">Generate API Key</button>
    </div>
    <div id="modal-result" style="display:none">
      <p style="color:var(--accent);font-weight:600;margin-bottom:8px">Your API key is ready:</p>
      <div class="key-result" id="keyDisplay"></div>
      <p style="margin-top:12px;font-size:12px;color:var(--text-dim)">Save this key — it won't be shown again. Start making requests immediately.</p>
    </div>
  </div>
</div>

<script>
function openModal(){document.getElementById('modal').classList.add('active')}
function closeModal(){document.getElementById('modal').classList.remove('active')}
document.getElementById('modal').addEventListener('click',function(e){if(e.target===this)closeModal()})

async function getKey(){
  var name=document.getElementById('orgName').value||'My App';
  var btn=document.querySelector('.modal-btn');
  btn.textContent='Generating...';
  btn.disabled=true;
  try{
    var r=await fetch('/orgs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});
    var d=await r.json();
    document.getElementById('modal-form').style.display='none';
    document.getElementById('modal-result').style.display='block';
    document.getElementById('keyDisplay').textContent='API Key: '+d.api_key+'\\nOrg ID: '+d.org_id;
  }catch(e){
    btn.textContent='Error — try again';
    btn.disabled=false;
  }
}
</script>

</body>
</html>`;

app.get("/", (_req, res) => {
  res.send(LANDING_HTML);
});

/* ============================================================
   DOCS PAGE
   ============================================================ */

app.get("/docs", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QuickAI — API Documentation</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050508;color:#e2e2ef;font-family:'Outfit',sans-serif;padding:40px 24px;line-height:1.7}
.docs{max-width:800px;margin:0 auto}
h1{font-size:32px;font-weight:700;margin-bottom:8px}
h2{font-size:22px;font-weight:600;margin-top:48px;margin-bottom:16px;color:#00e89d}
p{color:#7a7a95;margin-bottom:12px;font-size:14px}
pre{background:#0a0a14;border:1px solid #1e1e2e;border-radius:8px;padding:16px;font-family:'JetBrains Mono',monospace;font-size:13px;overflow-x:auto;margin-bottom:16px;line-height:1.8}
code{font-family:'JetBrains Mono',monospace;background:#0a0a14;padding:2px 6px;border-radius:4px;font-size:12px;color:#00e89d}
a{color:#00e89d}
.back{display:inline-block;margin-bottom:32px;font-size:14px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #1e1e2e;font-size:13px}
th{color:#00e89d;font-family:'JetBrains Mono',monospace;font-size:12px}
td{color:#7a7a95}
</style>
</head>
<body>
<div class="docs">
<a class="back" href="/">&larr; Back to QuickAI</a>
<h1>API Documentation</h1>
<p>Base URL: <code>https://quickaiapi.com</code></p>
<h2>Authentication</h2>
<p>All AI endpoints require an API key in the <code>x-api-key</code> header.</p>
<pre>curl -H "x-api-key: sk_your_key" https://quickaiapi.com/ai/summarize</pre>
<h2>Create Organization</h2>
<pre>POST /orgs
Content-Type: application/json

{"name": "MyApp"}

Response:
{"org_id": "org_xxx", "api_key": "sk_xxx"}</pre>
<h2>AI Endpoints</h2>
<p>All endpoints accept {"input": "your text"} and return {"output": "...", "remaining": 99}</p>
<table>
<tr><th>Endpoint</th><th>Description</th><th>Extra Params</th></tr>
<tr><td>POST /ai/summarize</td><td>Concise summary</td><td>-</td></tr>
<tr><td>POST /ai/rewrite</td><td>Professional rewrite</td><td>-</td></tr>
<tr><td>POST /ai/translate</td><td>Language translation</td><td>target</td></tr>
<tr><td>POST /ai/extract</td><td>Structured data extraction</td><td>Returns JSON</td></tr>
<tr><td>POST /ai/classify</td><td>Text classification</td><td>-</td></tr>
<tr><td>POST /ai/keywords</td><td>Keyword extraction</td><td>-</td></tr>
<tr><td>POST /ai/grammar</td><td>Grammar correction</td><td>-</td></tr>
<tr><td>POST /ai/sentiment</td><td>Sentiment analysis</td><td>Returns JSON</td></tr>
<tr><td>POST /ai/tldr</td><td>One-sentence summary</td><td>-</td></tr>
<tr><td>POST /ai/title</td><td>Generate headlines</td><td>Returns JSON array</td></tr>
<tr><td>POST /ai/email</td><td>Email from bullet points</td><td>tone</td></tr>
<tr><td>POST /ai/qa</td><td>Q&A from context</td><td>question (required)</td></tr>
</table>
<h2>Check Usage</h2>
<pre>GET /usage
x-api-key: sk_your_key

Response:
{"plan":"free","limit":1000,"used":42,"remaining":958,"by_endpoint":{"/ai/summarize":20}}</pre>
<h2>Upgrade to Pro</h2>
<pre>POST /billing/checkout
{"orgId": "org_xxx"}

Response:
{"url": "https://checkout.stripe.com/..."}</pre>
<h2>Rate Limits</h2>
<p>Free: 500 requests/month. Pro: 50,000 requests/month. Scale: 200,000 requests/month. Returns 402 when limit reached.</p>
</div>
</body>
</html>`);
});

/* ---------------- START SERVER ---------------- */

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("API running on port", PORT);
});