export interface UserPreferencesPrimitives {
  expirationWarningDays: number;
  showExpiredEntryAlert: boolean;
  depletionWarningThresholdRatio: number;
  shoppingPlanLeadDays: number;
  showGuidanceTips: boolean;
}

export type UserPreferencesPatch = Partial<UserPreferencesPrimitives>;

export const DEFAULT_USER_PREFERENCES: UserPreferencesPrimitives = {
  expirationWarningDays: 7,
  showExpiredEntryAlert: true,
  depletionWarningThresholdRatio: 1,
  shoppingPlanLeadDays: 3,
  showGuidanceTips: true,
};

export class UserPreferences {
  private constructor(
    private readonly preferences: UserPreferencesPrimitives,
  ) {}

  static resolve(input?: UserPreferencesPatch | null): UserPreferences {
    return new UserPreferences(
      validate({
        ...DEFAULT_USER_PREFERENCES,
        ...(input ?? {}),
      }),
    );
  }

  patch(input: UserPreferencesPatch): UserPreferences {
    const updates = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    return UserPreferences.resolve({
      ...this.preferences,
      ...updates,
    });
  }

  toPrimitives(): UserPreferencesPrimitives {
    return { ...this.preferences };
  }
}

function validate(
  preferences: UserPreferencesPrimitives,
): UserPreferencesPrimitives {
  assertNumberBetween(
    preferences.expirationWarningDays,
    1,
    60,
    'Expiration warning days must be between 1 and 60',
  );
  assertNumberBetween(
    preferences.depletionWarningThresholdRatio,
    0.25,
    4,
    'Depletion warning threshold ratio must be between 0.25 and 4',
  );
  assertNumberBetween(
    preferences.shoppingPlanLeadDays,
    0,
    30,
    'Shopping plan lead days must be between 0 and 30',
  );

  if (typeof preferences.showExpiredEntryAlert !== 'boolean') {
    throw new Error('Show expired entry alert must be a boolean');
  }

  if (typeof preferences.showGuidanceTips !== 'boolean') {
    throw new Error('Show guidance tips must be a boolean');
  }

  return {
    expirationWarningDays: Math.trunc(preferences.expirationWarningDays),
    showExpiredEntryAlert: preferences.showExpiredEntryAlert,
    depletionWarningThresholdRatio: Number(
      preferences.depletionWarningThresholdRatio.toFixed(2),
    ),
    shoppingPlanLeadDays: Math.trunc(preferences.shoppingPlanLeadDays),
    showGuidanceTips: preferences.showGuidanceTips,
  };
}

function assertNumberBetween(
  value: number,
  min: number,
  max: number,
  message: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(message);
  }
}
