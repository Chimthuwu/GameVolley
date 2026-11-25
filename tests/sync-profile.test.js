// Sync profile shape, per-section conflict resolution and R2 offload: A4 of the sync workstream.
const assert = require('assert');
const profile = require('../src/shared/sync-profile.js');

(async () => {
  assert.deepStrictEqual(profile.SECTIONS, ['settings', 'presets', 'pairs', 'composer', 'theme', 'history']);
  const now = 1700000000000;

  const built = profile.buildProfile({ settings: { hue: 200 }, presets: ['a'], history: [] }, now);
  assert.strictEqual(built.version, 1, 'versioned profile');
  assert.strictEqual(built.sections.settings.updatedAt, now, 'raw state gets a timestamp');
  assert.deepStrictEqual(built.sections.presets.data, ['a'], 'raw data preserved');
  assert.ok(!built.sections.apiKey, 'arbitrary state keys are not blindly synced');

  const wrapped = { data: { hue: 1 }, updatedAt: 123 };
  assert.deepStrictEqual(profile.buildProfile({ settings: wrapped }, now).sections.settings, wrapped,
    'already-wrapped section keeps its timestamp');

  const left = profile.buildProfile({
    settings: { data: { hue: 1 }, updatedAt: 100 },
    presets: { data: ['local'], updatedAt: 100 },
    history: { data: ['local-run'], updatedAt: 100 },
  });
  const right = profile.buildProfile({
    settings: { data: { hue: 2 }, updatedAt: 200 },
    presets: { data: ['remote'], updatedAt: 50 },
    theme: { data: { dark: true }, updatedAt: 300 },
  });
  const merged = profile.mergeProfiles(left, right).sections;
  assert.strictEqual(merged.settings.data.hue, 2, 'newer remote section wins');
  assert.deepStrictEqual(merged.presets.data, ['local'], 'older remote section loses');
  assert.deepStrictEqual(merged.history.data, ['local-run'], 'local-only section survives');
  assert.strictEqual(merged.theme.data.dark, true, 'remote-only section survives');

  const tie = profile.mergeProfiles(
    { sections: { settings: { data: 'local', updatedAt: 5 } } },
    { sections: { settings: { data: 'remote', updatedAt: 5 } } }
  );
  assert.strictEqual(tie.sections.settings.data, 'local', 'tie keeps local');

  assert.ok(profile.profileSize({ a: 'x'.repeat(100) }) > 100, 'size counts JSON bytes');
  assert.strictEqual(profile.fitsInKv({ a: 'x' }), true, 'small profile fits KV');
  assert.strictEqual(profile.fitsInKv({ a: 'x'.repeat(profile.MAX_KV_BYTES) }), false, 'oversized profile detected');

  const arr = profile.buildProfile({ history: Array.from({ length: 5 }, (_, i) => ({ n: i })) }, now);
  profile.trimHistory(arr, 2);
  assert.deepStrictEqual(arr.sections.history.data, [{ n: 0 }, { n: 1 }], 'array history trimmed');
  const obj = profile.buildProfile({ history: { runs: [1, 2, 3], other: 7 } }, now);
  profile.trimHistory(obj, 1);
  assert.deepStrictEqual(obj.sections.history.data, { runs: [1], other: 7 }, 'object history trimmed, other keys kept');

  const big = profile.buildProfile({ history: [
    { body: 'x'.repeat(100), title: 'small' },
    { body: 'Y'.repeat(5000), title: 'big' },
  ] }, now);
  const { profile: slim, blobs } = profile.extractLargeBodies(big, 'blob/abc', 1000);
  assert.strictEqual(blobs.length, 1, 'only oversized body offloaded');
  assert.match(blobs[0].key, /^blob\/abc\/0\.txt$/, 'R2 key is deterministic and namespaced');
  assert.strictEqual(typeof slim.sections.history.data[0].body, 'string', 'small body untouched');
  assert.strictEqual(slim.sections.history.data[1].body, undefined, 'large body removed from profile');
  assert.strictEqual(slim.sections.history.data[1][profile.POINTER].body, blobs[0].key, 'pointer left behind');
  assert.ok(profile.fitsInKv(slim), 'slim profile fits KV');

  await profile.restoreLargeBodies(slim, (key) => blobs.find((b) => b.key === key).body);
  assert.strictEqual(slim.sections.history.data[1].body.length, 5000, 'body restored from R2');
  assert.strictEqual(slim.sections.history.data[1][profile.POINTER], undefined, 'pointer consumed');

  console.log('sync-profile.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });
