# Multi-Container Pod Patterns Guide

## Why Multiple Containers in One Pod?

Containers in same pod share:
- Network namespace (communicate via localhost)
- Storage volumes (share files)
- Same node (scheduled together)
- Lifecycle (start/stop together)

## Init Containers

Run BEFORE main containers, sequentially, and must complete successfully.

Use cases:
- Database migrations
- Configuration setup
- Wait for dependencies
- Clone Git repos
- Warm caches

Example:
spec:
  initContainers:
  - name: migrate
    image: migrate/migrate
    command: ["migrate", "up"]
  - name: seed-data
    image: postgres
    command: ["psql", "-f", "seed.sql"]
  
  containers:
  - name: app
    image: myapp

Execution order:
1. migrate runs → completes
2. seed-data runs → completes
3. app starts

If any init container fails, pod restarts from beginning.

## Sidecar Pattern

Helper container runs alongside main container.

Use cases:
- Log shipping (Fluentd, Filebeat)
- Metrics collection (Prometheus exporter)
- Configuration sync
- Service mesh proxy (Envoy, Linkerd)
- Git sync

Example - Log Shipper:
spec:
  volumes:
  - name: logs
    emptyDir: {}
  
  containers:
  - name: app
    volumeMounts:
    - name: logs
      mountPath: /var/log
  
  - name: log-shipper
    image: fluentd
    volumeMounts:
    - name: logs
      mountPath: /var/log

App writes logs → Sidecar ships to external service

## Ambassador Pattern

Proxy container simplifies connections to external services.

Use case: Database connection pooling

spec:
  containers:
  - name: app
    # Connects to localhost:5432
    env:
    - name: DB_HOST
      value: localhost
  
  - name: db-proxy
    image: pgbouncer
    # Proxies to real database
    # Handles connection pooling

App connects to localhost → Ambassador proxies to real DB

## Adapter Pattern

Container normalizes/transforms output for external systems.

Use case: Convert app logs to standard format

spec:
  containers:
  - name: app
    # Writes custom log format
  
  - name: adapter
    # Reads custom logs
    # Converts to JSON
    # Sends to logging service

## Real-World Patterns

Database Migration Init Container:
initContainers:
- name: migrate
  image: migrate/migrate
  command:
  - migrate
  - -path
  - /migrations
  - -database
  - $(DATABASE_URL)
  - up
  env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: url

Service Mesh Sidecar (Istio):
containers:
- name: app
  ports:
  - containerPort: 8080

- name: istio-proxy
  image: istio/proxyv2
  # Intercepts all traffic
  # Provides: mTLS, observability, retries

Log Aggregation Sidecar:
volumes:
- name: logs
  emptyDir: {}

containers:
- name: app
  volumeMounts:
  - name: logs
    mountPath: /var/log/app

- name: fluentd
  image: fluent/fluentd
  volumeMounts:
  - name: logs
    mountPath: /var/log/app
  env:
  - name: FLUENT_ELASTICSEARCH_HOST
    value: elasticsearch.logging.svc

Configuration Sync Sidecar:
containers:
- name: app
  volumeMounts:
  - name: config
    mountPath: /etc/config

- name: config-sync
  image: git-sync
  volumeMounts:
  - name: config
    mountPath: /config
  env:
  - name: GIT_SYNC_REPO
    value: https://github.com/company/configs
  - name: GIT_SYNC_BRANCH
    value: main

## Init Container Lifecycle

1. Pod created
2. Init container 1 starts
3. Init container 1 completes (exit 0)
4. Init container 2 starts
5. Init container 2 completes
6. Main containers start (all at once)

If init fails:
- Pod restarts
- All init containers run again from beginning
- Respects restartPolicy

## Sidecar Lifecycle

Start: With main container (parallel)
Stop: With main container
Restart: Independent (can crash/restart separately)

Pod shows: 2/2 Running (both containers healthy)

## Resource Considerations

Each container has own resource limits:

containers:
- name: app
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

- name: sidecar
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi

Total pod resources: Sum of all containers

## Communication Between Containers

Network (localhost):
- App container: localhost:8080
- Sidecar can connect: curl localhost:8080

Shared volumes:
- App writes: /var/log/app.log
- Sidecar reads: /var/log/app.log

Process signals:
- Cannot send signals between containers
- Use files or network for IPC

## Best Practices

✅ Use init containers for setup tasks only
✅ Keep sidecars small and focused (single responsibility)
✅ Set appropriate resource limits for each container
✅ Use emptyDir for temporary shared storage
✅ Use localhost for inter-container communication
✅ Make init containers idempotent (can run multiple times)

❌ Don't use init containers for long-running tasks
❌ Don't put unrelated containers in same pod
❌ Don't share volumes unless necessary
❌ Don't assume container startup order (main containers)
❌ Don't use sidecars when external service works better

## When to Use Multi-Container Pods

Use when containers:
- Must run on same node
- Share storage/network tightly
- Have tightly coupled lifecycle
- Work together as single unit

Don't use when:
- Containers can run independently
- Different scaling requirements
- Can communicate via network services
- Different update cycles

## QuickAI Real-World Example

initContainers:
- name: db-migrate
  image: rajajeba/saas-api:latest
  command: ["npm", "run", "migrate"]
  envFrom:
  - secretRef:
      name: quickai-secrets

volumes:
- name: logs
  emptyDir: {}

containers:
- name: api
  image: rajajeba/saas-api:latest
  volumeMounts:
  - name: logs
    mountPath: /var/log/app

- name: log-shipper
  image: fluent/fluentd
  volumeMounts:
  - name: logs
    mountPath: /var/log/app
  env:
  - name: FLUENTD_CONF
    value: fluentd.conf

Result:
1. Migrations run before API starts
2. API and log shipper run together
3. Logs shipped to external service
