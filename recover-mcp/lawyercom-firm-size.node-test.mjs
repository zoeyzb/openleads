import assert from "node:assert/strict";
import { targetScopedLawyerComFirmSize, targetScopedLawyerComHtml } from "./lawyercom-firm-size.mjs";

const wrap = body => `<!doctype html><html><body>${body}</body></html>`;

{
  const html=wrap(`
    <main>
      <h1>Law Offices of Susan L. Kowalski, CFLS</h1>
      <div class="firm-summary"><span>Firm Size: 1</span></div>
      <h2>About</h2><p>Family law practice in Tustin, California.</p>
      <h2>Top Local Lawyers</h2>
      <article><a href="/lawyer/unrelated">Unrelated Attorney</a><span>Firm Size: 5</span></article>
    </main>`);
  assert.equal(targetScopedLawyerComFirmSize(html),1,"must prefer target firm's own summary over related-card size");
}

{
  const html=wrap(`
    <main>
      <h1>Target Firm</h1>
      <p>Serving clients in Springfield.</p>
      <h2>Similar Law Firms</h2>
      <article><span>Firm Size: 4</span></article>
    </main>`);
  assert.equal(targetScopedLawyerComFirmSize(html),0,"must not borrow firm size from similar/nearby modules");
}

{
  const html=wrap(`
    <main>
      <h1>Target Firm</h1>
      <dl><dt>Firm Size</dt><dd>3</dd></dl>
      <h2>Reviews</h2><p>Review text</p>
    </main>`);
  assert.equal(targetScopedLawyerComFirmSize(html),3,"must accept explicit target firm size in primary content");
}

{
  const html=wrap(`
    <main>
      <h1>Target Firm</h1>
      <p>At this office location, there are 3 lawyers.</p>
      <h2>Nearby Lawyers</h2>
      <p>At this office location, there are 8 lawyers.</p>
    </main>`);
  assert.equal(targetScopedLawyerComFirmSize(html),3,"must accept office-location count before nearby modules");
}

{
  const html=wrap(`
    <main>
      <h1>Target Firm</h1>
      <h2>Lawyers</h2><a href="/lawyer/target-one">Target One</a>
      <h2>Nearby Lawyers</h2><a href="/lawyer/unrelated-one">Unrelated One</a><a href="/lawyer/unrelated-two">Unrelated Two</a>
    </main>`);
  const scoped=targetScopedLawyerComHtml(html);
  assert.match(scoped,/Target One/);
  assert.doesNotMatch(scoped,/Unrelated One/,"related attorney roster must be outside target scope");
}

console.log("lawyer.com firm-size scope tests passed");
