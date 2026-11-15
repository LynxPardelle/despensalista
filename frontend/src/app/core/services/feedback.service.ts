import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { environment } from '../../../environments/environment';

export type FeedbackCategory = 'bug' | 'complaint' | 'suggestion';

export interface FeedbackSubmission {
  submissionId: string;
  category: FeedbackCategory;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/feedback`;

  isAvailable() {
    return this.http.get<{ available: boolean }>(`${this.url}/status`, {
      withCredentials: true,
      transferCache: false,
    }).pipe(map(({ available }) => available));
  }

  submit(submission: FeedbackSubmission) {
    return this.http.post<{ id: string }>(this.url, submission, {
      withCredentials: true,
    });
  }
}
