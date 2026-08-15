# Changelog

## [4.13.0](https://github.com/mctlhq/mctl-portal/compare/4.12.0...4.13.0) (2026-08-15)


### Features

* **portal:** switch Backstage theme to editorial-warm terracotta ([2aa780b](https://github.com/mctlhq/mctl-portal/commit/2aa780b018072aa8bea96c5533ecb5fa8f257410))


### Bug Fixes

* **portal:** darken banner.link for WCAG AA on terracotta banners ([d6dcb67](https://github.com/mctlhq/mctl-portal/commit/d6dcb67cf8530e01f7b67016125036fe88a87040))

## [4.12.0](https://github.com/mctlhq/mctl-portal/compare/4.11.2...4.12.0) (2026-08-15)


### Features

* **portal:** load the portal favicon from the design CDN ([7ecb521](https://github.com/mctlhq/mctl-portal/commit/7ecb52151001c173446670b756c6234d8e7ece5c))
* **portal:** load the portal favicon from the design CDN ([10f21f5](https://github.com/mctlhq/mctl-portal/commit/10f21f57366a50226fe73f75f4963330c6e103f0))


### Bug Fixes

* cache-bust the CDN portal favicon ([6dea9b0](https://github.com/mctlhq/mctl-portal/commit/6dea9b05235917d5e5c914311c873eacd4b4a6ac))
* drop production http connect-src from the favicon CSP ([269350b](https://github.com/mctlhq/mctl-portal/commit/269350bc5279e364873f5bf2dedc57c0d4dff38e))

## [4.11.2](https://github.com/mctlhq/mctl-portal/compare/4.11.1...4.11.2) (2026-08-14)


### Bug Fixes

* **portal:** register catalog provider in tenant plugin ([5679349](https://github.com/mctlhq/mctl-portal/commit/56793499618c07b426687e59f9ee0483606ad501))
* **portal:** register catalog provider in tenant plugin ([91e8b7d](https://github.com/mctlhq/mctl-portal/commit/91e8b7d424d472d39274227c12ca082e8aeb7dc1))
* **portal:** share TenantStore via root service, not an EP ([5e748a0](https://github.com/mctlhq/mctl-portal/commit/5e748a091187517b750e85892b83e05805215631))
* **portal:** type catalog EP dep without ServiceRef multiton ([34cc6b3](https://github.com/mctlhq/mctl-portal/commit/34cc6b3cf5ac426487d537bcc76430812b63904a))

## [4.11.1](https://github.com/mctlhq/mctl-portal/compare/4.11.0...4.11.1) (2026-08-14)


### Bug Fixes

* **portal:** register tenant catalog as a catalog module ([9314fd5](https://github.com/mctlhq/mctl-portal/commit/9314fd5dcda636d091ea4ffc2347a20cdbb9fce5))
* **portal:** scope landing token and verify k8s TLS ([b20efdb](https://github.com/mctlhq/mctl-portal/commit/b20efdbd7112be1e7c1537ffaff765fd84aaf32a))
* **portal:** scope landing token and verify k8s TLS ([67522e5](https://github.com/mctlhq/mctl-portal/commit/67522e5407ea08f0cd66b190ebf9e3303bade1d1))

## [4.11.0](https://github.com/mctlhq/mctl-portal/compare/4.10.0...4.11.0) (2026-08-14)


### Features

* **backend:** let mctl-api authenticate via external access ([58d3a28](https://github.com/mctlhq/mctl-portal/commit/58d3a28230e2e9256d241d17433d6f1e97331d97))
* **backend:** let mctl-api authenticate via external access ([207b2a9](https://github.com/mctlhq/mctl-portal/commit/207b2a973d7f50a1677392b96305059d94738fe0))

## [4.10.0](https://github.com/mctlhq/mctl-portal/compare/4.9.0...4.10.0) (2026-08-01)


### Features

* **vault-secrets:** authenticate to Vault with the pod ServiceAccount ([fbd5a8a](https://github.com/mctlhq/mctl-portal/commit/fbd5a8ae3328e70ff9bd723d56eca48c6c82250f))
* **vault-secrets:** authenticate to Vault with the pod ServiceAccount ([f141894](https://github.com/mctlhq/mctl-portal/commit/f141894e11d99d2d78c8095cf71b9d184bd10edf))


### Bug Fixes

* **vault-secrets-backend:** keep serving the cached k8s token during a transient renewal failure ([17b58e6](https://github.com/mctlhq/mctl-portal/commit/17b58e67b26f07056015481f941176e04b519407))
* **vault-secrets:** scope token invalidation to the rejected credential ([d95f32f](https://github.com/mctlhq/mctl-portal/commit/d95f32f0fb8f847ac0437613ee1b1b19f5fe3dca))

## [4.9.0](https://github.com/mctlhq/mctl-portal/compare/4.8.0...4.9.0) (2026-08-01)


### Features

* **vault-secrets:** audit-log credential reads, flagging admin bypass ([ae0e025](https://github.com/mctlhq/mctl-portal/commit/ae0e025fbb9a351c60b040fba37760ab6e0af9a6))


### Bug Fixes

* **vault-secrets:** read DB creds from the path provision-database writes ([42850f5](https://github.com/mctlhq/mctl-portal/commit/42850f59cb326be047ceb09a4f68d63b99293c8c))
* **vault-secrets:** read DB creds from the path provision-database writes ([a559b4f](https://github.com/mctlhq/mctl-portal/commit/a559b4f32187b002d4b470f1a0bddb37c2a819b2))

## [4.8.0](https://github.com/mctlhq/mctl-portal/compare/4.7.2...4.8.0) (2026-07-29)


### Features

* **scaffolder:** add mctl:auth:requireTeamAccess action ([a03f2c1](https://github.com/mctlhq/mctl-portal/commit/a03f2c12e2af74dd183c8bfd253c4403a85c9294))
* **scaffolder:** add mctl:auth:requireTeamAccess action ([a8ec273](https://github.com/mctlhq/mctl-portal/commit/a8ec273cef4ccc767e562e095fec49af12543a10))


### Bug Fixes

* **ci:** detect claude-review SDK failure the outcome field misses ([524f0d2](https://github.com/mctlhq/mctl-portal/commit/524f0d24f7a239475b35318a635fcc2ca03a8856))
* **ci:** detect claude-review SDK failure the outcome field misses ([c9e63f7](https://github.com/mctlhq/mctl-portal/commit/c9e63f75d5cb8e21d842c835b8f1a0f3d1f33d8b))
* **ci:** preserve zero diff-line count in Claude review ([#45](https://github.com/mctlhq/mctl-portal/issues/45)) ([44acedd](https://github.com/mctlhq/mctl-portal/commit/44aceddbf7bfdb2650717a7e9517d63e42b57da0))
* platform admins bypass tenant membership for vault-secrets routes ([bfa568f](https://github.com/mctlhq/mctl-portal/commit/bfa568f6b10ea7335c052975665945a6df55b231))
* platform admins bypass tenant membership for vault-secrets routes ([e18bd62](https://github.com/mctlhq/mctl-portal/commit/e18bd62c46128fb11b81953857fd45886517d8d7))

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
