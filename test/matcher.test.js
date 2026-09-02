import test from 'node:test';
import assert from 'node:assert/strict';
import { createRule, interceptionPatterns, isCandidate, isDynamicsUrl, matchesRule, normalizeResource } from '../shared/matcher.js';

test('detects Dynamics URLs and safe PCF candidates', () => {
  assert.equal(isDynamicsUrl('https://x.crm4.dynamics.com/main.aspx'), true);
  assert.equal(isDynamicsUrl('https://evil.test'), false);
  assert.equal(isCandidate('https://x.crm4.dynamics.com/a/webresources/C/bundle.js', 'x.crm4.dynamics.com'), true);
});

test('PCF matcher survives resource rotation', () => {
  const first = 'https://x.crm.dynamics.com/%7bABC%7d/webresources/cc_Control/bundle.js';
  const second = 'https://x.crm.dynamics.com/%7bXYZ%7d/webresources/cc_Control/bundle.js';
  assert.equal(normalizeResource(first), normalizeResource(second));
  assert.equal(matchesRule(createRule(first), second), true);
});

test('matches only selected Model-Driven JavaScript resource', () => {
  const selected = 'https://x.crm.dynamics.com/webresources/cc_/scripts/account-form.js?v=1';
  assert.equal(isCandidate(selected, 'x.crm.dynamics.com', 'script'), true);
  const rule = createRule(selected, 'script');
  assert.equal(matchesRule(rule, 'https://x.crm.dynamics.com/webresources/cc_/scripts/account-form.js?v=2'), true);
  assert.equal(matchesRule(rule, 'https://x.crm.dynamics.com/webresources/cc_/scripts/contact-form.js'), false);
});

test('limits CDP interception to PCF bundle requests', () => {
  const rule = createRule('https://x.crm.dynamics.com/%7bABC%7d/webresources/cc_Control/bundle.js');
  assert.deepEqual(interceptionPatterns(rule), [
    { urlPattern: 'https://x.crm.dynamics.com/*bundle.js*', requestStage: 'Request' },
    { urlPattern: 'https://x.crm.dynamics.com/*bundle.min.js*', requestStage: 'Request' }
  ]);
});
