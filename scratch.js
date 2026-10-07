const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function test() {
  const urls = [
    "https://my99exch.cx/api/front_open/match_odds/563175553",
    "https://my99exch.cx/api/front_open/market_detail/563175553",
    "https://my99exch.cx/api/front_open/event_odds/563175553",
    "https://my99exch.cx/api/front_open/odds/?gmid=563175553",
    "https://my99exch.cx/api/front_open/detail?gmid=563175553",
    "https://my99exch.cx/api/front_open/markets?gmid=563175553",
    "https://my99exch.cx/api/front_open/market-details/?gmid=563175553",
    "https://my99exch.cx/api/exchange/odds/sm-odds-multi?mtids=563175553"
  ];
  for (const u of urls) {
    const res = await fetch(u);
    console.log(u, res.status, res.data.substring(0, 100));
  }
}
test();
