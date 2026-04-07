# Multi-Region Architecture

## Current Setup (2 Clusters)

### Cluster 1: Asia (Mumbai)
- **Location:** asia-south1-a
- **Nodes:** 2x e2-small
- **External IP:** 34.93.60.207
- **Domain:** quickaiapi.com (currently points here)
- **Latency from India:** ~200ms

### Cluster 2: US (Iowa)
- **Location:** us-central1-a
- **Nodes:** 2x e2-small
- **External IP:** 34.123.20.69
- **Latency from US:** ~50ms
- **Latency from India:** ~800ms

## Multi-Region Benefits

✅ **Low Latency Globally**
- Users in Asia → Mumbai cluster (fast)
- Users in US → Iowa cluster (fast)

✅ **High Availability**
- Mumbai goes down → Iowa keeps running
- Disaster recovery built-in

✅ **Compliance**
- Data residency requirements (EU data stays in EU, etc.)

## How to Route Users to Nearest Cluster

### Option 1: DNS-Based (GCP Cloud Load Balancing)
Global Load Balancer routes users to nearest cluster based on latency.

### Option 2: CDN with Origin Selection (Cloudflare)
CDN intelligently routes to nearest origin cluster.

### Option 3: GeoDNS (Route 53, Cloud DNS)
DNS returns different IPs based on user location.

## Current Cost

**Per cluster:** ~$50/month
**Total (2 clusters):** ~$100/month

## Database Considerations

**Current:** Both clusters use same Railway Postgres (Oregon)
**Production:** Use read replicas in each region

## Deployment Strategy

Switch between clusters using kubectl context:
- gke_quickai-prod-492114_asia-south1-a_quickai-cluster
- gke_quickai-prod-492114_us-central1-a_quickai-us-cluster
