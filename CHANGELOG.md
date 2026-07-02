# Changelog

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
