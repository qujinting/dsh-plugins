/** Unit tests for the answer parser, exercised against real captured gateway output. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanUrl, extractSources, parseSearchAnswer, splitAnswerAndSources } from '../src/parse.js';

const PERPLEXITY_ANSWER = [
	'## 济南 → 扬州 高铁票价',
	'',
	'| 席别 | 价格 |',
	'|---|---|',
	'| 二等座 | ¥284 - ¥345 |',
	'',
	'**来源：**',
	'- 携程济南—扬州高铁票价：https://trains.ctrip.com/trainbooking/jinan-yangzhou/gaotie/',
	'- 铁路12306官方：https://kyfw.12306.cn/otn/leftTicketPrice',
	'- 第三方链接带中文路径：https://train.hao86.com/济南-扬州东/。',
].join('\n');

test('splits a trailing bold sources heading off the prose', () => {
	const { answer, sourcesText, split } = splitAnswerAndSources(PERPLEXITY_ANSWER);
	assert.equal(split, true);
	assert.match(answer, /## 济南/);
	assert.doesNotMatch(answer, /ctrip/u);
	assert.match(sourcesText, /trains\.ctrip\.com/u);
});

test('parses bare prose URLs into sources and drops trailing CJK punctuation', () => {
	const result = parseSearchAnswer(PERPLEXITY_ANSWER, { maxSources: 10 });
	assert.deepEqual(result.sources.map((s) => s.url), [
		'https://trains.ctrip.com/trainbooking/jinan-yangzhou/gaotie/',
		'https://kyfw.12306.cn/otn/leftTicketPrice',
		'https://train.hao86.com/%E6%B5%8E%E5%8D%97-%E6%89%AC%E5%B7%9E%E4%B8%9C/',
	]);
	assert.ok(!result.content.includes('ctrip'), 'prose must not repeat the sources section');
});

test('prefers markdown link labels as titles', () => {
	const result = parseSearchAnswer(
		'答案在这里。\n\nSources:\n- [携程济南到扬州](https://trains.ctrip.com/trainbooking/jinan-yangzhou/gaotie/)\n- [12306](https://kyfw.12306.cn/otn/leftTicket/init)\n',
	);
	assert.deepEqual(result.sources, [
		{ url: 'https://trains.ctrip.com/trainbooking/jinan-yangzhou/gaotie/', title: '携程济南到扬州' },
		{ url: 'https://kyfw.12306.cn/otn/leftTicket/init', title: '12306' },
	]);
	assert.equal(result.content, '答案在这里。');
});

test('falls back to every URL in the message when the model ignores the shape', () => {
	const result = parseSearchAnswer('See https://example.com/a and https://example.com/b#x for details.');
	assert.equal(result.sources.length, 2);
	assert.equal(result.sources[0].title, 'example.com');
	assert.match(result.content, /See https:\/\/example\.com\/a/u);
});

test('deduplicates the same URL seen as a markdown link and as bare text', () => {
	const result = parseSearchAnswer('Sources:\n- [Report](https://example.com/report) and also https://example.com/report');
	assert.equal(result.sources.length, 1);
	assert.equal(result.sources[0].title, 'Report');
});

test('caps sources and ignores heading-like lines in the middle of an answer', () => {
	const text = ['来源：下面会给出', 'body text', 'Sources:', '- [a](https://a.example/1)', '- [b](https://b.example/2)'].join('\n');
	const { answer, split } = splitAnswerAndSources(text);
	assert.equal(split, true);
	assert.match(answer, /下面会给出/u);
	const result = parseSearchAnswer(text, { maxSources: 1 });
	assert.equal(result.sources.length, 1);
});

test('cleanUrl rejects non-http schemes and unparseable values', () => {
	assert.equal(cleanUrl('mailto:a@b.c'), undefined);
	assert.equal(cleanUrl('not a url'), undefined);
	assert.equal(cleanUrl('HTTPS://Example.com/x.'), 'https://example.com/x');
});

test('extractSources returns nothing for empty input', () => {
	assert.deepEqual(extractSources(''), []);
	assert.deepEqual(extractSources(undefined), []);
	assert.deepEqual(extractSources('没有链接'), []);
});
