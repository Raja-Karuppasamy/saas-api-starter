# StatefulSets & Persistent Storage Guide

## What We Learned

### Deployments vs StatefulSets

**Deployments (Stateless Apps):**
- Pod names: Random hash (api-7d45d79dc-22p74)
- Storage: Ephemeral (lost on restart)
- Order: Pods start/stop randomly
- Identity: Pods are interchangeable
- Use for: APIs, web servers, stateless workers

**StatefulSets (Stateful Apps):**
- Pod names: Ordered, stable (redis-0, redis-1, redis-2)
- Storage: Persistent (survives restarts)
- Order: Sequential startup (0 → 1 → 2)
- Identity: Each pod has unique identity
- Use for: Databases, Kafka, Zookeeper, Redis

### Persistent Storage Components

**PersistentVolume (PV):**
- Actual storage (GCP disk, AWS EBS, etc.)
- Created automatically by StorageClass
- Lifecycle independent of pods

**PersistentVolumeClaim (PVC):**
- Request for storage
- Binds to a PV
- Pod mounts PVC

**StorageClass:**
- Defines type of storage (SSD, HDD, etc.)
- Auto-provisions PVs on demand
- GKE default: standard-rwo (SSD)

### How Data Persists

1. StatefulSet creates pod: redis-0
2. volumeClaimTemplate creates PVC: redis-data-redis-0
3. PVC binds to PV (GCP creates 1Gi disk)
4. Pod mounts PVC at /data
5. Redis writes data to /data
6. Pod deleted/crashes
7. New redis-0 pod created
8. Same PVC reattached (redis-data-redis-0)
9. Data still there!

### DNS in StatefulSets

**Headless Service (clusterIP: None):**
- No load balancing
- Each pod gets unique DNS name

**DNS pattern:**
{pod-name}.{service-name}.{namespace}.svc.cluster.local

Examples:
- redis-0.redis.default.svc.cluster.local
- redis-1.redis.default.svc.cluster.local
- redis-2.redis.default.svc.cluster.local

### When to Use StatefulSets

**Use StatefulSets when:**
- App needs persistent storage
- Pods need stable network identities
- Ordered deployment/scaling required
- Examples: PostgreSQL, MySQL, Cassandra, Kafka

**Use Deployments when:**
- App is stateless
- Any pod can handle any request
- Order doesn't matter
- Examples: REST APIs, web servers, workers (QuickAI!)

### Storage Classes in GKE

- **standard-rwo** (default): Standard SSD, ReadWriteOnce
- **premium-rwo**: Premium SSD (faster, more expensive)
- **dynamic-rwo**: Dynamic provisioning

**ReadWriteOnce (RWO):** Only one pod can mount
**ReadWriteMany (RWX):** Multiple pods can mount

### Cost Implications

**Storage costs:**
- Standard SSD: ~$0.17/GB/month
- Premium SSD: ~$0.34/GB/month
- 3x 1Gi PVCs = ~$0.50/month

**Reclaim Policy:**
- Delete (default): PV deleted when PVC deleted
- Retain: PV kept even after PVC deletion

### Real Example: Our Redis Test

Data written:
kubectl exec redis-0 -- redis-cli SET mykey 'StatefulSets are awesome!'

Pod deleted:
kubectl delete pod redis-0

New pod created with SAME NAME, SAME PVC reattached.

Data survived:
kubectl exec redis-0 -- redis-cli GET mykey
Output: StatefulSets are awesome!

This is why databases use StatefulSets!
