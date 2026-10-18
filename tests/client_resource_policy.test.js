import { describe, expect, it } from 'vitest';
import { directMetadataUrl } from '../src/utils/clientResourcePolicy.js';

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
    'https://www.youtube.com/embed/video|Authorization=secret',
    'javascript:alert(1)',
  ])('keeps unknown or credential-bearing URLs behind the Manager: %s', url => {
    expect(directMetadataUrl(url)).toBeNull();
  });
});
