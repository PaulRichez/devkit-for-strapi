export default (policyContext: { state: { user?: unknown } }) => {
  return Boolean(policyContext.state.user);
};
