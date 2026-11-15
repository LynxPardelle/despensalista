export const RENEWAL_NOTICE_RECIPIENT = Symbol('RENEWAL_NOTICE_RECIPIENT');
export const RENEWAL_NOTICE_TRANSPORT = Symbol('RENEWAL_NOTICE_TRANSPORT');

export interface RenewalNoticeCandidate {
  householdId: string;
  subscriptionId: string;
  renewalAt: number;
  amountMinor: number;
  currency: 'mxn';
}

export type RenewalSkipReason =
  | 'subscription_changed'
  | 'nonrenewing'
  | 'missing_verified_recipient'
  | 'not_owned';

export type RenewalRecipientResolution =
  | { status: 'eligible'; recipient: string }
  | { status: 'skip'; reason: RenewalSkipReason };

export interface RenewalNoticeRecipient {
  resolve(
    candidate: RenewalNoticeCandidate,
  ): Promise<RenewalRecipientResolution>;
}

export interface RenewalNoticeMessage {
  recipient: string;
  subject: string;
  text: string;
  noticeId: string;
}

export interface RenewalNoticeTransport {
  send(message: RenewalNoticeMessage): Promise<{ messageId: string }>;
}
