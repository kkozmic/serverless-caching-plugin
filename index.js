'use strict';

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
        const parameters = this.getCacheParameters(res, r);
        if(parameters.all.length) {
          parameters.path.forEach(p => {
            r.Properties.RequestParameters[p] = true;
          });
          r.Properties.Integration.CacheKeyParameters = parameters.all;
          r.Properties.Integration.CacheNamespace = r.Properties.ResourceId;
        }
      }
    }
  }

  getCacheParameters(resources, resource) {
    var request = Object.keys(resource.Properties.RequestParameters);
    var parameters = [];
    const res = resources[resource.Properties.ResourceId.Ref];
    this.addPathParameter(parameters, res, resources);
    return {
      request: request,
      path: parameters,
      all: request.concat(parameters)
    };
  }

  addPathParameter(parameters, res, resources) {
    const result = paramRegex.exec(res.Properties.PathPart);

    if(result && result.length) {
      parameters.push("method.request.path." + result[1]);
    }
    if(res.Properties.ParentId && res.Properties.ParentId.Ref) {
      this.addPathParameter(parameters, resources[res.Properties.ParentId.Ref], resources);
    }
  }
}

module.exports = AWSCachingPlugin;
