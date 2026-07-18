export default () => {
  return async (ctx: unknown, next: () => Promise<void>) => {
    await next();
  };
};
