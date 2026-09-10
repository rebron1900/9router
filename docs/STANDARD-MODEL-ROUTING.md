# Standard Model Routing

## Purpose

9router can expose a stable model identity while allowing the same model to be
served by more than one provider. A client requests the official model name,
for example `gpt-5.6-luna`, while 9router selects a configured provider
binding and keeps the provider-specific model name internal.

This is deliberately different from a combo:

```text
standard model identity
  -> provider binding
       -> provider model mapping
            -> provider account and existing executor
```

Combos remain user-defined groups of models. Standard model routing represents
one model identity and only connects it to providers that have been explicitly
confirmed to serve that model.

## Model identity

`standardModels.publicName` is the public model name. It should be the model
publisher's official API model ID, including version and suffixes. Names such as
`gpt-5.6-luna`, `deepseek-v4-flash`, and `glm-5.3-flash` are examples of the
shape, not an automatic assertion that a provider currently publishes them.

The bundled catalog is versioned and records the publisher, official ID,
source URL, verification time, lifecycle, capabilities, and limits. A catalog
entry is not automatically enabled for routing: an administrator must register
it locally and add at least one provider binding.

The dashboard reads this bundled catalog from `/api/models/standard/catalog`.
The initial catalog contains the project-supported canonical identities
`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `deepseek-v4-flash`, and
`glm-5.3-flash`. Adding a catalog entry registers the official identity as-is;
provider-specific IDs are selected later in the provider mapping step. Models
outside the catalog can still be registered through the explicit custom-model
path.

The existing `models.dev` synchronizer remains a source of auxiliary metadata.
It does not decide model identity or prove that two provider model IDs are
semantically interchangeable.

## Configuration model

The feature uses three tables:

- `standardModels`: the public model identity and its default policy.
- `standardModelProviders`: the provider-level binding, priority, and enabled
  state.
- `standardModelMappings`: the provider's actual upstream model ID and optional
  request-format/operation scope.

Provider bindings reference provider IDs, not display names or individual
accounts. Existing account selection and account-level fallback remain inside
the provider binding.

Provider bindings are evaluated strictly in the persisted list order. The
router filters unavailable and capability-incompatible bindings, then tries
the first eligible card before continuing through the remaining cards. A
later card is considered only when the earlier card is exhausted.

The standard-model dashboard now follows the Combo interaction: the primary
add button opens the provider-only model selector, supports multi-selection,
and adds all confirmed models in selection order. Dragging the provider list
persists consecutive priorities, which makes the list order the effective
fallback order. The standard-model directory itself can also be edited,
removed, and reordered. Removing a bundled model only removes its local
registration; it does not modify the authoritative bundled catalog. The
Manual entry remains available for providers that cannot expose a model
catalog. There is no weight setting: provider list order is the only fallback
priority. New writes and imports use a fixed internal value; any legacy value
is ignored, and this storage placeholder is never exposed to routing or backup
data.

## Compatibility rules

- The global switch is off by default.
- Explicit `provider/model` requests keep their current meaning and bypass
  standard model routing.
- Registered standard model names are resolved before legacy alias/combo
  inference.
- Unregistered bare names keep the existing behavior.
- A registered standard model with no eligible binding returns an explicit
  routing error; it is not silently redirected to an unrelated provider.
- Name conflicts with aliases or combos must be reported instead of silently
  changing existing behavior.

## Fallback boundaries

Account fallback and provider fallback are separate levels. A request has one
shared attempt budget and deadline across executor retries, credential refresh,
account changes, and provider changes.

Errors should eventually be classified as request, account, or route failures.
Client input errors and content-policy errors do not switch providers. Token
failure may switch accounts. Capacity, timeout, transport, and unsupported
model errors may switch bindings when the request is safe to replay.

For streaming, fallback is allowed only before any irreversible event is sent
to the client. Once response metadata, text, or a tool-call event has been
committed, the current stream must terminate; 9router must not concatenate a
second provider's stream.

Responses continuations carrying `previous_response_id` or provider-owned
state require strict affinity to the original provider/account. Cross-provider
continuation is not assumed to be safe.

## Current implementation

The first implementation establishes the catalog, persistence, management API,
manual mapping UI, routing preview, and the chat execution hook. When the
global switch is enabled, a registered bare standard model is expanded into
ordered `provider/upstream-model` candidates and passed through the existing
combo fallback engine. The configured `maxProviderAttempts` policy bounds the
number of provider candidates considered, while the coordinator applies the
shared account/provider generation budget before each upstream attempt.
Registered standard models with at least one enabled binding are also
advertised by `/v1/models` alongside the legacy provider-prefixed entries.

The management flow is:

```text
select catalog entry
  -> register standard model locally
  -> add provider binding
  -> select or enter provider model ID
  -> drag bindings into the desired fallback order
  -> preview eligible candidates
  -> enable the global switch when the mappings are ready
```

Directory actions are persisted through the standard model API. The catalog
order is stored separately from provider fallback priority, so changing the
directory order does not change the failover order inside an individual model.

The execution integration reuses the existing account selection, token refresh,
executor, and response-level combo fallback paths, with a standard-route
coordinator layered on top. Standard routes now classify request/auth/model/
capacity/transport failures, enforce one request-scoped generation budget across
account and provider attempts, propagate request cancellation to the upstream
fetch, and keep a process-local cooldown per standard-model/provider/mapping.
Malformed requests are not replayed against another provider. Streaming routes
preflight the first upstream chunk: an upstream error before output is returned
to the route coordinator for provider fallback, while a stream that has already
committed output is never stitched to a second provider.

Responses API response IDs are tracked in a process-local affinity cache for 30
minutes. A request with `previous_response_id` is pinned to the original
standard-model binding and account; an unknown, mismatched, or unavailable
affinity returns a non-retryable `409` instead of silently continuing on another
provider. This keeps provider-owned continuation state from crossing providers.

When all standard-route candidates fail, the response keeps the OpenAI-compatible
`error` envelope and adds `type: standard_model_route_error`, a stable `code`,
the public model name, a retryable flag, bounded attempt diagnostics, and the
shared budget snapshot. Provider-specific error text is truncated before it is
returned to the client.

The global provider fallback policy is `sequential` by default and can be set
to `none`. `maxProviderAttempts` bounds sequential provider attempts,
`maxAccountAttemptsPerProvider` bounds account attempts within one provider,
and `maxGenerationAttempts` is the shared request-level cap across both.
These controls are available in the standard-model routing settings page.

## Later phases

1. Add model-list modes, operational metrics, import/export coverage, and
   Docker upgrade documentation.

Adaptive weights, hedged requests, cross-provider stream stitching,
cross-provider continuation reconstruction, remote signed catalog updates, and
distributed health state are intentionally out of the first release.
