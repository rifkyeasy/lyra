# lyra-plugin-onchain-two

The `@mysten/sui` **v2** half of lyra's on-chain tools — the cross-chain deposit
path (Circle CCTP, via the Wormhole SDK) plus v2 DeepBook / Cetus execution. It is
the SDK-v2 sibling of
[`lyra-plugin-onchain-one`](https://www.npmjs.com/package/lyra-plugin-onchain-one)
(v1); splitting the incompatible SDK majors into separate packages lets both live
in one install.

> **Internal package — not published to npm.** It is combined with the v1 half
> behind the [`lyra-plugin-onchain`](https://www.npmjs.com/package/lyra-plugin-onchain)
> facade once npm-safe v1/v2 coexistence ships.

See the [root README](https://github.com/lyraai-protocol/lyra#readme) for the
cross-chain funding flow and the full architecture.
