import { describe, expect, it } from 'vitest';
import { sourceScanConfiguration } from '../src/scanner/sources';

describe('sourceScanConfiguration', () => {
  it('wires the persisted Serious Eats source to its enabled sitemap adapter', () => {
    const config = sourceScanConfiguration('https://seriouseats.com');
    expect(config.definition.enabled).toBe(true);
    expect(config.source.feedUrl).toBeNull();
    expect(config.source.sitemapUrls).toEqual(['https://www.seriouseats.com/sitemap.xml']);
    expect(config.options.urlFilter?.('https://www.seriouseats.com/tartiflette-recipe-5217300')).toBe(
      true,
    );
    expect(config.options.urlFilter?.('https://www.seriouseats.com/best-aprons-8763265')).toBe(false);
  });

  it('refuses to scan an unconfigured host without a URL adapter', () => {
    expect(() => sourceScanConfiguration('https://unknown.example')).toThrow(
      'No blog-source adapter configured',
    );
  });

  it('does not persist GypsyPlate’s HTML redirect as a usable feed', () => {
    const config = sourceScanConfiguration('https://gypsyplate.com');
    expect(config.source.feedUrl).toBeNull();
    expect(config.source.sitemapUrls).toContain('https://gypsyplate.com/sitemap.xml');
  });
});
