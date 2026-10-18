# Online Boutique: real, unmodified

`kubernetes-manifests.yaml` is Google's published deployment file for **Online Boutique**
(images tagged `v0.10.7`), copied byte for byte:

- Downloaded: 2026-10-17
- From: https://raw.githubusercontent.com/GoogleCloudPlatform/microservices-demo/main/release/kubernetes-manifests.yaml
- SHA-256: `ae3c20181c051048e6a5cae51fa530681affa4043ba60ae95d4f39e1262f2744`
- License: Apache License 2.0 (see `LICENSE` in this folder), Copyright 2025 Google LLC

What Multiverse reads from it (see `world.py`):

| Kubernetes field | Becomes in the graph |
|---|---|
| each `Deployment` | an `Asset` (`Service`, or `Datastore` for the Redis image) |
| `env` entries ending in `_ADDR` (for example `CART_SERVICE_ADDR=cartservice:7070`) | a `CALLS` link (or `READS` + `WRITES` to a datastore), confidence 1.0 |
| `spec.replicas` (default 1) and `resources.limits.cpu` | replicas and CPU, used to compute capacity for launch rehearsals |

An address that points at a service with no Deployment in this file is reported as
configuration drift instead of being added. This file has one:
`SHOPPING_ASSISTANT_SERVICE_ADDR=shoppingassistantservice:80` on `frontend`.
