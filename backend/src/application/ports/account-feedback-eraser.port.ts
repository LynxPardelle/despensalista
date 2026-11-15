export const ACCOUNT_FEEDBACK_ERASER = Symbol('ACCOUNT_FEEDBACK_ERASER');

export interface AccountFeedbackEraser {
  deleteForAccount(userId: string): Promise<void>;
}
