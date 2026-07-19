import * as jose from 'jose';
import { randomBytes } from 'crypto';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Persistence contract for signing keys (implemented by OidcStore).
 * Keys survive pod restarts so previously issued ID tokens stay verifiable.
 */
export interface SigningKeyPersistence {
  getSigningKeys(): Promise<
    Array<{ kid: string; privateJwk: string; publicJwk: string; createdAt: number }>
  >;
  saveSigningKey(key: {
    kid: string;
    privateJwk: string;
    publicJwk: string;
    createdAt: number;
  }): Promise<void>;
}

/**
 * Manages RSA key pairs for signing OIDC tokens.
 *
 * With a persistence store: loads the newest stored key for signing and
 * publishes ALL stored public keys in JWKS, so tokens signed before a
 * restart (or by a previous key) keep verifying. Without a store
 * (tests/local): generates an ephemeral keypair, as before.
 */
export class KeyStore {
  private privateKey!: jose.KeyLike;
  private kid!: string;
  private jwks!: jose.JSONWebKeySet;

  constructor(private readonly logger: LoggerService) {}

  async init(persistence?: SigningKeyPersistence): Promise<void> {
    if (persistence) {
      const stored = await persistence.getSigningKeys();
      if (stored.length > 0) {
        const newest = stored[stored.length - 1];
        this.privateKey = (await jose.importJWK(
          JSON.parse(newest.privateJwk),
          'RS256',
        )) as jose.KeyLike;
        this.kid = newest.kid;
        this.jwks = { keys: stored.map(k => JSON.parse(k.publicJwk)) };
        this.logger.info(
          `[OIDC] Loaded persisted signing key, kid=${this.kid} (${stored.length} key(s) in JWKS)`,
        );
        return;
      }
    }

    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
      extractable: true,
    });
    this.privateKey = privateKey;
    this.kid = jose.base64url.encode(randomBytes(16));

    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = this.kid;
    publicJwk.use = 'sig';
    publicJwk.alg = 'RS256';
    this.jwks = { keys: [publicJwk] };

    if (persistence) {
      const privateJwk = await jose.exportJWK(privateKey);
      privateJwk.kid = this.kid;
      privateJwk.alg = 'RS256';
      await persistence.saveSigningKey({
        kid: this.kid,
        privateJwk: JSON.stringify(privateJwk),
        publicJwk: JSON.stringify(publicJwk),
        createdAt: Date.now(),
      });
      this.logger.info(`[OIDC] Generated and persisted RSA256 signing key, kid=${this.kid}`);
    } else {
      this.logger.info(`[OIDC] Generated ephemeral RSA256 signing key, kid=${this.kid}`);
    }
  }

  /** Sign a JWT payload and return the compact token string */
  async sign(
    payload: jose.JWTPayload,
    expiresIn: string = '8h',
  ): Promise<string> {
    return new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.privateKey);
  }

  /** Return the JWKS for the /.well-known/jwks.json endpoint */
  getJWKS(): jose.JSONWebKeySet {
    return this.jwks;
  }
}
