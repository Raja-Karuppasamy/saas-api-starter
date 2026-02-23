# QuickAI

Simple production-ready AI APIs for indie builders and startups.

## Endpoints

- /ai/summarize
- /ai/rewrite
- /ai/translate
- /ai/extract
- /ai/classify
- /ai/keywords
- /ai/grammar

---

## Get API Key

```bash
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/orgs

Response:

{
  "org_id": "...",
  "api_key": "sk_..."
}
Example: Summarize
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/summarize \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_KEY" \
-d '{"input":"Artificial intelligence is transforming industries."}'
Example: Rewrite
curl -X POST https://saas-api-starter-production-bb44.up.railway.app/ai/rewrite \
-H "Content-Type: application/json" \
-H "x-api-key: YOUR_KEY" \
-d '{"input":"we will get back to you"}'
Pricing

$19/month — 100k requests.

Stripe powered. Usage metered.