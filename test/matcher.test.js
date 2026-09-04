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

test('regression: one PCF rule must NOT match a different control on the same form', () => {
  // Reproduces the reported failure: overriding CreditCardPCF broke
  // StoreFront with "Could not find/invoke StoreFrontComponent's
  // constructor" - because normalization blanked the control name, every PCF
  // bundle URL normalized identically and StoreFront was served CreditCard's
  // bundle. The control name is the resource's IDENTITY, not a volatile part.
  const creditCard = 'https://org.crm.dynamics.com/%7bAAA%7d/webresources/cc_CreditCard.CreditCardPCF/bundle.js';
  const storeFront = 'https://org.crm.dynamics.com/%7bBBB%7d/webresources/cc_StoreFront.StoreFrontComponent/bundle.js';
  const addParts  = 'https://org.crm.dynamics.com/%7bCCC%7d/webresources/cc_PartsManagement.AddPartsManagement/bundle.js';

  const rule = createRule(creditCard, 'pcf');

  assert.equal(matchesRule(rule, storeFront), false, 'must not intercept a different control');
  assert.equal(matchesRule(rule, addParts), false, 'must not intercept a different control');
  assert.equal(matchesRule(rule, creditCard), true, 'must still match its own resource');
});

test('regression: distinct PCF controls normalize to distinct strings', () => {
  const a = normalizeResource('https://org.crm.dynamics.com/%7bAAA%7d/webresources/cc_CreditCard.CreditCardPCF/bundle.js');
  const b = normalizeResource('https://org.crm.dynamics.com/%7bBBB%7d/webresources/cc_StoreFront.StoreFrontComponent/bundle.js');
  assert.notEqual(a, b, 'two different controls must never share a normalized form');
  assert.match(a, /creditcardpcf/, 'the control name must survive normalization');
});

test('regression: multiple simultaneous PCF rules each match only their own control', () => {
  const creditCard = 'https://org.crm.dynamics.com/%7bAAA%7d/webresources/cc_CreditCard.CreditCardPCF/bundle.js';
  const addParts  = 'https://org.crm.dynamics.com/%7bCCC%7d/webresources/cc_PartsManagement.AddPartsManagement/bundle.js';
  const rules = [createRule(creditCard, 'pcf'), createRule(addParts, 'pcf')];

  // Mirrors controller.onEvent's dispatch: find the FIRST matching rule.
  const matchFor = url => rules.findIndex(r => matchesRule(r, url));

  assert.equal(matchFor(creditCard), 0, 'CreditCard request must resolve to the CreditCard rule');
  assert.equal(matchFor(addParts), 1, 'AddParts request must resolve to the AddParts rule');
  assert.equal(
    matchFor('https://org.crm.dynamics.com/%7bDDD%7d/webresources/cc_Other.SomethingElse/bundle.js'),
    -1,
    'an unrelated control must match no rule at all and pass through untouched'
  );
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
