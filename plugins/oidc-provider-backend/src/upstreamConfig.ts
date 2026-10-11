import { Config } from '@backstage/config';
import { parseUpstreamMode, UpstreamMode, ZitadelUpstreamConfig } from './zitadelUpstream';

export interface UpstreamConfig {
  upstream: UpstreamMode;
  githubClientId: string;
  githubClientSecret: string;
  zitadel?: ZitadelUpstreamConfig;
}

// Reads oidcProvider.upstream (github by default, zitadel, or both) and the
// client of each upstream. A client is required exactly when the switch
// selects its upstream, so the default reads what it always read, and a
// selected upstream without its client fails startup. The ZITADEL client is
// not read at all while the switch is github. Exported for unit testing.
export function readUpstreamConfig(config: Config): UpstreamConfig {
  const upstream = parseUpstreamMode(config.getOptionalString('oidcProvider.upstream'));
  const githubRequired = upstream !== 'zitadel';
  const githubClientId = githubRequired
    ? config.getString('oidcProvider.github.clientId')
    : config.getOptionalString('oidcProvider.github.clientId') ?? '';
  const githubClientSecret = githubRequired
    ? config.getString('oidcProvider.github.clientSecret')
    : config.getOptionalString('oidcProvider.github.clientSecret') ?? '';
  const zitadel: ZitadelUpstreamConfig | undefined =
    upstream === 'github'
      ? undefined
      : {
          issuer: config.getString('oidcProvider.zitadel.issuer'),
          clientId: config.getString('oidcProvider.zitadel.clientId'),
          clientSecret: config.getString('oidcProvider.zitadel.clientSecret'),
        };
  return { upstream, githubClientId, githubClientSecret, zitadel };
}
