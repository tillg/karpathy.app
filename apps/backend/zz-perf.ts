import { SearchIndex } from './src/search.js';
const idx = new SearchIndex('/tmp/claude-1000/-home-tgartner-karpathy-app/59028eeb-9392-46d8-a98c-d27b5989dd3c/scratchpad/big', (m) => console.error(m));
let t = Date.now(); await idx.search('handtuch'); console.log('build', Date.now() - t);
for (const q of ['glacier melt', 'glacier melt', 'handtuch', 'word42', 'zzz']) { t = Date.now(); await idx.search(q); console.log(q, Date.now() - t); }
idx.markStale(); t = Date.now(); await idx.search('word42'); console.log('restat', Date.now() - t);
console.log('heap', process.memoryUsage().heapUsed/1e6|0);
