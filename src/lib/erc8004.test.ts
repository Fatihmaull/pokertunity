import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttestation,
  buildRegistration,
  canonicalise,
  confidenceIn,
  publishPlan,
  REPUTATION_DECIMALS,
} from './erc8004';
import { DEFAULT_RATING, conservative, updateRatings, type Rating } from './rating';

/** A rating with the doubt closed to a given width, however it got there. */
function settled(mu: number, sigma: number): Rating {
  return { mu, sigma };
}

/** What a rating actually looks like after this many six-handed matches. */
function after(matches: number): Rating {
  let rating = { ...DEFAULT_RATING };
  for (let i = 0; i < matches; i++) {
    const field = Array.from({ length: 5 }, () => ({ ...DEFAULT_RATING }));
    rating = updateRatings([
      { entrant: 'hero', rating, place: 1 + (i % 6) },
      ...field.map((other, index) => ({ entrant: `f${index}`, rating: other, place: index < i % 6 ? index + 1 : index + 2 })),
    ])[0].rating;
  }
  return rating;
}

test('an agent nobody has watched is worth nothing on chain', () => {
  assert.equal(confidenceIn(DEFAULT_RATING), 0);
  assert.equal(confidenceIn(settled(40, DEFAULT_RATING.sigma * 2)), 0, 'wider than a newcomer is still nothing');
});

test('confidence climbs as the doubt closes, and only then', () => {
  const thin = confidenceIn(after(3));
  const thick = confidenceIn(after(40));

  assert.ok(thin > 0 && thin < 50, `three matches scored ${thin}`);
  assert.ok(thick > thin, 'more matches is more confidence');
  assert.ok(thick >= 70, `forty matches scored ${thick}`);

  // The registry is being told how sure we are, not how much we liked the
  // result. A confidently terrible agent scores high here, and should.
  assert.equal(confidenceIn(settled(45, 2)), confidenceIn(settled(5, 2)));
});

test('the arena never claims to be certain about an agent', () => {
  // Drift keeps a floor under the doubt on purpose: an owner can rewrite an
  // agent between matches, so a rating that had collapsed to certainty would be
  // making a claim about a thing that no longer exists. The published
  // confidence plateaus rather than reaching a hundred, and that is honest.
  const seasoned = confidenceIn(after(80));
  const veteran = confidenceIn(after(400));

  assert.ok(veteran >= seasoned, 'it still climbs, or at worst holds');
  assert.ok(veteran < 95, `four hundred matches scored ${veteran}, which is short of certainty`);
});

test('confidence stays inside the range the standard allows', () => {
  for (const sigma of [8.4, 8, 5, 2, 1, 0.5, 0.0001]) {
    const score = confidenceIn(settled(25, sigma));
    assert.ok(Number.isInteger(score), `sigma=${sigma} produced ${score}`);
    assert.ok(score >= 0 && score <= 100, `sigma=${sigma} produced ${score}`);
  }
});

const RECORD = {
  agentId: 'a-1',
  name: 'Viridian',
  rating: settled(28.4, 1.8),
  matches: 42,
  wins: 9,
  hands: 3_100,
  winRateBb100: 4.25,
  earnings: 1_000,
  measuredAt: new Date('2026-01-01T00:00:00.000Z'),
};

