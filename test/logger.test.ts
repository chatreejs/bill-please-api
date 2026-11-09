import { beforeEach, describe, expect, it } from 'bun:test';

import { configureLogger, getLogger, logContext, parseLogLevel } from '../src/logger.ts';

let logs: string[] = [];
const records = () => logs.map((line) => JSON.parse(line));
beforeEach(() => {
  logs = [];
  configureLogger({ level: 'INFO', write: (line) => logs.push(line) });
});

describe('logger', () => {
  it('writes one JSON object per line with object arguments as fields', () => {
    getLogger('test.logger').info('hello', { a: 1 }, 'extra');
    expect(logs[0]).not.toContain('\n');
    const [record] = records();
    expect(record).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      level: 'info',
      service: 'bill-please-api',
      logger: 'test.logger',
      msg: 'hello',
      a: 1,
      args: ['extra'],
    });
  });

  it('filters by level', () => {
    const log = getLogger('test');
    log.debug('hidden');
    log.warn('shown');
    expect(records().map((r) => r.level)).toEqual(['warn']);

    configureLogger({ level: 'OFF' });
    log.error('also hidden');
    expect(logs).toHaveLength(1);
  });

  it('adds the request id from the log context', () => {
    logContext.run({ requestId: 'abcd1234', startedAt: 0 }, () => getLogger('test').info('in request'));
    getLogger('test').info('outside');
    const [inside, outside] = records();
    expect(inside.requestId).toBe('abcd1234');
    expect(outside).not.toHaveProperty('requestId');
  });

  it('serializes errors with message, stack and cause', () => {
    const error = new Error('outer', { cause: new TypeError('inner') });
    getLogger('test').error('failed', error);
    const [record] = records();
    expect(record.msg).toBe('failed');
    expect(record.error).toMatchObject({ type: 'Error', message: 'outer', cause: { type: 'TypeError', message: 'inner' } });
    expect(record.error.stack).toContain('at ');
  });

  it('keeps the record when a field cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    getLogger('test').info('circular', { circular });
    expect(records()[0].msg).toBe('circular');
  });

  it('parses LOG_LEVEL case-insensitively with a fallback', () => {
    expect(parseLogLevel('debug')).toBe('DEBUG');
    expect(parseLogLevel(' Warn ')).toBe('WARN');
    expect(parseLogLevel('verbose')).toBe('INFO');
    expect(parseLogLevel(undefined, 'ERROR')).toBe('ERROR');
  });
});
