export type AuthProvider = 'LOCAL' | 'MICROSOFT_ENTRA' | 'GOOGLE' | 'UNKNOWN';

export interface AuthObservation {
  requestedMode: 'A' | 'B';
  resolvedProvider: AuthProvider;
  externalIdpDetected: boolean;
  detectedRedirectHost?: string;
}
