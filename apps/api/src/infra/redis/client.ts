import { Redis } from 'ioredis';

export function makeRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
}
