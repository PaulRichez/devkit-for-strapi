'use strict';

module.exports = (policyContext, config, { strapi }) => {
  return Boolean(policyContext.state.user);
};
