const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  page.on('response', response => {
    const url = response.url();
    if (url.includes('api') && !url.includes('highlightodds-direct')) {
      console.log('API:', url);
    }
  });

  await page.goto('https://my99exch.cx/sport/detail/563175553?etid=4', { waitUntil: 'networkidle2' });
  await browser.close();
})();
