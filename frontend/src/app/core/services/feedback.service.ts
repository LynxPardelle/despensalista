import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { environment } from '../../../environments/environment';

export type FeedbackCategory = 'bug' | 'complaint' | 'suggestion';
export const feedbackSources = ['access', 'registration', 'recovery', 'pantry', 'profile', 'share', 'website', 'other'] as const;
export const feedbackErrorCodes = ['oauth_callback', 'email_delivery', 'password_reset', 'network', 'unexpected'] as const;
export type FeedbackChannel = 'account' | 'anonymous';

export interface FeedbackSubmission {
  submissionId: string;
  category: FeedbackCategory;
  message: string;
  source?: typeof feedbackSources[number];
  errorCode?: typeof feedbackErrorCodes[number];
}

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly http = inject(HttpClient);
  private readonly publicHttp = new HttpClient(inject(HttpBackend));
  private readonly url = `${environment.apiUrl}/feedback`;

  isAvailable(channel: FeedbackChannel = 'account') {
    if (channel === 'anonymous') {
      return this.publicHttp.get<{ available: boolean }>(`${this.url}/anonymous/status`, {
        credentials: 'omit',
        transferCache: false,
      }).pipe(map(({ available }) => available));
    }
    return this.http.get<{ available: boolean }>(`${this.url}/status`, {
      withCredentials: true,
      transferCache: false,
    }).pipe(map(({ available }) => available));
  }

  submit(submission: FeedbackSubmission, channel: FeedbackChannel = 'account') {
    if (channel === 'anonymous') {
      return this.publicHttp.post<{ id: string }>(`${this.url}/anonymous`, submission, {
        credentials: 'omit',
      });
    }
    return this.http.post<{ id: string }>(this.url, submission, {
      withCredentials: true,
    });
  }
}
