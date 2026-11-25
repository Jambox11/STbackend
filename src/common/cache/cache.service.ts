import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';

const DEFAULT_INVALIDATE_MAX_KEYS = 10_000;
const SCAN_BATCH_SIZE = 100;

export interface InvalidateNamespaceOptions {
  maxKeys?: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(
    private readonly cache: Cache,
    private readonly configService: ConfigService,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.cache.set(key, value, ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.cache.del(key);
  }

  private resolveMaxKeys(options?: InvalidateNamespaceOptions): number {
    if (options?.maxKeys !== undefined) {
      return options.maxKeys;
    }
    const configured = this.configService?.get<string | number>(
      'CACHE_INVALIDATE_MAX_KEYS',
    );
    const parsed = Number(configured);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_INVALIDATE_MAX_KEYS;
  }

  async invalidateNamespace(
    namespace: string,
    options?: InvalidateNamespaceOptions,
  ): Promise<number> {
    const maxKeys = this.resolveMaxKeys(options);
    const pattern = `${namespace}:*`;
    let deleted = 0;
    let cursor = '0';

    try {
      do {
        const [nextCursor, keys] = await this.cache.store.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          SCAN_BATCH_SIZE,
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          const remaining = maxKeys - deleted;
          const batch = keys.slice(0, remaining);
          if (batch.length > 0) {
            await this.cache.store.del(...batch);
            deleted += batch.length;
          }
        }

        if (deleted >= maxKeys) {
          this.logger.warn(
            `invalidateNamespace(${namespace}) reached maxKeys cap (${maxKeys}); deleted ${deleted} keys, namespace may be partially invalidated`,
          );
          break;
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(
        `invalidateNamespace(${namespace}) failed after deleting ${deleted} keys: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }

    return deleted;
  }
}
