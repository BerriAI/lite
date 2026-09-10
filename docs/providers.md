# Connecting providers

Open **Settings → Providers** in the web app or terminal to add a provider, save it, and test the connection. Then open **Models** to select its models.

## Providers and subscriptions

**LiteLLM:** Connect any model or routing alias your proxy exposes. Use **Set up Lite** in either client to enter the gateway base URL and API key (a virtual key or gateway key). Lite verifies model access before saving. New installs do not assume a gateway address. You can also set `LITELLM_BASE_URL` and `LITELLM_API_KEY` in `.env`, or configure them in Settings. Model discovery uses the provider's actual model endpoint; you can also enter a model ID manually.

**API keys:** OpenAI-compatible providers and native Anthropic are supported. Keys are never returned to the browser. Local credential storage is protected by filesystem permissions; it is not encrypted at rest.

**ChatGPT:** Connection uses an explicit browser/device login. Availability depends on account settings, subscription, and provider policies. This is a compatibility integration, not a promise of provider endorsement or perpetual access. No credentials are imported from another application's storage. Device login may need to be enabled in account/workspace security settings.

**Claude subscriptions:** Third-party subscription login/routing is not supported. Use a native API key or a supported provider through LiteLLM instead.

[Back to Lite](../README.md)
