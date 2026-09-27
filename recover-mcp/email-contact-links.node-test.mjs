import assert from 'node:assert/strict';
import { discoverContactUrls } from './email-contact-links.mjs';

const page={
  url:'https://examplehvac.com/',
  scrape:{
    markdown:'[Contact Us](/contact)\n[About](https://examplehvac.com/about-us)\n[Facebook](https://facebook.com/example)',
    raw_html:'<a href="/support">Contact</a><a href="https://other.com/contact">Other</a>'
  }
};
const out=discoverContactUrls(page);
assert.deepEqual(out.sort(),[
  'https://examplehvac.com/about-us',
  'https://examplehvac.com/contact',
  'https://examplehvac.com/support'
].sort());
console.log('email contact link tests passed');