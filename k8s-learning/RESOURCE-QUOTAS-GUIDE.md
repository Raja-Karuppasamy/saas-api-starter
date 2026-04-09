# Resource Quotas & LimitRanges Guide

## The Problem They Solve

Without limits:
- One pod can consume all cluster resources
- Noisy neighbor problem
- Cluster crashes from resource exhaustion
- No cost control

With ResourceQuota + LimitRange:
- Fair resource sharing
- Prevent runaway pods
- Cost control per team/namespace
- Predictable performance

## ResourceQuota (Namespace-Level Limits)

Sets maximum total resources for entire namespace.

apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
    services: "10"
    persistentvolumeclaims: "5"

Enforcement:
- All pods in namespace counted against quota
- New pods rejected if quota exceeded
- Requires all pods to specify resources

## LimitRange (Pod/Container Defaults & Limits)

Sets defaults and enforces per-pod/container limits.

apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-a
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 250m
      memory: 256Mi
    max:
      cpu: 2000m
      memory: 2Gi
    min:
      cpu: 100m
      memory: 128Mi

What it does:
- default: Applied if pod doesn't specify limits
- defaultRequest: Applied if pod doesn't specify requests
- max: Rejects pods exceeding this
- min: Rejects pods below this

## How They Work Together

1. LimitRange checks first (per-container)
2. ResourceQuota checks second (namespace total)

Example:
Namespace has:
- ResourceQuota: 10 CPU total
- LimitRange: 2 CPU max per container

Pod requests 3 CPU:
→ LimitRange rejects (exceeds 2 CPU per container)

Pod requests 1 CPU:
→ LimitRange allows
→ ResourceQuota checks: 9/10 CPU used + 1 = 10/10 → Allows
→ Next pod with 1 CPU → ResourceQuota rejects (11/10)

## ResourceQuota Types

Compute resources:
- requests.cpu
- requests.memory
- limits.cpu
- limits.memory

Object counts:
- pods
- services
- secrets
- configmaps
- persistentvolumeclaims
- services.loadbalancers
- services.nodeports

Storage:
- requests.storage
- persistentvolumeclaims
- {storageclass}.storageclass.storage.k8s.io/requests.storage

## LimitRange Types

Container-level:
spec:
  limits:
  - type: Container
    max:
      cpu: 2
      memory: 2Gi

Pod-level (all containers combined):
spec:
  limits:
  - type: Pod
    max:
      cpu: 4
      memory: 4Gi

PersistentVolumeClaim:
spec:
  limits:
  - type: PersistentVolumeClaim
    max:
      storage: 10Gi
    min:
      storage: 1Gi

## Real-World Example: Multi-Team Cluster

Team A (Production):
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-a-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    pods: "100"

Team B (Staging):
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-b-quota
  namespace: team-b
spec:
  hard:
    requests.cpu: "5"
    requests.memory: 10Gi
    pods: "20"

Result:
- Team A gets more resources (production)
- Team B limited (staging environment)
- Teams can't starve each other

## Cost Control Example

Development namespace (cheap):
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    services.loadbalancers: "0"  # No expensive LBs

Production namespace ($$):
spec:
  hard:
    requests.cpu: "50"
    requests.memory: 100Gi
    services.loadbalancers: "5"

## Default vs Requests vs Limits

Requests: Guaranteed resources
- Scheduler uses this for placement
- Pod guaranteed to get this much

Limits: Maximum resources
- Pod can use up to this
- Exceeding memory limit → OOMKilled
- Exceeding CPU limit → throttled

Default (from LimitRange):
- Applied if pod doesn't specify
- Prevents "forgot to set limits" mistakes

## Checking Quota Usage

kubectl get resourcequota -n team-a
kubectl describe resourcequota compute-quota -n team-a

Output:
Resource         Used   Hard
--------         ----   ----
requests.cpu     8      20
requests.memory  16Gi   40Gi
pods             12     100

Interpretation:
- Using 8/20 CPUs (40%)
- Using 16Gi/40Gi memory (40%)
- Running 12/100 pods (12%)

## Common Patterns

Prevent LimitRange bypass:
- Set both default and max
- Pods without limits get default
- Pods with excessive limits rejected

Tiered namespaces:
- namespace-prod: Large quota
- namespace-staging: Medium quota
- namespace-dev: Small quota

Storage quotas:
spec:
  hard:
    requests.storage: "100Gi"
    persistentvolumeclaims: "10"

Prevents unlimited PVC creation

## Troubleshooting

Pod won't create - "forbidden: exceeded quota":
→ Check: kubectl describe resourcequota -n namespace
→ Solution: Delete unused resources or increase quota

Pod won't create - "must specify limits":
→ Cause: ResourceQuota exists but no LimitRange
→ Solution: Add LimitRange or specify resources in pod

Pod got unexpected limits:
→ Cause: LimitRange applied defaults
→ Solution: Specify explicit resources in pod

## Best Practices

✅ Always use ResourceQuota in multi-tenant clusters
✅ Always pair ResourceQuota with LimitRange
✅ Set sensible defaults in LimitRange
✅ Monitor quota usage regularly
✅ Set quotas per team/environment
✅ Document quota policies

❌ Don't set quotas too low (pods won't schedule)
❌ Don't forget LimitRange (pods must specify resources)
❌ Don't use same quota for dev and prod
❌ Don't set max limits too high (defeats purpose)

## QuickAI Production Example

Production namespace:
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quickai-prod-quota
  namespace: quickai-prod
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
    services.loadbalancers: "3"
    persistentvolumeclaims: "5"

---
apiVersion: v1
kind: LimitRange
metadata:
  name: quickai-prod-limits
  namespace: quickai-prod
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 250m
      memory: 256Mi
    max:
      cpu: 4000m
      memory: 4Gi
    min:
      cpu: 50m
      memory: 64Mi

Result:
- Can run ~40 QuickAI pods (250m each = 10 CPU total)
- Individual pod can't exceed 4 CPU
- Automatic defaults prevent "forgot limits" errors
- Costs predictable and controlled
