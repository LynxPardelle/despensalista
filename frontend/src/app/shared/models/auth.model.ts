export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous' | 'google-mfa-required';

export interface GoogleMfaStatus {
  registered: boolean;
  verified: boolean;
  keyCount: number;
  recoveryConfigured: boolean;
  recentVerification: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiAuthUser {
  id: string;
  email: string;
  username: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}
