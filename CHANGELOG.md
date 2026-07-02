# Changelog

## [4.7.2](https://github.com/mctlhq/mctl-portal/compare/4.7.1...4.7.2) (2026-07-02)


### Bug Fixes

* copy proposals-backend package.json in Docker build ([739c388](https://github.com/mctlhq/mctl-portal/commit/739c388607efee90393100ff54ba8ffa8e775066))
* copy proposals-backend package.json in Docker build ([cccd481](https://github.com/mctlhq/mctl-portal/commit/cccd481a2bb8c74b32f6aeae05d80d4d76d1676d))

## [4.7.1](https://github.com/mctlhq/mctl-portal/compare/4.7.0...4.7.1) (2026-07-02)


### Bug Fixes

* **security:** require landing token for backstage/catalog.yaml ([bb8f727](https://github.com/mctlhq/mctl-portal/commit/bb8f727abda5c252fd8e03781144c7967d11d513))
* **security:** require landing token for backstage/catalog.yaml ([17689b6](https://github.com/mctlhq/mctl-portal/commit/17689b6e7c3a0cd3cc494ceabd34318f7404d7e7))
* **security:** validate team/service slugs and escape intake page HTML ([fe47325](https://github.com/mctlhq/mctl-portal/commit/fe473250e1046236211d6ee4a5031391f5eae839))
* **security:** validate team/service slugs and escape OpenClaw intake HTML ([7c5a36e](https://github.com/mctlhq/mctl-portal/commit/7c5a36e350d642065eadad2ada902669c1a132d4))

## [4.7.0](https://github.com/mctlhq/mctl-portal/compare/4.6.1...4.7.0) (2026-07-02)


### Features

* **app:** add /proposals page for agents review ([6281344](https://github.com/mctlhq/mctl-portal/commit/62813447f5fb5417cfbcf878b5435c7687a49aec))
* **app:** add /proposals page with list and detail views ([08a442d](https://github.com/mctlhq/mctl-portal/commit/08a442d836fd4d9b12dfe7c490ad2871952d9ecd))
* **proposals-backend:** scaffold plugin with read and write endpoints ([a1e8aa6](https://github.com/mctlhq/mctl-portal/commit/a1e8aa6709eefad60664ef04b67ea2889ff3a217))


### Bug Fixes

* **proposals-backend:** address P1/P2 review findings ([79d0d5d](https://github.com/mctlhq/mctl-portal/commit/79d0d5da2e895295930d6802594e1dabadbd96a0))
* **proposals-backend:** address remaining P2/P3 review findings ([86acb3f](https://github.com/mctlhq/mctl-portal/commit/86acb3f77884dc6150dde5624e140a4b98601864))
* **proposals-backend:** bump [@backstage](https://github.com/backstage) deps to match post-rebase workspace ([7085cb4](https://github.com/mctlhq/mctl-portal/commit/7085cb47883cd9e5b14aa53f4aad97410b890ab2))
* **proposals-backend:** scope admin to users + enforce status transitions ([22de290](https://github.com/mctlhq/mctl-portal/commit/22de2906590824b51980bc2b1d639fa43f724240))
* **security:** derive OAuth state key from full key hash ([af077e6](https://github.com/mctlhq/mctl-portal/commit/af077e6986d2212b705a021db32c60315877ac64))
* **security:** remove legacy-key OAuth state fallback ([fea0196](https://github.com/mctlhq/mctl-portal/commit/fea019629be773c7c2ee36a06f3b6c6bda98d1d2))

## [4.6.1](https://github.com/mctlhq/mctl-portal/compare/4.6.0...4.6.1) (2026-07-02)


### Bug Fixes

* point incremental lint at origin/main not origin/master ([4592bca](https://github.com/mctlhq/mctl-portal/commit/4592bca71ccbc5b929efa0f55de1562c054fec91))
* point incremental lint at origin/main not origin/master ([f7923a4](https://github.com/mctlhq/mctl-portal/commit/f7923a40bd539da48591ed6c8e78ef42461f048e))

## [4.6.0](https://github.com/mctlhq/mctl-portal/compare/4.5.13...4.6.0) (2026-05-30)


### Features

* **ci:** migrate to centralized build via release-please and mctl-gitops release-deploy ([0229b04](https://github.com/mctlhq/mctl-portal/commit/0229b04e2b31210a3d2a285ff74fa7d8153604f7))
* **ci:** migrate to centralized build via release-please and mctl-gitops release-deploy ([c634d23](https://github.com/mctlhq/mctl-portal/commit/c634d2393aa0f5605be98add8a9e36b7f34c2611))


### Bug Fixes

* **ci:** use full ghcr.io image path in release-deploy dispatch ([69944de](https://github.com/mctlhq/mctl-portal/commit/69944de79fbfaa005e7a1126faaab9798c321654))
* **permission-policy:** remove unused ADMIN_TEAM constant ([db6d389](https://github.com/mctlhq/mctl-portal/commit/db6d389c9a660e09d9e73c7457d0ad8ffbe109bf))
* **permission-policy:** remove unused isViewerRole declaration ([ff509c8](https://github.com/mctlhq/mctl-portal/commit/ff509c8bf571d5624ba76630c96019a84796b81e))
* **tenant-backend:** address claude P2 findings ([86a9bb5](https://github.com/mctlhq/mctl-portal/commit/86a9bb54def072b0cee24d4c32f87c7c67809769))
* **tenant-backend:** address codex P1/P2 findings on multi-tenant auth ([ded64d4](https://github.com/mctlhq/mctl-portal/commit/ded64d4f9633a5a185f373955a2a209ea8fedc09))
* **tenant-backend:** address reviewer P1/P2 findings on multi-tenant auth ([aeebf53](https://github.com/mctlhq/mctl-portal/commit/aeebf5396e23603022e7cb8e44bdcf6ba497eebc))
* **tenant-backend:** allow multi-tenant membership via seedMember and catalog YAML ([c78bafd](https://github.com/mctlhq/mctl-portal/commit/c78bafd97349e9524c87bb212915e23b8e687f8e))
* **tenant-backend:** fix multi-tenant membership for platform admins ([e5fd86f](https://github.com/mctlhq/mctl-portal/commit/e5fd86ffa802ce59f7350af45ab8589af85717a3))
* **tenant-backend:** scope auth checks to requested tenant, fix viewer policy ([95cc010](https://github.com/mctlhq/mctl-portal/commit/95cc010c164a75575e297f1216c4746ad14e275b))
