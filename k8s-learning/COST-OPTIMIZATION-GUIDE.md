# Cost Optimization & Autoscaling Guide

## Where K8s Costs Come From

1. **Compute (Nodes)** - 60-70% of costs
   - e2-small: ~$15/month each
   - e2-medium: ~$30/month each
   - e2-standard-4: ~$120/month each

2. **Networking** - 20-30% of costs
   - LoadBalancer: ~$20/month each
   - Egress traffic: $0.12/GB (internet)
   - Ingress: Free

3. **Storage** - 5-10% of costs
   - Standard SSD: $0.17/GB/month
   - Premium SSD: $0.34/GB/month
   - Snapshots: $0.026/GB/month

4. **Other**
   - GKE management: Free (1 cluster)
   - Add-ons (cert-manager, ingress): Free
   - Logs/monitoring: Pay for storage

## QuickAI Current Costs

Monthly breakdown:
- 2x e2-small nodes: $30
- 1x LoadBalancer: $20
- Storage: $0 (no PVs)
- Total: ~$50/month

Annual: ~$600/year

## Cost Optimization Strategies

### 1. Right-Size Nodes

Current: 2x e2-small (2 vCPU, 1.7GB each)
Usage: 25% CPU, 84% memory

Options:
A) Stay on e2-small (cheap but limited headroom)
B) Switch to 1x e2-medium (2 vCPU, 4GB) - RISKY
C) Use spot/preemptible nodes (60-70% cheaper)

Recommendation: Enable cluster autoscaler, use spot nodes for dev

### 2. Horizontal Pod Autoscaler (HPA)

Automatically scales pods based on metrics.

kubectl autoscale deployment api --cpu-percent=50 --min=2 --max=10

Benefits:
- Scale up during traffic spikes
- Scale down during low traffic
- Pay only for what you need

Cost impact:
- Normal: 2 pods
- Black Friday: 10 pods (5x more, but only during spike)
- Saves money vs always running 10 pods

### 3. Vertical Pod Autoscaler (VPA)

Automatically adjusts pod resource requests.

NOT RECOMMENDED for production (restarts pods)
Better: Monitor and manually adjust

### 4. Cluster Autoscaler

Automatically adds/removes nodes based on pod demand.

Already enabled in GKE:
gcloud container clusters update quickai-cluster \
  --enable-autoscaling \
  --min-nodes=1 \
  --max-nodes=3

How it works:
- HPA adds pods → Node full → Cluster adds node
- Pods removed → Node empty → Cluster removes node

Cost impact:
- Normal: 1 node ($15/month)
- Traffic spike: 3 nodes ($45/month, but only during spike)
- Average: ~$20-25/month (vs fixed $30)

### 5. Spot/Preemptible Nodes

60-70% cheaper but can be terminated anytime.

Create spot node pool:
gcloud container node-pools create spot-pool \
  --cluster=quickai-cluster \
  --spot \
  --machine-type=e2-small \
  --num-nodes=1

Use for:
- Dev/staging environments
- Batch jobs
- Stateless workloads with replicas

Don't use for:
- Single-replica production apps
- Databases (use regular nodes)

Cost impact:
- Regular e2-small: $15/month
- Spot e2-small: $5/month
- Savings: $10/month per node

### 6. Optimize LoadBalancers

Current: 1 LoadBalancer ($20/month)

Options:
A) Share LoadBalancer (multiple services, one LB)
B) Use Ingress instead of multiple LoadBalancers
C) Use NodePort for internal services

QuickAI setup (optimal):
- 1 Ingress controller LoadBalancer
- All services behind Ingress
- No additional LoadBalancer costs

### 7. Storage Optimization

Best practices:
- Delete unused PVCs
- Use standard SSD (not premium)
- Set PVC reclaimPolicy: Delete
- Clean up old snapshots

Cost example:
- 100GB premium SSD: $34/month
- 100GB standard SSD: $17/month
- Savings: $17/month

### 8. Resource Right-Sizing

Check actual usage vs requests:

kubectl top pods

Example - QuickAI:
- Requested: 100m CPU, 128Mi memory
- Actual: 2m CPU, 50Mi memory
- Over-provisioned by 50x CPU!

Optimization:
resources:
  requests:
    cpu: 10m      # Reduced from 100m
    memory: 64Mi  # Reduced from 128Mi
  limits:
    cpu: 200m
    memory: 256Mi

Impact: Can fit 10x more pods per node

### 9. Namespace-Level Quotas

Prevent cost overruns:

apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    services.loadbalancers: "0"

Result: Dev team can't create expensive resources

### 10. Monitor and Alert

Set up cost alerts:
- GCP Budget alerts at 50%, 80%, 100%
- Monitor node utilization
- Alert on idle nodes (< 20% utilization)

## Autoscaling Architecture

Complete autoscaling stack:

1. HPA (Horizontal Pod Autoscaler)
   - Watches: CPU/memory metrics
   - Scales: Pod replicas (2→10)
   - Reaction time: 30 seconds

2. Cluster Autoscaler
   - Watches: Pending pods (can't schedule)
   - Scales: Nodes (1→3)
   - Reaction time: 2-3 minutes

3. VPA (Vertical Pod Autoscaler)
   - Watches: Actual resource usage
   - Recommends: Resource adjustments
   - Don't use in production (restarts pods)

Example flow:
1. Traffic spike
2. HPA: Scales 2→5 pods
3. Node full, 3 pods pending
4. Cluster Autoscaler: Adds node
5. Pods scheduled on new node
6. Traffic drops
7. HPA: Scales 5→2 pods
8. Node empty (10 min cooldown)
9. Cluster Autoscaler: Removes node

## Cost Optimization Checklist

✅ Enable HPA for stateless apps
✅ Enable Cluster Autoscaler (min=1, max=3)
✅ Right-size resource requests (not limits)
✅ Use spot nodes for dev/staging
✅ Share LoadBalancers via Ingress
✅ Delete unused PVCs
✅ Set namespace quotas
✅ Monitor actual usage monthly
✅ Set GCP budget alerts
✅ Use preemptible nodes where possible

❌ Don't over-provision resources
❌ Don't run separate LB per service
❌ Don't use premium storage for everything
❌ Don't keep dev clusters running 24/7
❌ Don't ignore idle resources

## Real Numbers: QuickAI Optimization

Current (unoptimized):
- 2x e2-small (always on): $30/month
- 1x LoadBalancer: $20/month
- Total: $50/month

Optimized:
- 1-3x e2-small (autoscaling): $15-45/month
- Average usage: ~1.5 nodes = $22/month
- 1x LoadBalancer: $20/month
- Total: $42/month average

Savings: $8/month or 16%

Further optimization (spot nodes):
- 1-3x e2-small spot: $5-15/month
- Average: ~$8/month
- LoadBalancer: $20/month
- Total: $28/month

Savings: $22/month or 44%

## Production Best Practices

1. Use HPA for all stateless apps
2. Set min=2 for HA (high availability)
3. Set max based on budget (not infinite)
4. Use cluster autoscaler with reasonable limits
5. Monitor costs weekly
6. Right-size resources quarterly
7. Use spot nodes for non-critical workloads
8. Implement resource quotas per team

## When NOT to Optimize

Don't optimize:
- Production databases (stability > cost)
- Single-pod critical services (HA > cost)
- Very low-traffic apps (optimization overhead > savings)

Focus optimization on:
- High-replica stateless apps
- Variable traffic patterns
- Development/staging environments
- Batch processing workloads
