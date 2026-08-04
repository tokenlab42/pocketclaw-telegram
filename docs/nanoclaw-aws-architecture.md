# NanoClaw — AWS Architecture (WhatsApp Cloud API)

Logical architecture, no VPC/subnet/security-group detail. Migrated from the native Baileys adapter (outbound-only, no public endpoint) to WhatsApp Cloud API, which requires EC2 to be **publicly reachable** for Meta's inbound webhook.

## Flow

1. **WhatsApp Cloud API → EC2**: Meta sends an **inbound HTTPS webhook** (`POST /webhook/whatsapp-cloud`, signed payload) whenever a message arrives. TLS is terminated on the instance itself (nginx + certbot in front of the framework's built-in webhook server on port 3000) — there is no load balancer or API Gateway in front of it.
2. **Host → Agent Docker containers**: inbound messages are routed into per-agent-group Docker containers that the host process spawns and wakes on EC2.
3. **Containers → Bedrock** *(planned, dashed — not yet wired in code)*: agent containers will call Amazon Bedrock for AI inference. This is a migration target only; today inference goes elsewhere.
4. **Containers → EBS**: the attached EBS volume backs two local-I/O workloads that need fast filesystem access: 4 self-hosted Chroma vector DB collections (chunked knowledge bases) and the SQLite files (central `v2.db` plus per-session `inbound.db` / `outbound.db` pairs). EBS is drawn **inside** the EC2 box in the diagram — it's block storage physically attached to this one instance, not a separately-networked service, so `inbound.db`/`outbound.db` are conceptually part of the instance, not an external dependency.
5. **Containers → S3**: agent containers write user-uploaded files, application logs, and generated/processed images to S3 for durable object storage. S3 is drawn **outside** the EC2 box — unlike EBS, it's reached over the network and durable independent of any single instance.

## Services

| Service | Purpose |
|---|---|
| EC2 | Single instance running the NanoClaw host (Node) — now also terminates TLS and receives Meta's inbound webhook — plus the Docker containers it spawns per agent group |
| EBS | Block storage attached to the EC2 instance — Chroma vector collections + SQLite session/central DBs (`v2.db`, `inbound.db`, `outbound.db`). Local to the instance, drawn inside the EC2 boundary. |
| Bedrock | AI inference API (planned migration target — not yet wired) |
| S3 | Object storage for uploads, logs, and generated/processed images. Reached over the network, drawn outside the EC2 boundary. |
| WhatsApp Cloud API (external) | Meta's official API — non-AWS system, reaches EC2 via a signed inbound HTTPS webhook |

## Key design decisions

- **Public endpoint is now required.** Unlike Baileys (outbound-only, no listener needed), WhatsApp Cloud API delivers messages by calling *into* our server. EC2 now needs a public IP/domain and a valid TLS certificate for Meta's webhook handshake to succeed.
- **TLS terminated on-instance, not via a load balancer.** Per the team's choice, nginx + certbot run directly on the EC2 instance and reverse-proxy to the framework's built-in webhook server (`src/webhook-server.ts`, port 3000). No ALB/API Gateway was introduced — simplest option for the current single-instance setup. Revisit this if/when the deployment scales beyond one instance, since the public endpoint would then need to be decoupled from any single box.
- **Colocated storage.** Chroma and SQLite both need low-latency local filesystem access and durability tied to the instance's lifecycle, so both live on the same attached EBS volume rather than a managed DB service.
- **Bedrock shown as planned, not live.** The dashed edge reflects that Bedrock is the intended inference target but is not yet wired into the codebase — do not read this diagram as current production traffic.

## Migration status (as of 2026-07-20)

Per `WHATSAPP_MIGRATION_PLAN.md` in the repo root: the Cloud API adapter code, registration, and credentials are already in place, but the live database wiring (`messaging_group_agents`) still points at the old Baileys messaging group. This diagram reflects the **target** architecture once that wiring is switched over and Baileys is removed (Phases 5–7 of the plan) — not what's serving live traffic today.
