# QuickAI

Production-ready AI APIs for indie SaaS builders.

QuickAI helps you add common AI features to your product in minutes — without managing models, infra, or billing.

Built for:
- Indie SaaS builders
- MVP creators
- Internal tools
- Customer support automation
- Admin dashboards

---

## Base URL

https://quickaiapi.com

---

## Features

- Summarize text
- Rewrite professionally
- Translate languages
- Extract structured data
- Classify content
- Generate keywords
- Fix grammar
- API key authentication
- Monthly usage limits
- Per-endpoint analytics
- Stripe subscriptions

---

## Endpoints

- POST `/ai/summarize`
- POST `/ai/rewrite`
- POST `/ai/translate`
- POST `/ai/extract`
- POST `/ai/classify`
- POST `/ai/keywords`
- POST `/ai/grammar`

---

## Create Organization (Get API Key)

```bash
curl -X POST https://quickaiapi.com/orgs \
-H "Content-Type: application/json" \
-d '{"name":"MyApp"}'
Response:
{
  "org_id": "org_xxx",
  "api_key": "sk_xxx"
}
Example - Summarize:
curl -X POST https://quickaiapi.com/ai/summarize \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_KEY" \
-d '{"input":"Artificial intelligence is transforming industries."}'
Example - Rewrite:
curl -X POST https://quickaiapi.com/ai/rewrite \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_KEY" \
-d '{"input":"we will get back to you"}'
Check Usage:
curl -H "x-api-key: YOUR_KEY" \
https://quickaiapi.com/usage

Response:
{
  "plan": "pro",
  "limit": 100000,
  "used": 42,
  "remaining": 99958,
  "by_endpoint": {
    "/ai/summarize": 10,
    "/ai/rewrite": 5
  }
}
Pricing

$19/month — 100k requests.

Stripe powered. Usage metered. Cancel anytime.
Pricing

Built by Raja.