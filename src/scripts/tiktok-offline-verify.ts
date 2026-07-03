#!/usr/bin/env node
/**
 * Offline verification for ScrapeCreatorsTikTokService (no API credits).
 * Mocks axios responses to validate search → filter → comment batching → Source shape.
 */

export {};

process.env.SCRAPECREATORS_API_KEY =
  process.env.SCRAPECREATORS_API_KEY || 'offline-test-key';

async function main(): Promise<void> {
  const axios = (await import('axios')).default;
  const { ScrapeCreatorsTikTokService } = await import(
    '../services/scrapecreators-tiktok.service.js'
  );

  const mockSearchResponse = {
    search_item_list: [
      {
        aweme_id: '111',
        desc: 'Working mom burnout is real',
        share_url: 'https://www.tiktok.com/@momlife/video/111',
        create_time: 1700000000,
        author: { unique_id: 'momlife' },
        statistics: { comment_count: 42, digg_count: 500 },
      },
      {
        aweme_id: '222',
        desc: 'Low engagement',
        share_url: 'https://www.tiktok.com/@momlife/video/222',
        create_time: 1700000001,
        author: { unique_id: 'momlife' },
        statistics: { comment_count: 3, digg_count: 10 },
      },
    ],
    cursor: 12,
    has_more: 0,
  };

  const mockCommentsResponse = {
    comments: [
      {
        cid: 'c1',
        text: 'I literally cried in my car after drop-off because I had three meetings and no childcare backup that week.',
        digg_count: 120,
      },
      {
        cid: 'c2',
        text: 'Same here — the guilt never stops when you are trying to do it all alone.',
        digg_count: 45,
      },
    ],
    cursor: 20,
    has_more: 0,
  };

  const originalGet = axios.get.bind(axios);
  axios.get = (async (url: string) => {
    if (url.includes('/v1/tiktok/search/keyword')) {
      return { data: mockSearchResponse };
    }
    if (url.includes('/v1/tiktok/video/comments')) {
      return { data: mockCommentsResponse };
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof axios.get;

  const service = new ScrapeCreatorsTikTokService();
  const sources = await service.searchForSources('working mom burnout');

  if (sources.length !== 1) {
    throw new Error(`Expected 1 source (filtered low-comment video), got ${sources.length}`);
  }

  const source = sources[0];
  const checks: Array<[string, boolean]> = [
    ['source_id', source.source_id === '111'],
    ['subreddit handle', source.subreddit === '@momlife'],
    ['platform url', source.source_url.includes('tiktok.com')],
    ['caption in raw_text', source.raw_text.includes('Working mom burnout')],
    ['comments in raw_text', source.raw_text.includes('cried in my car')],
    ['engagement comments', source.engagement.num_comments === 42],
    ['min raw length', source.raw_text.length >= 100],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    throw new Error(`Failed checks: ${failed.map(([name]) => name).join(', ')}`);
  }

  console.log('TikTok offline verify: PASS');
  console.log(`  sources: ${sources.length}`);
  console.log(`  raw_text length: ${source.raw_text.length}`);
  console.log(`  handle: ${source.subreddit}`);

  axios.get = originalGet;
}

main().catch((error) => {
  console.error('TikTok offline verify: FAIL', error);
  process.exit(1);
});
