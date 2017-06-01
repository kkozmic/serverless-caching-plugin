"use strict";

const BbPromise = require("bluebird");
const _ = require("lodash");

const paramRegex = /^{(.+)}$/;

const DEFAULT_USAGE_PLAN = "General Usage Plan";

class OpinionatedServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider("aws");
    this.hooks = {
      "after:package:compileEvents": this.postCompileEvents.bind(this),
      "after:deploy:deploy": () => BbPromise.bind(this)
        .then(this.ensureAPIKeys)
    };
  }

  postCompileEvents() {
    const resourceLookup = this.createResourceToMethodLookup();
    this.configureCaching(resourceLookup);
    this.markMethodsApiKeyRequired();
  }

  ensureAPIKeys() {
    if (this.options.noDeploy) {
      return BbPromise.resolve();
    }

    const api = this.getApiGatewayRestApi();
    if (!api) {
      //it's a worker, nothing for me to do
      return BbPromise.resolve();
    }

    const stageName = this.options.stage;
    const usagePlanName = this.getUsagePlanName();

    return BbPromise.bind(this)
      .then(() => this.getApiId(api.Name))
      .then((apiId) => this.getUsagePlanId(apiId, stageName, usagePlanName))
      .then((ids) => this.setApiKey(ids, stageName, usagePlanName));
  }

  markMethodsApiKeyRequired() {
    this.forEachMethod((r, name) => {
      if (r.Properties.hasOwnProperty("ApiKeyRequired")) {
        // setting private: false in yml will not make this property appear with value of false
        // if we want to provide opt out, we need to inspect the yml model as well
        this.serverless.cli.log(`Method ${name} is explicitly marked as requiring API key.`);
      } else {
        r.Properties.ApiKeyRequired = true;
      }
    });
  }

  configureCaching(slsEvents) {
    const cfnResources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    this.forEachMethod((cfnMethod, name) => {
      const parameters = this.getCacheParameters(cfnResources, cfnMethod, slsEvents[name]);
      if (parameters.allNames.length) {
        _.forEach(parameters.path, (value, name) => {
          cfnMethod.Properties.RequestParameters[name] = value;
        });

        _.forEach(parameters.queryString, (value, name) => {
          cfnMethod.Properties.RequestParameters[name] = value;
        });
        cfnMethod.Properties.Integration.CacheKeyParameters = parameters.allNames;
        cfnMethod.Properties.Integration.CacheNamespace = cfnMethod.Properties.ResourceId;
      }
    });
  }

  getCacheParameters(cfnResources, cfnMethod, slsEvent) {
    const pathParameters = {};
    const qsParameters = {};
    const request = Object.keys(cfnMethod.Properties.RequestParameters);

    if (cfnMethod.Properties.ResourceId.Ref) {
      const cfnResource = cfnResources[cfnMethod.Properties.ResourceId.Ref];
      this.addPathParameter(pathParameters, cfnResource, cfnResources);
      this.addQueryStringParameters(qsParameters, slsEvent);
      return {
        request: request,
        path: pathParameters,
        queryString: qsParameters,
        allNames: request.concat(_.keys(pathParameters)).concat(_.keys(qsParameters))
      };
    }
    // if it's not a reference, it will be the root resource which doesn't have parameters
    return {
      request: request,
      path: pathParameters,
      queryString: qsParameters,
      allNames: []
    };
  }

  addQueryStringParameters(parameters, slsEvent) {
    _.forEach(slsEvent.http.querystring, (value, name) => {
      parameters[`method.request.querystring.${name}`] = value;
    });
  }

  addPathParameter(parameters, cfnResource, cfnResources) {
    const result = paramRegex.exec(cfnResource.Properties.PathPart);

    if (result && result.length) {
      // path parameters are always mandatory
      parameters[`method.request.path.${result[1]}`] = true;
    }
    if (cfnResource.Properties.ParentId && cfnResource.Properties.ParentId.Ref) {
      this.addPathParameter(parameters, cfnResources[cfnResource.Properties.ParentId.Ref], cfnResources);
    }
  }

  forEachMethod(callback) {
    const res = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    for (let name in res) {
      const r = res[name];
      if (r.Type === "AWS::ApiGateway::Method") {
        callback(r, name);
      }
    }
  }

  getApiGatewayRestApi() {
    const res = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    for (let name in res) {
      const r = res[name];
      if (r.Type === "AWS::ApiGateway::RestApi") {
        return {
          name: name,
          properties: r.Properties
        };
      }
    }
    return null;
  }

  getUsagePlanName() {
    return _.get(this.serverless, "service.custom.usagePlan") || DEFAULT_USAGE_PLAN;
  }

  getUsagePlanId(apiId, stage, usagePlanName) {
    return this.provider.request("APIGateway",
      "getUsagePlans",
      {},
      this.options.stage,
      this.options.region)

      .then((result) => {
        if (result && result.items) {
          let plan = result.items.find((i) => i.name === usagePlanName);
          if (plan) {
            if (!plan.apiStages.some((i) => i.apiId === apiId && i.stage === stage)) {
              return {
                apiId: apiId,
                planId: plan.id
              };
            }

            this.serverless.cli.log(`API already added to usage plan ${usagePlanName}`);

          } else {
            const plans = result.items.map((i) => i.name).join(", ");
            this.serverless.cli.log(`Usage plan '${usagePlanName}' not found. The following plans exist: ${plans}`);
          }
        }

      })
      .catch((e) => {

        this.serverless.cli.log(`Error: ${e}`);
        return null;
      });

  }

  getApiId(apiName) {
    const stackName = this.provider.naming.getStackName(this.options.stage);
    return this.provider.request("CloudFormation",
      "describeStackResources",
      {
        StackName: stackName,
        LogicalResourceId: "ApiGatewayRestApi"
      },
      this.options.stage,
      this.options.region)

      .then((result) => {

        if (result && result.StackResources) {
          let outputs = result.StackResources[0];

          return outputs.PhysicalResourceId;
        }
      })
      .catch((e) => {

        this.serverless.cli.log(`Error: ${e}`);
        return null;
      });

  }

  setApiKey(ids, stageName, usagePlanName) {
    if (!ids) {
      this.serverless.cli.log("No ids");
      return;
    }
    this.serverless.cli.log(`Adding API to ${usagePlanName}`);
    return this.provider.request("APIGateway",
      "updateUsagePlan",
      {
        usagePlanId: ids.planId,
        patchOperations: [
          {
            from: "STRING_VALUE",
            op: "add",
            path: "/apiStages",
            value: `${ids.apiId}:${stageName}`
          }
        ]
      },
      this.options.stage,
      this.options.region)
      .then((result) => {
        this.serverless.cli.log(`Successsfully added API to ${usagePlanName}`);
      })
      .catch((e) => {

        this.serverless.cli.log(`Error: ${e}`);
        return null;
      });
  }

  createResourceToMethodLookup() {
    let map = {};
    _.forEach(this.serverless.service.functions, (f) => {
      _.forEach(f.events, e => {
        if (e.http) {

          // NOTE: is there a simpler way?
          const resourceLogicalId = this.provider.naming.getResourceLogicalId(e.http.path);
          const resourceId = this.provider.naming.extractResourceId(resourceLogicalId);
          const methodLogicalId = this.provider.naming.getMethodLogicalId(resourceId, e.http.method);

          map[methodLogicalId] = e;
        }
      });
    });

    return map;
  }
}

module.exports = OpinionatedServerlessPlugin;
