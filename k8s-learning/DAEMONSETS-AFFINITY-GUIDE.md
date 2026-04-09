# DaemonSets & Node Affinity Guide

## DaemonSets

Purpose: Run exactly ONE pod on EVERY node.

Use cases:
- Log collectors (Fluentd, Filebeat)
- Monitoring agents (Prometheus Node Exporter)
- Storage daemons (Ceph, GlusterFS)
- Network plugins (Calico, Weave)

Key characteristics:
- Automatically creates pod on new nodes
- Automatically removes pod when node deleted
- Cannot be manually scaled
- Ignores unschedulable nodes (unless tolerations set)

Basic DaemonSet:
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-collector
spec:
  selector:
    matchLabels:
      app: log-collector
  template:
    metadata:
      labels:
        app: log-collector
    spec:
      containers:
      - name: collector
        image: fluentd

## DaemonSet vs Deployment

DaemonSet:
- Replicas: 1 per node (automatic)
- Scaling: Tied to node count
- Use: Node-level services

Deployment:
- Replicas: You specify
- Scaling: Manual or HPA
- Use: Application workloads

## Node Affinity

Control which nodes pods can run on.

Pod Anti-Affinity (spread pods):
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchLabels:
            app: api
        topologyKey: kubernetes.io/hostname

Result: Scheduler tries to place pods on different nodes.

Node Affinity (require specific nodes):
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: disktype
          operator: In
          values:
          - ssd

Result: Pod only runs on nodes with label disktype=ssd.

## Affinity Types

requiredDuringSchedulingIgnoredDuringExecution:
- MUST match (hard requirement)
- Pod won't schedule if no matching node

preferredDuringSchedulingIgnoredDuringExecution:
- SHOULD match (soft preference)
- Scheduler tries but can ignore if needed

## Node Selectors (Simple)

Simplest way to control placement:

spec:
  nodeSelector:
    disktype: ssd

Only schedules on nodes with label disktype=ssd.

## Taints & Tolerations

Taints: Mark nodes to repel pods
Tolerations: Allow pods to tolerate taints

Example - Dedicated nodes:
kubectl taint nodes node1 dedicated=gpu:NoSchedule

Only pods with this toleration can schedule:
tolerations:
- key: dedicated
  operator: Equal
  value: gpu
  effect: NoSchedule

## Real-World Examples

Log Collector DaemonSet:
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
spec:
  selector:
    matchLabels:
      app: fluentd
  template:
    spec:
      containers:
      - name: fluentd
        image: fluent/fluentd:v1.16
        volumeMounts:
        - name: varlog
          mountPath: /var/log
      volumes:
      - name: varlog
        hostPath:
          path: /var/log

High Availability Deployment:
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: database
      topologyKey: kubernetes.io/hostname

Result: Database pods MUST be on different nodes.

GPU Workload:
nodeSelector:
  accelerator: nvidia-tesla-v100

Result: Only runs on nodes with V100 GPUs.

## Scheduler Priorities

When scheduler decides placement:
1. Node with enough resources
2. Affinity/anti-affinity rules
3. Taints/tolerations
4. Resource balance across nodes

In our QuickAI example:
- Anti-affinity said: "prefer different nodes"
- Node 1: 97% CPU (almost full)
- Node 2: 74% CPU (more space)
- Scheduler chose: Node 2 (resources > affinity preference)

## Best Practices

✅ Use DaemonSets for node-level services only
✅ Use podAntiAffinity for HA deployments
✅ Use nodeSelector for simple requirements
✅ Use nodeAffinity for complex requirements
✅ Always set resource requests/limits

❌ Don't use DaemonSets for application workloads
❌ Don't use requiredDuringScheduling unless truly required
❌ Don't over-taint nodes (pods won't schedule)

## Common Patterns

Monitoring on all nodes:
DaemonSet + hostPath volumes + privileged mode

Database HA:
StatefulSet + podAntiAffinity (required)

GPU workloads:
Deployment + nodeSelector (gpu=true)

Spot instances:
Deployment + nodeAffinity (prefer spot) + tolerations