test('the same record hashes to the same bytes whatever order it was built in', () => {
  const once = canonicalise(buildAttestation(RECORD));
  const again = canonicalise(buildAttestation({ ...RECORD }));

  assert.equal(once, again);
  assert.match(once, /^\{"agentId":/, 'keys are sorted, so agentId leads');
  assert.ok(!once.includes('\n'), 'no incidental whitespace to disagree about');
});

test('changing any published figure changes the hash input', () => {
  const original = canonicalise(buildAttestation(RECORD));

  assert.notEqual(original, canonicalise(buildAttestation({ ...RECORD, earnings: 1_001 })));
  assert.notEqual(original, canonicalise(buildAttestation({ ...RECORD, matches: 43 })));
  assert.notEqual(original, canonicalise(buildAttestation({ ...RECORD, rating: settled(28.5, 1.8) })));
  assert.notEqual(original, canonicalise(buildAttestation({ ...RECORD, rating: settled(28.4, 1.9) })));
  assert.notEqual(original, canonicalise(buildAttestation({ ...RECORD, name: 'Viridian ' })));
});

test('the attestation carries what it took to earn the record, not just the score', () => {
  const attestation = buildAttestation(RECORD);

  assert.equal(attestation.matches, 42);
  assert.equal(attestation.hands, 3_100);
  assert.equal(attestation.rating, Math.round(conservative(RECORD.rating) * 100) / 100);
  assert.equal(attestation.confidence, confidenceIn(RECORD.rating));
  assert.ok(attestation.method.includes('arena, not by the agent'), 'the method says who chose the opponents');
  assert.ok(attestation.method.includes('entry fee'), 'and that a seat costs something');
});

const ATTESTOR = '0x00000000000000000000000000000000000a77e5' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;

function planFor(validation: boolean, rating: Rating = settled(30, 2)) {
  return publishPlan({
    registryId: 7n,
    attestor: ATTESTOR,
    uri: 'https://arena.test/api/attestations/x',
    evidenceHash: HASH,
    attestation: buildAttestation({
      agentId: 'a',
      name: 'Ace',
      rating,
      matches: 40,
      wins: 9,
      hands: 1200,
      winRateBb100: 4.2,
      earnings: 900,
      measuredAt: new Date(0),
    }),
    validation,
  });
}

/** The value `giveFeedback` is sent for a rating, read off the plan that publishes it. */
function feedbackValue(rating: Rating): bigint {
  const feedback = planFor(false, rating).find((write) => write.functionName === 'giveFeedback')!;
  return feedback.args[1] as bigint;
}

test('feedback is never signed by the key that owns the identity', () => {
  // The deployed Reputation Registry reverts feedback from an owner or operator,
  // and the registrar is the owner of every identity it mints.
  for (const validation of [true, false]) {
    const feedback = planFor(validation).filter((write) => write.functionName === 'giveFeedback');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].signer, 'attestor');
  }
});

test('validation is requested by the owner, naming the attestor, who answers it', () => {
  const plan = planFor(true);
  assert.deepEqual(
    plan.map((write) => [write.functionName, write.signer]),
    [
      ['validationRequest', 'registrar'],
      ['validationResponse', 'attestor'],
      ['giveFeedback', 'attestor'],
    ],
    'the question goes up before the score that answers it',
  );
  assert.equal(plan[0].args[0], ATTESTOR, 'the validator named is the account that responds');
});

test('a chain with no Validation Registry gets the reputation alone', () => {
  const plan = planFor(false);
  assert.deepEqual(
    plan.map((write) => write.registry),
    ['reputation'],
  );
});

test('the feedback value is the published rating at the published precision', () => {
  const [feedback] = planFor(false);
  assert.equal(feedback.args[1], BigInt(Math.round(conservative(settled(30, 2)) * 10 ** REPUTATION_DECIMALS)));
  assert.equal(feedback.args[2], REPUTATION_DECIMALS);
  assert.equal(feedback.args[7], HASH);
});

test('an agent that keeps finishing last posts a negative value', () => {
  // The registry takes a signed value for exactly this reason. An agent rated
  // below where it started has to be able to say so.
  const poor = settled(6, 3);
  assert.ok(conservative(poor) < 0);
  assert.equal(feedbackValue(poor), BigInt(Math.round(conservative(poor) * 100)));
  assert.ok(feedbackValue(poor) < 0n);
  assert.equal(REPUTATION_DECIMALS, 2);
});

test('the value on chain is the published rating, not the raw estimate', () => {
  // Publishing mu would let an agent with three lucky matches outrank one with
  // three hundred honest ones, which is the whole thing this guards against.
  const lucky = settled(40, 8);
  const proven = settled(30, 1);

  assert.ok(feedbackValue(proven) > feedbackValue(lucky), 'evidence beats a hot streak');
});

test('one registration file names the agent on every chain it was minted on', () => {
  const registration = buildRegistration({
    agentId: 'a',
    name: 'Ace',
    baseUrl: 'https://arena.test',
    identities: [
      { chainId: 10143, registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', registryId: '31' },
      { chainId: 97, registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', registryId: '12' },
    ],
  });

  assert.equal(registration.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.deepEqual(registration.registrations, [
    { agentId: 12, agentRegistry: 'eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e' },
    { agentId: 31, agentRegistry: 'eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e' },
  ]);
  assert.ok(registration.services.every((service) => service.endpoint.startsWith('https://arena.test/')));
});

test('an agent not yet minted anywhere still has a file, listing nothing', () => {
  const registration = buildRegistration({ agentId: 'a', name: 'Ace', baseUrl: 'https://arena.test', identities: [] });
  assert.deepEqual(registration.registrations, []);
});
