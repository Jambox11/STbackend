import { ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';

describe('CacheService.invalidateNamespace', () => {
  let redis: {
    scan: jest.Mock;
    del: jest.Mock;
  };
  let config: { get: jest.Mock };
  let service: CacheService;

  beforeEach(() => {
    redis = {
      scan: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };
    config = {
      get: jest.fn().mockReturnValue(undefined),
    };
    service = new CacheService(redis as any, config as unknown as ConfigService);
    (service as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  });

  it('fully invalidates a namespace under the cap', async () => {
    redis.scan
      .mockResolvedValueOnce(['1', ['cache:ns:a', 'cache:ns:b']])
      .mockResolvedValueOnce(['0', ['cache:ns:c']]);

    await service.invalidateNamespace('ns');

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenNthCalledWith(1, 'cache:ns:a', 'cache:ns:b');
    expect(redis.del).toHaveBeenNthCalledWith(2, 'cache:ns:c');
    expect((service as any).logger.warn).not.toHaveBeenCalled();
  });

  it('stops early and warns when the max-keys cap is reached', async () => {
    redis.scan
      .mockResolvedValueOnce(['1', ['cache:ns:a', 'cache:ns:b']])
      .mockResolvedValueOnce(['2', ['cache:ns:c', 'cache:ns:d']])
      .mockResolvedValueOnce(['0', ['cache:ns:e']]);

    await service.invalidateNamespace('ns', { maxKeys: 3 });

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect((service as any).logger.warn).toHaveBeenCalledTimes(1);
    const warnMessage = (service as any).logger.warn.mock.calls[0][0];
    expect(warnMessage).toContain('ns');
    expect(warnMessage).toContain('4');
  });

  it('logs a warning with the deleted count when Redis errors during SCAN', async () => {
    redis.scan.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.invalidateNamespace('ns')).rejects.toThrow('redis down');

    expect((service as any).logger.warn).toHaveBeenCalledTimes(1);
    const warnMessage = (service as any).logger.warn.mock.calls[0][0];
    expect(warnMessage).toContain('ns');
    expect(warnMessage).toContain('0');
  });
});
