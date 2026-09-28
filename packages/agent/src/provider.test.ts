import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkingBudget } from './provider';

test('the thinking budget is read when asked, so an env file loaded after import still counts', () => {
  // `pnpm agent` reads agents/.env after its imports have run. A budget read
  // when this module loaded would never see a value set there.
  const before = process.env.GEMINI_THINKING_BUDGET;
  try {
    delete process.env.GEMINI_THINKING_BUDGET;
    assert.equal(thinkingBudget(), null);

    process.env.GEMINI_THINKING_BUDGET = '0';
    assert.equal(thinkingBudget(), 0, 'zero is a real setting: it turns thinking off');
  } finally {
    if (before === undefined) delete process.env.GEMINI_THINKING_BUDGET;
    else process.env.GEMINI_THINKING_BUDGET = before;
  }
});

test('a budget that is blank or not a count leaves the model to its default', () => {
  assert.equal(thinkingBudget(''), null, 'an empty line in an env file is not a request for zero');
  assert.equal(thinkingBudget('lots'), null);
  assert.equal(thinkingBudget('512'), 512);
});
