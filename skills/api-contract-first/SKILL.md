---
name: api-contract-first
description: Designing APIs contract-first with backward compatibility guarantees, clear versioning strategy, error semantics, idempotency, and pagination. The API is a promise—never break existing clients.
leadership_principles:
  - Customer Obsession
  - Think Big
  - Invent and Simplify
  - Insist on the Highest Standards
  - Bias for Action
metadata:
  hermes:
    tags: [api, contract, design, workflow]
---

# Contract-First API Design

## Overview

Contract-first means you design the API before you write implementation code. The API contract is a binding agreement with your clients: once published, it cannot be broken. This approach forces you to think from the client's perspective, establish clear semantics upfront, and create a stable interface that enables independent evolution of client and server.

At scale, APIs are used by clients you don't know, in ways you didn't anticipate, depending on behaviors you never documented. Hyrum's Law is absolute: "With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody." This means every response header, every error format, every ordering behavior becomes part of your contract whether you intended it or not.

### What counts as an API

An API is **any contract through which a client consumes functionality**. The protocol does not change the rule — but **the standard you use to express the contract does change with the protocol.** Picking the right standard matters. OpenAPI is not the universal answer; it is the answer for *one* of the protocols below.

### Pick the right contract standard for the protocol

| Protocol / surface | Recommended contract standard | Artifact filename example |
|---|---|---|
| **REST / HTTP** | **OpenAPI 3.x** (canonical for REST). **Smithy** if you're in the AWS service style and want SDK code-gen. | `openapi.yaml`, `service.smithy` |
| **GraphQL** | **GraphQL SDL** — the schema *is* the contract; `.graphql` schema file with queries, mutations, subscriptions, types. Optionally publish via Apollo Federation / Schema Registry. | `schema.graphql` |
| **gRPC** | **Protocol Buffers** (`.proto`). Use `proto3`. The `.proto` is the contract; everything else (clients, servers, docs) is generated from it. | `service.proto` |
| **Async / event-driven** (SQS, Kinesis, MSK / Kafka, EventBridge, SNS, RabbitMQ) | **AsyncAPI 3.x** for the channel-and-operation level (the equivalent of OpenAPI for async). For the **payload schema itself**, pair with **JSON Schema**, **Avro**, or **Protobuf** depending on your serializer. EventBridge: also publish the event schema in the EventBridge Schema Registry. | `asyncapi.yaml` + `schemas/payment-requested.avsc` |
| **Data contracts** (warehouse tables, lakehouse, topics, file formats consumed by downstream pipelines) | **Open Data Contract Standard (ODCS)** when available — the emerging standard for producer ↔ consumer agreements on data products. Otherwise use the schema-language native to the store: **dbt contracts** for warehouse tables, **Iceberg / Delta schema** for lakehouse, **Avro / Protobuf / JSON Schema** for topics. | `data-contract.yaml` (ODCS), `model.yml` (dbt) |
| **MCP tool surface** | **MCP server manifest** — the tool definitions exposed by the server (name, parameters, return shape, side-effect declaration, JSON Schema for arguments). | `mcp-tools.json` |
| **AI agent tool definitions** | **Agent tool spec** — provider-native (Anthropic tool use, OpenAI tools, Bedrock agent action groups). Underlying input shape is JSON Schema. | `tools.json` |
| **Webhooks** (outbound events you publish to subscribers) | **AsyncAPI** (treats publisher-to-subscriber as first-class) or **OpenAPI** if you describe the receiver-side endpoint contract. JSON Schema for the payload. | `webhooks.asyncapi.yaml` |
| **CLI public surface** | Commands, flags, exit codes, output schemas (JSON output: JSON Schema). No single industry standard — document explicitly. | `cli-contract.md` + `output-schemas/` |
| **SDK public surface** | Language-native interface definitions (Java interfaces, TypeScript `.d.ts`, Python `.pyi`). Generate from the underlying API standard when possible (OpenAPI / Smithy / Proto). | generated from upstream contract |

### Choosing rules

When picking the standard, the agent applies these rules in order:

1. **Match the protocol's native standard.** Don't write OpenAPI for a gRPC service; don't try to express GraphQL in OpenAPI; don't describe Kafka payloads with REST conventions.
2. **Pick the standard most clients can consume.** If your clients already have a Schema Registry or a SDK code-generator, use the standard that feeds those tools.
3. **One protocol, one canonical artifact.** If a service exposes both REST and events, produce **both** an `openapi.yaml` and an `asyncapi.yaml` — they describe different surfaces. Do not try to merge them.
4. **Default standards (when the user has no preference and no existing tooling):**
   - REST → OpenAPI 3.x
   - Async / events → AsyncAPI 3.x + JSON Schema (or Avro for Kafka environments)
   - gRPC → `.proto` (proto3)
   - GraphQL → SDL
   - Data contracts → ODCS when both producer and consumer can adopt it; otherwise the store's native schema language

