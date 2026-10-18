import { describe, expect, it } from 'vitest';
import { directMetadataUrl } from '../src/utils/clientResourcePolicy.js';
import { createUpstreamContext, withUpstreamCookies } from '../src/utils/clientCookies.js';

describe('public metadata resource policy', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.imdb.com/title/tt1234567/',
    'https://m.media-amazon.com/images/poster.jpg',
    'https://image.tmdb.org/t/p/original/poster.jpg',
    'https://www.themoviedb.org/movie/123',
    'https://artworks.thetvdb.com/banners/poster.jpg',
    'https://i.ytimg.com/vi/video/hqdefault.jpg',
    'https://www.imdb.com/title/tt123/#cast',
    'https://youtu.be/video#t=1m30s',
  ])('keeps public metadata direct: %s', url => {
    expect(directMetadataUrl(url)).toBe(url);
  });
  it.each([
    'https://provider.example/poster.jpg',
    'https://cdn.unknown.example/poster.jpg',
    'https://youtube.com.provider.example/video',
    'https://provider.example@www.imdb.com/title/tt123/',
    'https://www.youtube.com/watch?v=video&token=provider-secret',
    'https://image.tmdb.org/poster.jpg?api_key=secret',
    'https://www.imdb.com/offsite/?url=https%3A%2F%2Fprovider.example%2Fpassword',
    'https://www.imdb.com/?https%3A%2F%2Fprovider.example%2Flive%2Fupuser%2Fuppass',
    'https://www.imdb.com/?url=https%253A%252F%252Fprovider.example%252Flive%252Fupuser%252Fuppass',
    'https://www.youtube.com/embed/video|Authorization=secret',
    'https://www.imdb.com/#token=secret',
    'https://www.imdb.com/#url=https%3A%2F%2Fprovider.example%2Fpassword',
    'https://www.imdb.com/#https%253A%252F%252Fprovider.example%252Fpassword',
    'https://www.imdb.com/title/https%3A%2F%2Fprovider.example%2Flive%2Fuser%2Fpass',
    'https://www.imdb.com/title/https%253A%252F%252Fprovider.example%252Flive%252Fuser%252Fpass',
    'https://www.imdb.com/title/token%3Dsecret',
    'https://www.imdb.com/title/https%3A%2F%2Fprovider.example%2Flive%2Fu%2Fp%ZZ',
    'https://www.imdb.com/?https%3A%2F%2Fprovider.example%2Flive%2Fu%2Fp%ZZ',
    'https://www.imdb.com/title/auth=abc123',
    'https://www.imdb.com/title/auth%3Dabc123',
    'https://www.imdb.com/title/username=upuser',
    'https://www.imdb.com/title/pass=uppass',
    'https://www.imdb.com/title/key=private',
    'javascript:alert(1)',
  ])('keeps unknown or credential-bearing URLs behind the Manager: %s', url => {
    expect(directMetadataUrl(url)).toBeNull();
  });
  it.each([{ Authorization: 'Bearer secret' }, { 'X-Api-Key': 'secret' }, { Cookie: 'session=secret' }])('does not bypass upstream request credentials: %j', headers => {
    const context = createUpstreamContext(headers, 'https://www.imdb.com/details.json');
    expect(directMetadataUrl('https://www.imdb.com/poster.jpg', undefined, context)).toBeNull();
  });
  it('selects cookie credentials by target and keeps unrelated public metadata direct', () => {
    const context = withUpstreamCookies({}, {
      url: 'https://www.imdb.com/private/details.json', headers: { getSetCookie: () => ['session=secret; Path=/private; Secure'] },
    }, 'https://www.imdb.com/private/details.json');
    expect(directMetadataUrl('https://www.imdb.com/private/image.jpg', undefined, context)).toBeNull();
    expect(directMetadataUrl('https://www.imdb.com/public/image.jpg', undefined, context)).toBe('https://www.imdb.com/public/image.jpg');
    expect(directMetadataUrl('https://youtu.be/video', undefined, context)).toBe('https://youtu.be/video');
  });
});
