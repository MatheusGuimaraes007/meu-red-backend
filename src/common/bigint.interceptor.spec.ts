import { of, lastValueFrom } from 'rxjs';
import { BigIntInterceptor } from './bigint.interceptor';

describe('BigIntInterceptor', () => {
  it('serializes nested BigInt values returned by Prisma', async () => {
    const interceptor = new BigIntInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept({} as never, { handle: () => of({ id: 42n, nested: [1n] }) }),
    );
    expect(result).toEqual({ id: '42', nested: ['1'] });
  });
});
