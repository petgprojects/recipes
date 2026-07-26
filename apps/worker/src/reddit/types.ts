import type { RedditSourceConfig } from '@recipes/shared';

export interface RedditCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userAgent: string;
}

export interface RedditPost {
  readonly id: string;
  readonly subreddit: string;
  readonly permalink: string;
  readonly title: string;
  readonly selfText: string;
  readonly selfTextHtml: string | null;
  readonly url: string;
  readonly createdAt: Date;
  readonly score: number;
  readonly isSelf: boolean;
}

export interface RedditComment {
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
  readonly score: number;
}

export interface RedditListingPage {
  readonly posts: readonly RedditPost[];
  readonly after: string | null;
}

export interface RedditClient {
  listNew(input: {
    readonly subreddits: readonly string[];
    readonly after?: string | null;
    readonly limit?: number;
  }): Promise<RedditListingPage>;
  topComments(
    permalink: string,
    options?: { readonly limit?: number },
  ): Promise<readonly RedditComment[]>;
}

export type RedditSourceInitialization =
  | { readonly status: 'disabled'; readonly source: RedditSourceConfig }
  | {
      readonly status: 'enabled';
      readonly source: RedditSourceConfig;
      readonly client: RedditClient;
    };