### Who is the client

Anything that consumes the API: a web UI, a mobile app, a CLI, an SDK, an MCP server, an AI agent, another internal service, a partner integration, a batch ETL job. **All clients are equivalent from the contract's point of view.** The word "frontend" is too narrow — use "client" or "API consumer".

This is the direct application of Amazon's 2002 API Mandate: every team exposes its functionality only through APIs, and there is no other way to consume what another team built.

## When to Use

- Before writing any implementation code for a new service
- Before any client (UI, CLI, SDK, MCP, AI agent, partner) is built
- When adding new endpoints, tools, events, or messages to an existing service
- When modifying existing API behavior (to verify backward compatibility)
- When designing inter-service communication contracts
- When building APIs that will be consumed by external customers
- When creating event schemas for async communication (events are APIs too)
- When exposing tools to AI agents or MCP clients (agent tools are APIs too)

## Amazon Context

Amazon services are decoupled and communicate through well-defined APIs. A team owns its API surface completely and is responsible for never breaking clients. AWS public APIs are forever—once released, they cannot be removed or have their behavior changed. This discipline applies internally as well: internal APIs have clients you've never met, in organizations you've never heard of. Breaking them causes cascading failures.

The principle "APIs are forever" drives extreme care in API design. It's far better to ship a minimal API and extend it than to ship a broad API and discover parts of it are wrong. You can always add; you can never remove.

## The Process

### 1. Define the Contract First

Before any implementation:

1. **Write the API specification** (OpenAPI/Swagger, Smithy, Protocol Buffers, or GraphQL schema)
2. **Write example requests and responses** for every operation
3. **Write error cases** — every way a request can fail and what the client receives
4. **Review the contract** with at least one client team (or simulate a client)
5. **Generate client mocks** from the spec so client teams can integrate immediately

The implementation serves the contract. Never let implementation convenience dictate API shape.

### 2. Backward Compatibility Rules

#### What You Can Do (Non-Breaking)

- Add a new optional field to a request body
- Add a new field to a response body (clients MUST ignore unknown fields)
- Add a new endpoint/operation
- Add a new optional query parameter
- Add a new enum value (if clients handle unknown values gracefully)
- Loosen a validation constraint (accept more inputs than before)
- Add a new error code (clients must handle unknown error codes)

#### What You Cannot Do (Breaking)

- Remove or rename a field from a response
- Remove or rename a request parameter
- Change the type of a field
- Make an optional field required
- Change the semantic meaning of a field
- Tighten a validation constraint (reject previously accepted inputs)
- Change the default value of a field
- Change error codes for existing failure modes
- Remove an enum value
- Change the URL/path of an endpoint
- Change authentication requirements

#### Hyrum's Law in Practice

Even these "safe" changes can break clients in practice:
- Adding a response field can break clients that do strict deserialization
- Changing response ordering (even if undocumented) breaks clients that depend on position
- Changing timing characteristics breaks clients with tight timeouts
- Changing the format of a string field (even if the schema says "string") breaks parsers

**Mitigation**: Use integration tests with real client traffic patterns. Monitor error rates after every deployment. Use canary deployments for API changes.

### 3. Versioning Strategy

Choose one strategy and apply it consistently:

#### URL Path Versioning (Recommended for REST)

```
/v1/resources
/v2/resources
```

- **When to create v2**: Only when a breaking change is absolutely necessary
- **v1 lifetime**: Minimum 12 months after v2 GA; 24 months preferred
- **Migration support**: Provide automated migration tooling for clients

#### Header Versioning

```
Accept: application/vnd.company.resource.v1+json
```

- Keeps URLs clean but harder to debug and cache
- Use when you need fine-grained versioning per-resource

#### Additive Versioning (Preferred at Amazon)

```
POST /resources
X-Api-Version: 2024-01-15
```

- Date-based versions
- Each version is a snapshot of behavior
- New clients get latest; existing clients are frozen at their declared version
- Server maintains backward compatibility for all declared versions

**Key principle**: Never require clients to migrate. If they're on v1 and it works, it should keep working indefinitely.

### 4. Error Semantics

#### Standard Error Response Format

```json
{
  "type": "https://api.example.com/errors/resource-not-found",
  "error_code": "RESOURCE_NOT_FOUND",
  "message": "Order with ID 'ord-123' was not found",
  "request_id": "req-abc-def-123",
  "timestamp": "2024-01-15T10:30:00Z",
  "details": [
    {
      "field": "order_id",
      "issue": "No order exists with this identifier",
      "suggestion": "Verify the order ID and try again"
    }
  ],
  "retry_after_ms": null
}
```

