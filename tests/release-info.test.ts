import { describe, expect, it, vi } from 'vitest';
import { checkRelease, compareVersions, releaseChecker, RELEASE_SOURCE } from '../src/release-info.js';
const release = (version = '0.8.15') => ({ tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/MongLong0214/jev-gate/releases/tag/v${version}` });
describe('public latest-release status', () => {
  it('uses only the fixed official endpoint and never forwards local credentials', async () => {
    const request = vi.fn(async () => Response.json(release())) as unknown as typeof fetch;
    const result = await checkRelease(request);
    expect(result.latest).toBe('0.8.15'); expect(result.error).toBeNull();
    const [url, options] = vi.mocked(request).mock.calls[0]!; expect(url).toBe(RELEASE_SOURCE); expect(options?.headers).not.toHaveProperty('authorization');
    expect(compareVersions('0.8.9', '0.8.15')).toBe(-1); expect(compareVersions('0.8.15', '0.8.15')).toBe(0); expect(compareVersions(null, '0.8.15')).toBeNull();
  });
  it.each([release('0.9.0-rc.1'), { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), html_url: 'https://untrusted.example' }, null])('rejects draft, prerelease, malformed or unrelated release metadata: %j', async payload => {
    const result = await checkRelease(async () => Response.json(payload)); expect(result.latest).toBeNull(); expect(result.error).toBe('invalid_response');
  });
  it('bounds response bytes and leaves offline/rate limits unknown', async () => {
    expect((await checkRelease(async () => new Response('x'.repeat(70_000)))).error).toBe('invalid_response');
    expect((await checkRelease(async () => new Response('', { status: 429 }))).error).toBe('rate_limited');
    expect((await checkRelease(async () => { throw new Error('sensitive response body'); })).latest).toBeNull();
  });
  it('shares concurrent requests, expires successful results and discards stale success after failure', async () => {
    let now = 1000; const request = vi.fn(async () => Response.json(release())); const checker = releaseChecker(request, () => now);
    const [a, b] = await Promise.all([checker.refresh(), checker.refresh()]); expect(a).toEqual(b); expect(request).toHaveBeenCalledTimes(1);
    now += 299_999; await checker.refresh(); expect(request).toHaveBeenCalledTimes(1);
    now += 1; request.mockRejectedValueOnce(new Error('offline')); expect((await checker.refresh()).latest).toBeNull(); expect(checker.current().error).toBe('offline');
  });
});
