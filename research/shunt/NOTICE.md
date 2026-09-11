# Upstream provenance

The reader and writer system prompts in `gateway-bridge.mjs` come from Spotify’s Shunt README at revision `3c24ca30ff63e1f5bbad1c43fe5324daff579123` of [spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins). That repository is licensed under Apache-2.0; a copy is in `UPSTREAM-LICENSE`.

The research bridge and probes are new Litespeed research code. They adapt the published prompts to a native gateway solely for experiments; they do not copy the commercially licensed Portal CLI implementation. Upstream scripts execute from the separately cloned reference checkout, retaining its original notices.
