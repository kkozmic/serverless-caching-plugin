'use strict';

const _ = require('lodash');
const paramRegex = /^{(.+)}$/

class AWSCachingPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');

    this.hooks = {
      'after:deploy:compileEvents': this.configureCaching.bind(this)
    };
  }

configureCaching() {
    this.serverless.cli.log('Configuring API Gatway caching…');

    const res = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    for(var name in res) {
      const r = res[name];
      if(r.Type === "AWS::ApiGateway::Method") {
        const parameters = this.getResourcePath(res, r.Properties.ResourceId);
        parameters.forEach(p => {
          r.Properties.RequestParameters[p] = true;
        });
      }
    }
  }

  getResourcePath(resources, resourceId) {
    var parameters = [];
    const res = resources[resourceId.Ref];
    this.addParameter(parameters, res, resources);
    return parameters;
  }

  addParameter(parameters, res, resources) {
    const result = paramRegex.exec(res.Properties.PathPart);

    if(result && result.length) {
      parameters.push("method.request.path." + result[1]);
    }
    if(res.Properties.ParentId && res.Properties.ParentId.Ref) {
      this.addParameter(parameters, resources[res.Properties.ParentId.Ref], resources);
    }
  }
}

module.exports = AWSCachingPlugin;
