export type {
  AccountResolver,
  AuthClaims,
  AuthenticatedAccount,
  AuthFailureReason,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "./AuthProvider.js";

export {
  type FirebaseAuthClaimsExtras,
  FirebaseAuthProvider,
  type FirebaseAuthProviderOptions,
  firebaseAuth,
} from "./adapters/firebase.js";

export {
  JwtCookieAuthProvider,
  type JwtCookieAuthProviderOptions,
  jwtCookieAuth,
} from "./adapters/jwtCookie.js";
export {
  AuthFlow,
  type AuthFlowOptions,
  type AuthTokenPair,
  type IssueAuthInput,
} from "./jwt/AuthFlow.js";
export {
  DrizzleRefreshTokenStore,
  type DrizzleRefreshTokenStoreOptions,
} from "./jwt/DrizzleRefreshTokenStore.js";
export {
  JwtSigner,
  type JwtSignerOptions,
  type JwtSigningKey,
  type JwtVerificationKey,
  type SignedToken,
  type SignTokenOptions,
  type VerifiedToken,
} from "./jwt/JwtSigner.js";
export {
  generateRefreshTokenValue,
  hashRefreshToken,
  InMemoryRefreshTokenStore,
  type IssueRefreshTokenInput,
  type RefreshTokenRecord,
  type RefreshTokenStore,
} from "./jwt/RefreshTokenStore.js";
