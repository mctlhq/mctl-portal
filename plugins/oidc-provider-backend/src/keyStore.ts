import * as jose from 'jose';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Manages RSA key pairs for signing OIDC tokens.
 * Generates a new keypair on startup and exposes JWKS for verification.
 */
export class KeyStore {
  private privateKey!: jose.KeyLike;
  private kid!: string;
  private jwks!: jose.JSONWebKeySet;

  constructor(private readonly logger: LoggerService) {}

  async init(): Promise<void> {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
      extractable: true,
    });
    this.privateKey = privateKey;
    this.kid = jose.base64url.encode(
      new Uint8Array(
        await crypto.subtle
          ? crypto.getRandomValues(new Uint8Array(16))
          : Buffer.from(Date.now().toString(16), 'hex'),
      ),
    );
    // Build JWKS
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = this.kid;
    jwk.use = 'sig';
    jwk.alg = 'RS256';
    this.jwks = { keys: [jwk] };
    this.logger.info(`[OIDC] Generated RSA256 signing key, kid=${this.kid}`);
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
