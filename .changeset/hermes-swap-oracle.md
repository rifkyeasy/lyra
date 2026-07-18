---
'lyra-plugin-onchain-one': patch
---

swap: pass a Pyth Hermes URL to the 7k aggregator so Cetus routes that read a Pyth
oracle can build. Without it `pythUrls` is empty and those routes fail on "Failed to
update Pyth price feeds". Defaults to https://hermes.pyth.network; LYRA_HERMES_API
overrides.
