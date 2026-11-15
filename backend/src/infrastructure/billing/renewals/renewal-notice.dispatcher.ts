import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  renewalNoticeConfig,
  sesSuccessSimulator,
  type RenewalNoticeSettings,
} from './renewal-notice.config';
import {
  mexicoDay,
  noticeWindow,
  renewalNoticeMessage,
} from './renewal-notice.policy';
import {
  RenewalNoticeStore,
  type RenewalNoticeRow,
} from './renewal-notice.store';
import {
  RENEWAL_NOTICE_RECIPIENT,
  RENEWAL_NOTICE_TRANSPORT,
  type RenewalNoticeRecipient,
  type RenewalNoticeTransport,
  type RenewalRecipientResolution,
} from './renewal-notice.types';

const noticeIdPattern = /^renewal-[a-f0-9]{64}$/;
const dryRunConcurrency = 4;
// Reserve the remainder of the 15-second invocation for any work in progress.
const scheduledWorkAdmissionMs = 3_000;
const blankCounts = {
  wouldSend: 0,
  accepted: 0,
  skipped: 0,
  unknown: 0,
  late: 0,
  blocked: 0,
  deferred: 0,
  early: 0,
  busy: 0,
};
type DispatchOutcome = keyof typeof blankCounts;

@Injectable()
export class RenewalNoticeDispatcher {
  constructor(
    private readonly config: ConfigService,
    private readonly store: RenewalNoticeStore,
    @Inject(RENEWAL_NOTICE_RECIPIENT)
    private readonly recipient: RenewalNoticeRecipient,
    @Inject(RENEWAL_NOTICE_TRANSPORT)
    private readonly transport: RenewalNoticeTransport,
  ) {}

  async dispatch(now?: Date, onlyNoticeId?: string) {
    const settings = renewalNoticeConfig(this.config);
    const counts = { ...blankCounts };
    if (!settings)
      return { enabled: false, processed: 0, hasMoreDue: false, ...counts };

    const today = now ?? new Date();
    if (
      !Number.isFinite(today.getTime()) ||
      (onlyNoticeId !== undefined && !noticeIdPattern.test(onlyNoticeId))
    ) {
      throw new BadRequestException('Invalid renewal notice target');
    }
    if (onlyNoticeId) {
      const job = await this.store.read(settings.table, onlyNoticeId);
      if (job) counts[await this.process(settings, job, now)]++;
      return {
        enabled: true,
        processed: Number(job !== undefined),
        hasMoreDue: false,
        ...counts,
      };
    }

    const admissionDeadline = performance.now() + scheduledWorkAdmissionMs;
    const { jobs, hasMoreDue } = await this.store.due(
      settings.table,
      mexicoDay(today),
    );
    const concurrency = settings.mode === 'dry-run' ? dryRunConcurrency : 1;
    let processed = 0;
    while (processed < jobs.length && performance.now() < admissionDeadline) {
      const outcomes = await Promise.all(
        jobs
          .slice(processed, processed + concurrency)
          .map((job) => this.process(settings, job, now)),
      );
      for (const outcome of outcomes) counts[outcome]++;
      processed += outcomes.length;
      // The sandbox can accept one message per second. Leave further rows
      // queued for another poll after a possible delivery.
      if (settings.mode === 'ses' && (counts.accepted || counts.unknown)) break;
    }
    return {
      enabled: true,
      processed,
      hasMoreDue: hasMoreDue || processed < jobs.length,
      ...counts,
    };
  }

  private async process(
    settings: RenewalNoticeSettings,
    job: RenewalNoticeRow,
    calendarOverride?: Date,
  ): Promise<DispatchOutcome> {
    const calendarNow = () => calendarOverride ?? new Date();
    const wallSeconds = () => Math.floor(Date.now() / 1000);
    const finish = async (
      outcome: 'skipped' | 'late' | 'blocked' | 'unknown',
      reason: string,
    ): Promise<DispatchOutcome> => {
      if (settings.mode === 'dry-run') return outcome;
      return (await this.store.finish(
        settings.table,
        job,
        { state: outcome, reason },
        wallSeconds(),
      ))
        ? outcome
        : 'busy';
    };

    if (job.state === 'sending') {
      // The process could have stopped after the provider accepted the request.
      // An expired claim records uncertainty and must never be sent again.
      return job.claimExpiresAt <= wallSeconds()
        ? finish('unknown', 'interrupted_attempt')
        : 'busy';
    }
    const currentDay = mexicoDay(calendarNow());
    if (job.nextDay > currentDay) return 'early';
    const initialWindow = noticeWindow(job, calendarNow());
    if (initialWindow === 'early') return 'early';
    if (initialWindow === 'late')
      return finish('late', 'notice_window_elapsed');

    let resolution: RenewalRecipientResolution;
    try {
      resolution = await this.recipient.resolve(job);
    } catch {
      // No send has been attempted. A later run can still retry the lookup.
      if (settings.mode === 'dry-run') return 'deferred';
      return (await this.store.reschedule(
        settings.table,
        job,
        mexicoDay(calendarNow()) + 1,
      ))
        ? 'deferred'
        : 'busy';
    }
    if (resolution.status === 'skip') {
      return resolution.reason === 'missing_verified_recipient'
        ? finish('blocked', resolution.reason)
        : finish('skipped', resolution.reason);
    }
    if (noticeWindow(job, calendarNow()) === 'late') {
      return finish('late', 'notice_window_elapsed');
    }
    if (settings.mode === 'dry-run') return 'wouldSend';

    if (
      settings.testRecipient !== sesSuccessSimulator &&
      settings.testRecipient !== resolution.recipient.trim().toLowerCase()
    ) {
      return finish('blocked', 'recipient_outside_dev_allowlist');
    }
    const message = renewalNoticeMessage(job, settings.testRecipient);
    const claimed = await this.store.claim(settings.table, job, wallSeconds());
    if (!claimed) return 'busy';

    let messageId: string;
    try {
      const response = await this.transport.send(message);
      if (!response.messageId) throw new Error('Missing message ID');
      messageId = response.messageId;
    } catch {
      // A timeout or a missing response ID is not proof that no mail was sent.
      await this.store.finish(
        settings.table,
        claimed,
        { state: 'unknown', reason: 'provider_outcome_unknown' },
        wallSeconds(),
      );
      return 'unknown';
    }
    const accepted = await this.store.finish(
      settings.table,
      claimed,
      { state: 'accepted', messageId },
      wallSeconds(),
    );
    return accepted ? 'accepted' : 'unknown';
  }
}
