import assert from 'node:assert/strict';
import { discover, getRepository } from '../src/server/github.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';

// 只读取公开来源，不加载 .env、不调用 AI、不写入用户数据库。
const entries = await discover(fetch);
assert.ok(entries.length > 0, '本次真实榜单没有候选，无法执行发现烟测');
const store = new Store(':memory:');
try {
  const samples = entries.slice(0, 3);
  for (const entry of samples) {
    const { seed, evidence } = await getRepository(fetch, entry);
    store.upsertProject(seed);
    store.upsertProject(seed);
    store.addEvidence(evidence);
    assert.equal(store.project(seed.id)?.fullName, seed.fullName);
    assert.equal(store.detail(seed.id)?.evidence.length, 1);
  }
  assert.equal(store.projects().length, samples.length, '重复采集不应重复建立项目');
  const { app } = createApp({ config: loadConfig({}), store });
  try {
    const api = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(api.statusCode, 200);
    assert.equal(api.json().projects.length, samples.length);
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200, '请先 npm run build 生成工作台页面');
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    // 顺带核验素材相关新接口在未配置密钥时可用且不泄露凭据。
    const settings = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(settings.statusCode, 200);
    assert.ok('images' in settings.json() && 'capabilities' in settings.json(), '设置接口须分别返回配图配置与能力核验状态');
    assert.equal(settings.json().images.configured, false, '本烟测不加载 .env，配图应显示未配置');
    const sampleId = store.projects()[0]!.id;
    const materialReads = await Promise.all([
      app.inject({ method: 'GET', url: `/api/projects/${sampleId}/materials` }),
      app.inject({ method: 'GET', url: `/api/projects/${sampleId}/images` }),
      app.inject({ method: 'GET', url: '/api/references' }),
    ]);
    assert.deepEqual(materialReads.map(item => item.statusCode), [200, 200, 200], '素材、配图与参考图读取接口应可用');
    assert.deepEqual([...materialReads[1]!.json().images, ...materialReads[2]!.json().references], [], '内存库不应有历史素材');
  } finally {
    await app.close();
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    trendingCandidates: entries.length,
    checkedRepositories: store.projects().map(project => ({ name: project.fullName, stars: project.stars })),
    duplicateMerge: 'passed',
    localApiAndStaticPage: 'passed',
    materialApiReads: 'passed',
    aiCalled: false,
    database: 'memory',
  }, null, 2));
} finally {
  store.close();
}
