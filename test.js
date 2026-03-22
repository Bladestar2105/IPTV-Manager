const result = [];
for (let i = 0; i < 100000; i++) {
  result.push({ num: i + 1, name: 'displayName', stream_type: 'movie', stream_id: 1234, stream_icon: 'ch.logo', rating: 'ch.rating', rating_5based: 0, added: 'ch.added', category_id: '1234', container_extension: 'mp4', custom_sid: null, direct_source: '' });
}
console.log(result.length);
