export interface CognitoAuthorizeUrlInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  scopes: string[];
  provider?: string;
}

export interface CognitoAuthorizeUrlOutput {
  url: string;
}

export interface CognitoTokenExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface CognitoRefreshInput {
  refreshToken: string;
}

export interface CognitoRevokeInput {
  refreshToken: string;
}

export interface CognitoTokenSet {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

export interface CognitoVerifiedClaims {
  sub: string;
  cognitoUsername?: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  name?: string;
  nonce?: string;
  authTime?: number;
}

export interface CognitoAuthUrlBuilder {
  buildAuthorizeUrl(input: CognitoAuthorizeUrlInput): CognitoAuthorizeUrlOutput;
  buildLogoutUrl(): string;
}

export interface CognitoTokenClient {
  exchangeCode(input: CognitoTokenExchangeInput): Promise<CognitoTokenSet>;
  refresh(input: CognitoRefreshInput): Promise<CognitoTokenSet>;
  revoke(input: CognitoRevokeInput): Promise<void>;
}

export interface CognitoTokenVerifier {
  verifyAccessToken(token: string): Promise<CognitoVerifiedClaims>;
  verifyIdToken(token: string): Promise<CognitoVerifiedClaims>;
}

export interface CognitoUserAdmin {
  deleteUsersBySubjectIds(
    subjectIds: string[],
    authUsernamesBySubject?: Readonly<Record<string, string>>,
  ): Promise<number>;
  signOutUsersBySubjectIds(
    subjectIds: string[],
    authUsernamesBySubject?: Readonly<Record<string, string>>,
  ): Promise<number>;
}