#### Error Design Principles

1. **Use HTTP status codes correctly**: 4xx for client errors, 5xx for server errors. Never return 200 with an error body.
2. **Machine-readable error codes**: Clients switch on `error_code`, not on `message` text.
3. **Human-readable messages**: For debugging, not for display to end users.
4. **Request ID in every response**: Enables correlation for debugging.
5. **Retry guidance**: Tell the client if and when to retry (`retry_after_ms`).
6. **Stable error codes**: Once published, an error code's semantics cannot change.

#### Error Categories

| Status | Error Code Pattern | Client Action |
|--------|-------------------|---------------|
| 400 | `INVALID_*` | Fix request, do not retry |
| 401 | `AUTHENTICATION_*` | Re-authenticate, then retry |
| 403 | `AUTHORIZATION_*` | Do not retry; insufficient permissions |
| 404 | `NOT_FOUND` | Resource doesn't exist; may retry if race condition |
| 409 | `CONFLICT_*` | Resolve conflict (e.g., version mismatch), then retry |
| 429 | `RATE_LIMITED` | Retry after `retry_after_ms` with exponential backoff |
| 500 | `INTERNAL_ERROR` | Retry with exponential backoff |
| 503 | `SERVICE_UNAVAILABLE` | Retry with exponential backoff |

### 5. Idempotency

#### Why Idempotency Matters

Networks are unreliable. Clients will retry. If a request succeeds but the response is lost, the client retries what was already processed. Without idempotency, this causes duplicate actions (double charges, double sends, duplicate records).

#### Implementation Pattern

```
POST /v1/payments
Idempotency-Key: client-generated-uuid

{
  "amount": 100,
  "currency": "USD",
  "recipient": "user-456"
}
```

