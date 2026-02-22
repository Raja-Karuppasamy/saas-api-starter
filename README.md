# QuickAI

Production-ready AI API for developers and startups.

Simple. Fast. Usage-based. Stripe-powered.

---

## 🚀 Base URL

https://saas-api-starter-production-bb44.up.railway.app

---

## 🔐 Authentication

All requests require:

x-api-key: YOUR_API_KEY

Create one:

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/orgs \
-H "Content-Type: application/json" \
-d '{"name":"My Org"}'
```

Response:

```json
{
  "org_id": "org_xxxxx",
  "api_key": "sk_xxxxx"
}
```

---

# ✨ AI Endpoints

---

## 📝 Summarize

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/summarize \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"Artificial intelligence is transforming every industry."}'
```

---

## ✍️ Rewrite

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/rewrite \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"we will get back to you soon"}'
```

---

## 🌍 Translate

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/translate \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"Hello how are you","target":"Spanish"}'
```

---

## 🧠 Classify

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/classify \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"Customer is unhappy with delayed delivery"}'
```

---

## 🔑 Keywords

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/keywords \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"Artificial intelligence is transforming healthcare and finance."}'
```

---

## ✅ Grammar

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/grammar \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"we will contact you soon thanks for your patience"}'
```

---

## 📦 Extract Structured Data

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/extract \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_API_KEY" \
-d '{"input":"John works at Google. Email john@gmail.com. Phone +1 555 123 4567"}'
```

---

## 👤 Check Account Usage

```bash
curl -H "x-api-key: YOUR_API_KEY" \
https://saas-api-starter-production-bb44.up.railway.app/me
```

---

# 💳 Pricing

$19/month  
100,000 requests per month  
Instant upgrade via Stripe Checkout

---

Built by Raja.