# QuickAI

Simple production-ready AI API for developers and startups.

## Features

- Rewrite text  
- Summarize content  
- Translate languages  
- Extract structured data  
- API key authentication  
- Usage limits per organization  
- Stripe subscriptions  

---

## Base URL

https://saas-api-starter-production-bb44.up.railway.app

---

## Authentication

All endpoints require:

x-api-key: YOUR_API_KEY

---

## Endpoints

POST /ai/summarize  
POST /ai/rewrite  
POST /ai/translate  
POST /ai/extract  

### Example Payload

```json
{
  "input": "your text"
}
Example Response
{
  "output": "...",
  "remaining": 998
}

Create Organization

POST /orgs

Returns:

{
  "org_id": "...",
  "api_key": "sk_..."
}

Pricing

$19/month — 100k requests.

Built by Raja.