**Rules:**
1. **Client provides idempotency key**: UUID generated client-side, included in request header
2. **Server stores result**: On first execution, store the response keyed by idempotency key
3. **Duplicate detection**: On subsequent requests with same key, return stored response (don't re-execute)
4. **Key expiration**: Idempotency keys expire after a defined window (e.g., 24 hours)
5. **Scope**: Key is scoped to the authenticated client (different clients can use the same key value)

#### Which Operations Need Idempotency

| Operation Type | Naturally Idempotent? | Needs Idempotency Key? |
|---------------|----------------------|----------------------|
| GET | Yes (reads are safe) | No |
| PUT (full replace) | Yes (same input = same state) | No |
| DELETE | Yes (deleting deleted = no-op) | No |
| POST (create) | No | **Yes** |
| PATCH (partial update) | Depends | **Yes** (for non-commutative updates) |

#### Idempotency Key Storage

```
Table: idempotency_keys
├── key: string (PK) — The idempotency key
├── client_id: string — Which client submitted it
├── status: enum — PROCESSING | COMPLETED | FAILED
├── request_hash: string — Hash of request body (detect misuse)
├── response: blob — Stored response to return on replay
├── created_at: timestamp
└── expires_at: timestamp (TTL)
```

### 6. Pagination

#### Cursor-Based Pagination (Recommended)

```
GET /v1/orders?limit=20
→ Response includes: "next_cursor": "eyJpZCI6IjEyMyJ9"

GET /v1/orders?limit=20&cursor=eyJpZCI6IjEyMyJ9
→ Next page
```

**Why cursor-based over offset-based:**
- Stable: Adding/removing items doesn't cause duplicates or skips
- Performant: Doesn't require counting rows
- Scalable: Works with distributed databases

**Cursor design:**
- Opaque to client (base64-encoded, encrypted, or signed)
- Contains: last seen sort key + tiebreaker (never just an offset)
- Signed or encrypted to prevent tampering

#### Pagination Response Format

```json
{
  "items": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6IjEyMyJ9",
    "has_more": true,
    "total_count": null
  }
}
```

**Rules:**
1. **Default limit**: Always have a default (e.g., 20). Never return unbounded results.
2. **Maximum limit**: Enforce a ceiling (e.g., 100). Reject requests above it.
3. **Total count**: Optional. Expensive to compute at scale. Use `has_more` boolean instead.
4. **Cursor lifetime**: Document how long cursors remain valid (e.g., 24 hours).
5. **Empty pages**: A page with zero items + `has_more: false` = end of results.

### 7. Additional Contract Concerns

#### Request Validation

- Validate early, fail fast, return all validation errors at once (not one at a time)
- Document maximum request body size
- Document maximum field lengths
- Document allowed character sets
- Use consistent validation error format across all endpoints

#### Rate Limiting

- Document rate limits in API docs AND in response headers
- Return `429 Too Many Requests` with `Retry-After` header
- Use token bucket or sliding window algorithm
- Different limits for different operation types (reads vs. writes)
- Provide rate limit headers on every response:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 47
  X-RateLimit-Reset: 1640000000
  ```

#### Timeouts and Deadlines

- Document expected response times (p50, p99)
- Support client-provided deadlines (`X-Request-Deadline: <timestamp>`)
- Server should abandon work if deadline has passed
- Client timeout should be > server p99 latency

#### Deprecation Process

1. Announce deprecation (minimum 6 months before removal)
2. Add `Sunset` header to deprecated endpoint responses
3. Log usage of deprecated endpoints; contact active users directly
4. Only remove when zero traffic for 30 consecutive days
5. Never remove without replacement functionality available

## Mechanisms Over Good Intentions

| Intention | Mechanism |
|-----------|-----------|
| "I'll keep the API backward compatible" | Contract tests run in CI that compare new schema against published baseline; any breaking change fails the build |
| "I'll document the API properly" | API spec is generated from code annotations; if the code doesn't have annotations, the endpoint doesn't exist |
| "I'll add idempotency later" | Framework requires idempotency key for all POST/PATCH operations; implementation fails without it |
| "I'll handle pagination when we have more data" | Framework enforces maximum response size; unbounded queries are rejected at compile time |
| "I'll communicate deprecations to clients" | Automated deprecation scanner finds usage and files tickets with consuming teams |

## Common Rationalizations

| What They Say | Why It's Wrong | What To Do Instead |
|---------------|---------------|-------------------|
| "No one uses that field, we can remove it" | You don't know every client. Hyrum's Law: if it's observable, someone depends on it. | Deprecate it: stop documenting, stop using in new clients, but keep returning it. Remove only after zero-traffic verification. |
| "We'll version when we need to" | By the time you need to version, you've already broken clients. Versioning strategy must exist from day one. | Design your versioning strategy in the contract. Make the first version explicit (v1, not versionless). |
| "The error message explains what happened" | Clients parse error codes, not messages. If your error handling depends on message text, you're one rewording away from breaking clients. | Use machine-readable error codes. Messages are for humans debugging, codes are for machines branching. |
| "We'll add pagination later when the data grows" | By the time data grows, clients are depending on getting all results in one call. Adding pagination is a breaking change. | Paginate from day one. Even if there's only 3 items. The contract includes pagination from the start. |
| "Our internal API doesn't need this rigor" | Internal APIs become external APIs. Internal clients are still clients. Internal breakages still cause outages. | Apply the same rigor. The only difference is you might iterate faster on internal APIs, but you still don't break them. |

## Red Flags

- API spec was written after implementation (spec describes code, not the other way around)
- No contract tests in CI comparing against published baseline
- Error responses are unstructured strings or vary between endpoints
- POST endpoints don't require idempotency keys
- Responses return unbounded lists without pagination
- API has no version indicator (URL, header, or query param)
- Changing response field names or types without version bump
- Rate limiting returns 500 instead of 429
- No request ID in responses (impossible to debug issues)
- Documentation says "this field may be removed in the future" (it won't be; you just made it permanent by shipping it)
- Client SDKs are hand-written rather than generated from the spec

## Verification

- [ ] API specification exists BEFORE implementation code
- [ ] Contract tests run in CI and block breaking changes
- [ ] Error responses follow a consistent, documented format with machine-readable codes
- [ ] All POST/PATCH endpoints require idempotency keys
- [ ] All list endpoints are paginated with cursor-based pagination
- [ ] Rate limits are documented and enforced with proper 429 responses
- [ ] Versioning strategy is defined and the current version is explicit
- [ ] Request ID is included in every response
- [ ] Deprecation policy is documented with minimum sunset period
- [ ] Client SDKs are generated from the API spec (not hand-written)
- [ ] API spec includes example requests and responses for every operation
- [ ] Backward compatibility is verified automatically on every build

## Tenets

1. **The API is a promise.** Once published, it's permanent. Design with the weight of permanence.
2. **Design for the client you'll never meet.** You don't know all your consumers. Assume the worst-case client: strict parsing, no error handling, depends on response ordering.
3. **Add, never remove.** You can always add new fields, endpoints, and capabilities. You can never take them away.
4. **Explicit over implicit.** Document everything. Undocumented behavior becomes depended-upon behavior, except now you don't know what you're promising.
5. **Idempotency is not optional.** Networks fail. Clients retry. Your API must handle it gracefully from day one.
