# Changelog

## [4.30.0](https://github.com/mctlhq/mctl-portal/compare/4.29.0...4.30.0) (2026-10-25)


### Features

* **agents:** issue-208-techdocs-first-view-after-every-portal-r ([2ad467e](https://github.com/mctlhq/mctl-portal/commit/2ad467e1a856b8d93695a51ee86704df244924e3))


### Bug Fixes

* **agents:** issue-208-techdocs-first-view-after-every-portal-r ([7b9b414](https://github.com/mctlhq/mctl-portal/commit/7b9b414f61230877356a3258870a2abe5d18286d))
* **backend:** stop the techdocs warm-up when the scheduler aborts ([a103999](https://github.com/mctlhq/mctl-portal/commit/a103999a91e74bb43233fde45faa29f46a9c2550))
* **techdocs:** accept CRLF event frames and any 2xx sync answer ([0dab3e1](https://github.com/mctlhq/mctl-portal/commit/0dab3e15c0c25ab74dfa5700f2e232475cfb90e3))

## [4.29.0](https://github.com/mctlhq/mctl-portal/compare/4.28.0...4.29.0) (2026-10-25)


### Features

* **agents:** issue-205-github-app-connect-service-principal-rou ([23d0586](https://github.com/mctlhq/mctl-portal/commit/23d05862032c2a71e760c65b7ef2d0588db889f1))
* **agents:** issue-205-github-app-connect-service-principal-rou ([dccd56e](https://github.com/mctlhq/mctl-portal/commit/dccd56e0201c6e5b678b834a6544167cdc5eccb9))

## [4.28.0](https://github.com/mctlhq/mctl-portal/compare/4.27.1...4.28.0) (2026-10-24)


### Features

* **oidc-provider:** tenant_roles claim and PKCE S256 for downstream clients ([5e96c4b](https://github.com/mctlhq/mctl-portal/commit/5e96c4bbbc99f618b4e7b52abd1c20a4ecf93285))
* **oidc-provider:** tenant_roles claim and PKCE S256 for downstream clients ([d135896](https://github.com/mctlhq/mctl-portal/commit/d13589697c20798606c4d02a967def31db83fc3f))


### Bug Fixes

* **oidc-provider:** refuse a code_verifier on a code minted without a challenge ([c93dee7](https://github.com/mctlhq/mctl-portal/commit/c93dee7c80a67833da066049151781eb27efc154))

## [4.27.1](https://github.com/mctlhq/mctl-portal/compare/4.27.0...4.27.1) (2026-10-19)


### Bug Fixes

* **signup:** align starter CPU with workflow headroom ([08a2d47](https://github.com/mctlhq/mctl-portal/commit/08a2d470d7d1d994b992f635db082c40b370bb60))
* **signup:** align starter CPU with workflow headroom ([0ee2e48](https://github.com/mctlhq/mctl-portal/commit/0ee2e48625a73fc8c917975b3092242b52ff629a))

## [4.27.0](https://github.com/mctlhq/mctl-portal/compare/4.26.0...4.27.0) (2026-10-19)


### Features

* **signup:** create customers with the starter profile ([a95fee6](https://github.com/mctlhq/mctl-portal/commit/a95fee6a7791da4e758a6f9289f75f232dae249d))
* **signup:** create customers with the starter profile ([de6387a](https://github.com/mctlhq/mctl-portal/commit/de6387ac140c57657d5cb7e55c2860b909a6b0dc))

## [4.26.0](https://github.com/mctlhq/mctl-portal/compare/4.25.1...4.26.0) (2026-10-19)


### Features

* claim customer signup capacity before provisioning ([e29c700](https://github.com/mctlhq/mctl-portal/commit/e29c70052ef55c4bd67dc0920b08e852b359d750))
* reserve customer signup capacity before provisioning ([54b09ba](https://github.com/mctlhq/mctl-portal/commit/54b09bad94ec474ff95286ad2716bd30da177663))


### Bug Fixes

* claim signup capacity after portal uniqueness checks ([f19b04d](https://github.com/mctlhq/mctl-portal/commit/f19b04dc5456fce3e0ce93d9e928795460b82e02))
* identify customer actor in signup admission requests ([17d7999](https://github.com/mctlhq/mctl-portal/commit/17d799955389844363cbcd8ce54fe8670107ec0a))

## [4.25.1](https://github.com/mctlhq/mctl-portal/compare/4.25.0...4.25.1) (2026-10-18)


### Bug Fixes

* recognize configured Backstage workflow service subject ([9c3db7a](https://github.com/mctlhq/mctl-portal/commit/9c3db7a44e3623606a04c5b0702c2c881d6b610c))
* recognize configured Backstage workflow service subject ([4755477](https://github.com/mctlhq/mctl-portal/commit/4755477a995925de0f17941336752dce423d16f9))

## [4.25.0](https://github.com/mctlhq/mctl-portal/compare/4.24.0...4.25.0) (2026-10-18)


### Features

* support cancellation before customer deletion begins ([97811e2](https://github.com/mctlhq/mctl-portal/commit/97811e2348dbae159d5817867aaebc646e4df7d6))
* support cancellation before customer deletion begins ([10dfa70](https://github.com/mctlhq/mctl-portal/commit/10dfa709e44dbe60b5b4b841a99f3e376bb78a21))

## [4.24.0](https://github.com/mctlhq/mctl-portal/compare/4.23.1...4.24.0) (2026-10-18)


### Features

* clean customer data and revoke portal sessions ([b7daa2b](https://github.com/mctlhq/mctl-portal/commit/b7daa2bf0275a8d7c1104f298baad8cf61054f19))
* clean customer data and revoke portal sessions ([574302d](https://github.com/mctlhq/mctl-portal/commit/574302df291c24ea02f93c8c492904434396190f))


### Bug Fixes

* authorize lifecycle calls in production portal config ([2d83b36](https://github.com/mctlhq/mctl-portal/commit/2d83b367ddddc62feddfa74c72acdb72652d18a1))
* make customer cleanup scope and completed replay explicit ([e135ce3](https://github.com/mctlhq/mctl-portal/commit/e135ce3282fc6576925e2c6f1caeb77cb4344763))
* pin legacy OIDC admission and customer session scope ([0057245](https://github.com/mctlhq/mctl-portal/commit/00572457e80a4ae68b978c1145e3c350859aeaa3))
* purge per-user notification data during account deletion ([3bf0f9b](https://github.com/mctlhq/mctl-portal/commit/3bf0f9bd6369a528bf8aeae654dce47903c3db5b))
* require verified customer cleanup receipts ([43b7451](https://github.com/mctlhq/mctl-portal/commit/43b7451815dde96b69ca54d5a774cd1d7fa65821))
* serialize notifications with customer teardown ([10b876f](https://github.com/mctlhq/mctl-portal/commit/10b876f77317e0571189b9a039de50d598f05c4f))

## [4.23.1](https://github.com/mctlhq/mctl-portal/compare/4.23.0...4.23.1) (2026-10-17)


### Bug Fixes

* package and validate runtime configuration schemas ([1b35058](https://github.com/mctlhq/mctl-portal/commit/1b350583c4be389df7b6eae6b7db9be23b3cd6c0))
* package and validate runtime configuration schemas ([82e7493](https://github.com/mctlhq/mctl-portal/commit/82e7493ef1755bb8a1d3ec35a7ea7c4ad3263988))

## [4.23.0](https://github.com/mctlhq/mctl-portal/compare/4.22.0...4.23.0) (2026-10-17)


### Features

* verify workspace access and send ready notifications ([7451384](https://github.com/mctlhq/mctl-portal/commit/7451384c728f4f9a2a05a28f0fb62e6396fba537))


### Bug Fixes

* constrain GitHub lookup to a username path segment ([046ac79](https://github.com/mctlhq/mctl-portal/commit/046ac798ea4cc9232322da2ccdc11d9f42425db5))
* harden workspace readiness and delivery recovery ([4904546](https://github.com/mctlhq/mctl-portal/commit/49045466bfdb27ccf7d815490c48a90d22fd919a))
* keep customer contacts out of workflow parameters ([0e7d542](https://github.com/mctlhq/mctl-portal/commit/0e7d542d36d764a8c75099cd4c4405264ca52fb2))
* preserve private workspace contacts during GitOps sync ([2679e5f](https://github.com/mctlhq/mctl-portal/commit/2679e5fc0491283ba6e0f13ef6e8004b44c6aa56))
* refresh definitively unsent readiness snapshots safely ([d50ea2b](https://github.com/mctlhq/mctl-portal/commit/d50ea2bcebfd3003281395d88784989a015725c2))
* retry definite email refusals without losing ambiguity ([495562d](https://github.com/mctlhq/mctl-portal/commit/495562d9df21df466cd6a864aad878d4f1a4e175))
* use public workflow host in onboarding links ([7738800](https://github.com/mctlhq/mctl-portal/commit/773880007827964aa78c8fb9caafa1da30404462))

## [4.22.0](https://github.com/mctlhq/mctl-portal/compare/4.21.1...4.22.0) (2026-10-17)


### Features

* **auth:** label the ZITADEL entry for staff and partner accounts ([929e87e](https://github.com/mctlhq/mctl-portal/commit/929e87e64beb8eb408f85473f29d15954afe2ddd))
* **auth:** offer customers a GitHub sign-in entry ([4d1e735](https://github.com/mctlhq/mctl-portal/commit/4d1e73546a7d5591a81c3edb1cbbe2ac2bfcc26a))
* **auth:** offer customers a GitHub sign-in entry ([49090ad](https://github.com/mctlhq/mctl-portal/commit/49090ad4a365622b79a03bf067bbb3a96a2bc659))


### Bug Fixes

* **auth:** check the customer section per environment, harden gates ([2e09617](https://github.com/mctlhq/mctl-portal/commit/2e0961752def33d287b6693deb65041958fb7d73))
* **auth:** harden the customer entry per review of [#179](https://github.com/mctlhq/mctl-portal/issues/179) ([797b4be](https://github.com/mctlhq/mctl-portal/commit/797b4be0ccad8fd9cc4ec1c1d0f59a021d6f5cec))
* **auth:** point mis-routed accounts at the MCTL entry ([5d73d33](https://github.com/mctlhq/mctl-portal/commit/5d73d33fa842cd0f2873c4e5d83365ed70f677a6))

## [4.21.1](https://github.com/mctlhq/mctl-portal/compare/4.21.0...4.21.1) (2026-10-17)


### Bug Fixes

* **catalog:** show tenant identities by declared owner ([2aee96a](https://github.com/mctlhq/mctl-portal/commit/2aee96a13118b5ee38284f811fc3cc99dd522990))
* **catalog:** show tenant identities by declared owner ([42d533e](https://github.com/mctlhq/mctl-portal/commit/42d533e51de9e83eff767d0ee47492baf3745c27))

## [4.21.0](https://github.com/mctlhq/mctl-portal/compare/4.20.4...4.21.0) (2026-10-16)


### Features

* **portal:** customers create their workspace by principal (C2) ([219bc11](https://github.com/mctlhq/mctl-portal/commit/219bc110a7e1b82130d395d9d460c98729e7044a))
* **portal:** customers create their workspace by principal (C2) ([06b56a1](https://github.com/mctlhq/mctl-portal/commit/06b56a158974f58e1f6eaf5e67f0b10c9a6e862b))
* **portal:** principal-keyed catalog users for customers accounts ([9fa2179](https://github.com/mctlhq/mctl-portal/commit/9fa2179a9b3d0b3db535c7b8334b4e99f21d2aa5))
* **portal:** principal-keyed catalog users for customers accounts ([924f624](https://github.com/mctlhq/mctl-portal/commit/924f6248fb2f2ca2f3522399e10ef0ba8fcb37f6))


### Bug Fixes

* **portal:** tell an unclassifiable session to sign in again ([497fa57](https://github.com/mctlhq/mctl-portal/commit/497fa575337a9ce3689701076aa0ac70c7806992))
* **tenant:** code name_taken on the existence-check 409 too ([fb129dc](https://github.com/mctlhq/mctl-portal/commit/fb129dc61127cc6e82138f51849f9c42ea88edd0))
* **tenant:** enforce one workspace per customer in the store ([7e6cf3f](https://github.com/mctlhq/mctl-portal/commit/7e6cf3fd491bb8a46b2bbf094aad39c7c894b900))
* **tenant:** enforce one workspace per customer in the store ([ff08785](https://github.com/mctlhq/mctl-portal/commit/ff08785f936a1bf51855910e2f21efc91b5d7648))
* **tenant:** give a taken name its own 409 code ([970d743](https://github.com/mctlhq/mctl-portal/commit/970d743e0bb7621e01b7fd702ef1d13047d0fac9))
* **tenant:** hold login-keyed members to the GitHub login shape ([7528c49](https://github.com/mctlhq/mctl-portal/commit/7528c4957d779ac8315ad2e5ae55ec8892e11c5e))
* **tenant:** keep a member's principal when an invite re-adds it ([8b12b0f](https://github.com/mctlhq/mctl-portal/commit/8b12b0fe272a82e840ee6de4e442dfdc51b9793f))
* **tenant:** log unmodelled customer-resolution failures ([d216586](https://github.com/mctlhq/mctl-portal/commit/d21658651c2089f5dde262779ebab988c57c6602))

## [4.20.4](https://github.com/mctlhq/mctl-portal/compare/4.20.3...4.20.4) (2026-10-13)


### Bug Fixes

* **portal:** rate-limit the tenant and resource-usage routes ([a877e29](https://github.com/mctlhq/mctl-portal/commit/a877e29df43902265727003f6da0959c1ecfba5a))
* **portal:** rate-limit the tenant and resource-usage routes ([1884414](https://github.com/mctlhq/mctl-portal/commit/18844145e826e3c8c63eeed4083e751e4ac35510))

## [4.20.3](https://github.com/mctlhq/mctl-portal/compare/4.20.2...4.20.3) (2026-10-13)


### Bug Fixes

* **tenant:** bound creator logins to 39 characters ([26f3783](https://github.com/mctlhq/mctl-portal/commit/26f3783b33fe17eb7203a2cda419d52eaee4a517))
* **tenant:** key the new tenant's owner by principal ([8852af5](https://github.com/mctlhq/mctl-portal/commit/8852af54637ff3832bbad1bf0aacb185e791cfcc))
* **tenant:** key the new tenant's owner by principal ([d9a0667](https://github.com/mctlhq/mctl-portal/commit/d9a0667d730654d41394057ce5ec6292528c2a41))

## [4.20.2](https://github.com/mctlhq/mctl-portal/compare/4.20.1...4.20.2) (2026-10-11)


### Bug Fixes

* **github-app-connect:** atomic repo sync, bounded permission checks ([f857157](https://github.com/mctlhq/mctl-portal/commit/f85715793e4d1f6de1ea9cc939d184b4412f9085))
* **portal:** fail closed on partial reads, sync, subject and padded input ([81b9d68](https://github.com/mctlhq/mctl-portal/commit/81b9d68c7bce3a54d7c5659ea34386d1cdd03206))
* **portal:** tenant-scoped kubernetes, usage and repository bindings ([9bdf81d](https://github.com/mctlhq/mctl-portal/commit/9bdf81d4f9691b062696f65b14398050a899e208))

## [4.20.1](https://github.com/mctlhq/mctl-portal/compare/4.20.0...4.20.1) (2026-10-10)


### Miscellaneous Chores

* release 4.20.1 ([2ee6280](https://github.com/mctlhq/mctl-portal/commit/2ee628091e90f6712e4410cfac4e925d35bd90eb))

## [4.20.0](https://github.com/mctlhq/mctl-portal/compare/4.19.0...4.20.0) (2026-10-10)


### Features

* **auth:** auth.signIn zitadel turns the GitHub sign-in off ([845a832](https://github.com/mctlhq/mctl-portal/commit/845a8322fea08199b715a3af47aec7de0771afa6))
* **auth:** auth.signIn zitadel turns the GitHub sign-in off ([a920446](https://github.com/mctlhq/mctl-portal/commit/a9204465917a20a821de39574ee5df94d55e871d))

## [4.19.0](https://github.com/mctlhq/mctl-portal/compare/4.18.1...4.19.0) (2026-10-09)


### Features

* **auth:** portal sign-in through ZITADEL behind auth.signIn ([73154a8](https://github.com/mctlhq/mctl-portal/commit/73154a88f7db6a243d2caf1381b72f83d82a017c))
* **auth:** portal sign-in through ZITADEL behind auth.signIn ([d0f9d0b](https://github.com/mctlhq/mctl-portal/commit/d0f9d0bff3a54c07df9943bf36dd5c8e24f67bd0))


### Bug Fixes

* **auth:** address review nits on ZITADEL sign-in ([3c1e428](https://github.com/mctlhq/mctl-portal/commit/3c1e428889fc860f96a95f3f95aaaa81df5c5c1a))

## [4.18.1](https://github.com/mctlhq/mctl-portal/compare/4.18.0...4.18.1) (2026-10-08)


### Bug Fixes

* **oidc-provider:** close the P3 follow-ups from the [#151](https://github.com/mctlhq/mctl-portal/issues/151) review ([d7bb47c](https://github.com/mctlhq/mctl-portal/commit/d7bb47c92bb8705e5030ed98f2994ea0c9a7b568))
* **oidc-provider:** close the P3 follow-ups from the [#151](https://github.com/mctlhq/mctl-portal/issues/151) review ([890d46b](https://github.com/mctlhq/mctl-portal/commit/890d46bc94444aee7a5a9a34244da51a1264580a)), closes [#152](https://github.com/mctlhq/mctl-portal/issues/152)

## [4.18.0](https://github.com/mctlhq/mctl-portal/compare/4.17.3...4.18.0) (2026-10-07)


### Features

* **oidc-provider:** add a ZITADEL upstream behind a switch ([2a7a8fa](https://github.com/mctlhq/mctl-portal/commit/2a7a8fa6fba81a0aac8c62591489be8a5005a536))
* **oidc-provider:** add a ZITADEL upstream behind a switch ([10bccbb](https://github.com/mctlhq/mctl-portal/commit/10bccbb445d266fcc84bdef03507e60baed4a58f)), closes [#150](https://github.com/mctlhq/mctl-portal/issues/150)
* **work-items:** show work-item history through the relay ([0bd5bc6](https://github.com/mctlhq/mctl-portal/commit/0bd5bc6ff40ca03f6fb53a78f19d6ccf9c7e675a))
* **work-items:** show work-item history through the relay ([f2ea09d](https://github.com/mctlhq/mctl-portal/commit/f2ea09d98815f727452e882e70067fd5ea3f8c9f))


### Bug Fixes

* **oidc-provider:** require azp unless this client is the sole audience ([86f8e00](https://github.com/mctlhq/mctl-portal/commit/86f8e0061574492a4aaebd2a75a5d190aa5966de)), closes [#150](https://github.com/mctlhq/mctl-portal/issues/150)
* **work-items:** keep unknown history sections visible ([b168836](https://github.com/mctlhq/mctl-portal/commit/b168836505e4124b679688069ac6943013559d57))
* **work-items:** never offer resume on an unreadable phase ([d32fec5](https://github.com/mctlhq/mctl-portal/commit/d32fec5788b3a7e1b870ade99b95922457b5ea43))
* **work-items:** require only id and phase on executions ([7105b8b](https://github.com/mctlhq/mctl-portal/commit/7105b8b0d9dfd16d396daf90e70547ac86c28edb))

## [4.17.3](https://github.com/mctlhq/mctl-portal/compare/4.17.2...4.17.3) (2026-10-04)


### Bug Fixes

* **argo-workflows:** pin team templates to the gitops flows ([e548c37](https://github.com/mctlhq/mctl-portal/commit/e548c376775720af629d55729ece61e67eb9d6b3))
* **argo-workflows:** team workflows only, in the team's namespace ([c7ab779](https://github.com/mctlhq/mctl-portal/commit/c7ab779e9c84dc67c441f024b163433589138107))
* **auth:** sign in only catalog users; gate workflow submission ([1a736dd](https://github.com/mctlhq/mctl-portal/commit/1a736dd113af39fa4e54e4fd870dfe1cef7a2461))
* **auth:** sign in only catalog users; gate workflow submission ([48de954](https://github.com/mctlhq/mctl-portal/commit/48de954798524fe472bb154fb1389c4ec9b4b782))
* **github-app-connect:** refuse auto-deploy in the webhook ([84ffe04](https://github.com/mctlhq/mctl-portal/commit/84ffe049b758302937ea886de0c64d768358075c))
* **work-items:** refuse bad intentId, name the 400 field, quiet canvas ([f61a64c](https://github.com/mctlhq/mctl-portal/commit/f61a64c429d05a6c080a0838d43da4f48c495ec0))
* **work-items:** refuse bad intentId, name the 400 field, quiet canvas ([ac9e539](https://github.com/mctlhq/mctl-portal/commit/ac9e5391d1801a67c1f740c64d8a178d832ae5de)), closes [#136](https://github.com/mctlhq/mctl-portal/issues/136)

## [4.17.2](https://github.com/mctlhq/mctl-portal/compare/4.17.1...4.17.2) (2026-10-04)


### Bug Fixes

* **oidc:** keep session cookies host-only, bind forward-auth per host ([a48218a](https://github.com/mctlhq/mctl-portal/commit/a48218a07d7c409a22dde9e1a4578021609e004a))
* **oidc:** keep session cookies host-only, bind forward-auth per host ([33574d9](https://github.com/mctlhq/mctl-portal/commit/33574d9c8fcc7edd58e125f5482b38c1b5209db7))
* **oidc:** keep the shared state cookie for parallel sign-ins ([66cda61](https://github.com/mctlhq/mctl-portal/commit/66cda619131dba20ac4200ea89d3f780db49be67))
* **oidc:** validate protected hosts, gate sign-in on navigation ([29a8a74](https://github.com/mctlhq/mctl-portal/commit/29a8a745702beaf629bb87a97715f581bc372510))

## [4.17.1](https://github.com/mctlhq/mctl-portal/compare/4.17.0...4.17.1) (2026-10-03)


### Bug Fixes

* **docker:** copy the work-items-backend manifest before yarn install ([4fa8288](https://github.com/mctlhq/mctl-portal/commit/4fa8288a438817ca8364a7c1857af3d22d9a66df))
* **docker:** copy the work-items-backend manifest before yarn install ([1c226cd](https://github.com/mctlhq/mctl-portal/commit/1c226cd0bb60dd943fa0d045ff7e49a556c2b342))

## [4.17.0](https://github.com/mctlhq/mctl-portal/compare/4.16.0...4.17.0) (2026-10-03)


### Features

* **agents:** issue-117-custom-domains-plugin-repoint-at-mctl-ap ([5d87529](https://github.com/mctlhq/mctl-portal/commit/5d875293f197371c2d3020c08262ef381153773c))
* **agents:** issue-117-custom-domains-plugin-repoint-at-mctl-ap ([33d120a](https://github.com/mctlhq/mctl-portal/commit/33d120a6f6026a3103856703a2706e4965a4da6d))
* **agents:** issue-120-custom-domains-gateway-118-12-non-blocki ([e70fd40](https://github.com/mctlhq/mctl-portal/commit/e70fd404024bd3c8eae2023f320635b71887ab09))
* **agents:** issue-122-migrate-remaining-5-plugins-off-node-fet ([20ea7f0](https://github.com/mctlhq/mctl-portal/commit/20ea7f059ee0d1092a369bef5bd6a9bba1ee1285))
* **agents:** issue-122-migrate-remaining-5-plugins-off-node-fet ([c967810](https://github.com/mctlhq/mctl-portal/commit/c9678108c8f864790ee6486dd3aa15b79b209555))
* **agents:** issue-126-feat-work-context-add-a-first-class-work ([322ce44](https://github.com/mctlhq/mctl-portal/commit/322ce445ddba1a59b64aff3f29225185f6cf2125))
* **agents:** issue-126-feat-work-context-add-a-first-class-work ([b9fffe9](https://github.com/mctlhq/mctl-portal/commit/b9fffe9e7f399007bbd5395fe016f1c7ca12c78f))


### Bug Fixes

* **agents:** address P1/P2 codex findings on issue-126-feat-work-context-add-a-first-class-work ([33c6429](https://github.com/mctlhq/mctl-portal/commit/33c6429d3e23f613bb1178b0cae519e49a623bc4))
* **agents:** address P1/P2 codex findings on issue-126-feat-work-context-add-a-first-class-work ([48d2fd2](https://github.com/mctlhq/mctl-portal/commit/48d2fd2cf5e1105a9a8116f3acd41e30c1451f39))
* **custom-domains:** guard create() against an empty 2xx body ([0d4f696](https://github.com/mctlhq/mctl-portal/commit/0d4f696c1bdfe4f8be559f5560f884fb9c6325c4))
* **custom-domains:** harden mctl-api client transport and error hygiene ([a4d2ab8](https://github.com/mctlhq/mctl-portal/commit/a4d2ab88f54e7229a8503178e6dc915145acb980))
* **custom-domains:** split error log levels and validate service param ([cf0ff6a](https://github.com/mctlhq/mctl-portal/commit/cf0ff6ad87dc55e3550c4903893fe2648e45cd31))
* **custom-domains:** surface verify:false and extend Verify eligibility ([1e797bf](https://github.com/mctlhq/mctl-portal/commit/1e797bfd4defc5c45f9dc9081e3b04cfc6a4445a))
* **domains:** close 2 real P2s from agy — body type validation, 401/403 leak ([ec45d4a](https://github.com/mctlhq/mctl-portal/commit/ec45d4a0558331990379bffa333fbc6af65e154e))
* **domains:** close P1 IDOR and 4 P2 findings from claude-review on [#118](https://github.com/mctlhq/mctl-portal/issues/118) ([6e62bfb](https://github.com/mctlhq/mctl-portal/commit/6e62bfb86115569b84a17d5b14175db619bcf478))
* **domains:** close real P2s from agy — unhandled rejections, 5xx info leak ([25fdbb2](https://github.com/mctlhq/mctl-portal/commit/25fdbb265002aad071318f624fff45b3b763c370))
* **domains:** move ownership check inside try/catch, guard undefined body ([825044c](https://github.com/mctlhq/mctl-portal/commit/825044cac80668e4304b68f00b895feecc118440))
* **domains:** stop failed domains from becoming a dead end in the card ([06d1043](https://github.com/mctlhq/mctl-portal/commit/06d10433730b9f40a5266b574d934efcfea7638a))
* **work-items:** one execution request per confirm, show loading ([07dda9c](https://github.com/mctlhq/mctl-portal/commit/07dda9cab0b94c4bb20827321bf3219c824eec7e))
* **work-items:** pin the actor-id grammar, address 48d2fd2 review ([ae15a49](https://github.com/mctlhq/mctl-portal/commit/ae15a4958d861bc72635d928c99329b8f648d31f))
* **work-items:** send an mctl-api-valid actor id, harden the client ([ed97094](https://github.com/mctlhq/mctl-portal/commit/ed97094bb5dfc9cc4ee526ce1d96880ad9ba82ef))

## [4.16.0](https://github.com/mctlhq/mctl-portal/compare/4.15.0...4.16.0) (2026-09-01)


### Features

* **agents:** issue-102-team-policy-any-member-can-delete-or-ref ([ce2ac7b](https://github.com/mctlhq/mctl-portal/commit/ce2ac7bdb3dae93a81d9238ac2c6b08f447d23b8))


### Bug Fixes

* **agents:** issue-102-team-policy-any-member-can-delete-or-ref ([88a6ba8](https://github.com/mctlhq/mctl-portal/commit/88a6ba8c32ed2dfcc90fe1fc65ca1eb14392b9c8))
* **team-policy:** type the catalog anyOf array so tsc accepts the read-gated arm ([10e2553](https://github.com/mctlhq/mctl-portal/commit/10e25539b95c3ac237b196f27af14c75cb854163))

## [4.15.0](https://github.com/mctlhq/mctl-portal/compare/4.14.4...4.15.0) (2026-08-31)


### Features

* **agents:** issue-84-fix-cve-2024-21534-jsonpath-plus-rce-for ([dc1fd68](https://github.com/mctlhq/mctl-portal/commit/dc1fd68a763017cd7bb80c3d9fe8268f9f150571))


### Bug Fixes

* **agents:** issue-84-fix-cve-2024-21534-jsonpath-plus-rce-for ([e7d3864](https://github.com/mctlhq/mctl-portal/commit/e7d38644d03367e5ef35e4cfdf4b7f5846d3c62f))

## [4.14.4](https://github.com/mctlhq/mctl-portal/compare/4.14.3...4.14.4) (2026-08-29)


### Bug Fixes

* **agents:** issue-81-team-policy-deny-requests-without-a-user ([b58419d](https://github.com/mctlhq/mctl-portal/commit/b58419d88005b16d5efe121a46b91962dc23bb79))

## [4.14.3](https://github.com/mctlhq/mctl-portal/compare/4.14.2...4.14.3) (2026-08-29)


### Bug Fixes

* **agents:** issue-83-oidc-login-returnto-allowlist-mctl-ai-on ([4727aa9](https://github.com/mctlhq/mctl-portal/commit/4727aa994315e7e800440fba90d38d8b8badbf3a))
* **oidc:** drop retired mctl.me from codex returnTo trust; test control-char rejection ([c1037c1](https://github.com/mctlhq/mctl-portal/commit/c1037c1e00c55e55a0fce100f74d6839705895b7))
* **oidc:** reject control characters in returnTo; correct the mctl.me note ([a2cf0f0](https://github.com/mctlhq/mctl-portal/commit/a2cf0f0e5eedc78f9517cc67c5124bd8c2d31abe))

## [4.14.2](https://github.com/mctlhq/mctl-portal/compare/4.14.1...4.14.2) (2026-08-29)


### Bug Fixes

* **docker:** revert base to node:22 — engines allow 22||24, native deps fail on 26 ([66f3457](https://github.com/mctlhq/mctl-portal/commit/66f345760ca91be0f4f9499f3acb0a225e8fb97b))

## [4.14.1](https://github.com/mctlhq/mctl-portal/compare/4.14.0...4.14.1) (2026-08-29)


### Bug Fixes

* **docker:** install corepack explicitly — node:26 image no longer bundles it ([e07861a](https://github.com/mctlhq/mctl-portal/commit/e07861ab8f1f137d0f88ed169053b5177a4cba92))

## [4.14.0](https://github.com/mctlhq/mctl-portal/compare/4.13.0...4.14.0) (2026-08-28)


### Features

* **agents:** issue-79-remove-unauthenticated-access-from-githu ([d157127](https://github.com/mctlhq/mctl-portal/commit/d1571275eb24fcdd3ebc338aa7b5977ffd79d811))


### Bug Fixes

* **agents:** address P1/P2 codex findings on issue-79-remove-unauthenticated-access-from-githu ([26a9a74](https://github.com/mctlhq/mctl-portal/commit/26a9a74a14c61f7efdda3596ecc025171ff4e9bc))
* **agents:** issue-80-enforce-tenant-ownership-in-custom-domai ([c6f89bb](https://github.com/mctlhq/mctl-portal/commit/c6f89bbfcc057a08986b6cfc1810d64516ddcea1))
* **custom-domains:** restrict workflow tier to the external-access subject ([7ffae8b](https://github.com/mctlhq/mctl-portal/commit/7ffae8b7e11fd616c72bacf1879e9a44500c5887))
* **github-app-connect:** reject dot-only repo segments; regression tests for validation branches ([d0de939](https://github.com/mctlhq/mctl-portal/commit/d0de939a2cb04e7ccdf199c188f8806e8f75530f))

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
